import type { MiddlewareHandler } from "astro";
import { apiProblem, apiRateLimited } from "./lib/api-response";
import {
  getHassUserId,
  hasHassioToken,
  isHassAdmin,
  resolveIngressContext,
} from "@domains/auth/ingress";
import { buildSecurityHeaders, isCsrfAllowed } from "@domains/auth/ingress-policy";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { getPersistenceClient, ensureSchema } from "@domains/tasks/persistence/store";
import { initHAIntegrations } from "@domains/ha";
import type { DateFormat } from "./lib/date";
import { idempotencyCache, type CachedResponse } from "./lib/idempotency-cache";
import { resolveAgentAuth, resolveRouteScope, requireScope, type ResolvedAgent } from "./lib/agent-token-guard";
import { isNativeBackupHook } from "./lib/backup-hook-policy"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
});


// ── Known automation source identifiers (validated against for log safety) ──
const KNOWN_AUTOMATION_SOURCES = new Set(["browser", "n8n", "nodered", "mcp", "agent", "a2a", "ha", "api", "webhook", "cron"])

// ── W3C Traceparent Parsing (OTel-compatible, zero-dep) ──
// Format: {version}-{trace-id}-{parent-id}-{trace-flags}
// Example: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/

function parseTraceparent(header: string | null): { traceId: string, spanId: string, traceFlags: string } {
  if (header) {
    const match = header.trim().match(TRACEPARENT_RE)
    if (match) {
      return { traceId: match[2]!, spanId: match[3]!, traceFlags: match[4]! }
    }
  }
  // Generate new trace context when no valid traceparent header.
  // crypto.randomUUID() is faster than Uint8Array + hex conversion.
  const uuid1 = crypto.randomUUID().replace(/-/g, "") // 32 hex → traceId
  const uuid2 = crypto.randomUUID().replace(/-/g, "") // 32 hex → take first 16 for spanId
  return {
    traceId: uuid1,
    spanId: uuid2.slice(0, 16),
    traceFlags: "01", // sampled by default
  }
}

// ── In-memory rate limiter (R-107) ──
// Capped at MAX_ENTRIES to prevent OOM under DDoS. Oldest entries evicted
// when the cap is reached via FIFO iteration order of Map.
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 300; // requests per window
const RATE_WINDOW_MS = 60_000; // 1 minute
const MAX_RATE_ENTRIES = 10_000; // memory cap (~800KB at peak)

function getRateLimit(ip: string): { remaining: number; resetAt: number; exceeded: boolean } {
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    // Evict oldest entries if we've hit the cap (FIFO via Map insertion order)
    if (rateLimitMap.size >= MAX_RATE_ENTRIES) {
      const firstKey = rateLimitMap.keys().next().value;
      if (firstKey !== undefined) rateLimitMap.delete(firstKey);
    }
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  const remaining = Math.max(0, RATE_LIMIT - entry.count);
  return { remaining, resetAt: entry.resetAt, exceeded: entry.count > RATE_LIMIT };
}

// Periodic cleanup (every 5 min). unref() so the timer doesn't
// prevent the Node process from exiting on shutdown.
const _rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000);
if (typeof _rateLimitCleanup?.unref === "function") _rateLimitCleanup.unref();

// ── Bot-specific rate limiter (PRA-08) ──
// Stricter 60/min limit for bot mutation endpoints to prevent runaway agents
// from overwhelming the DB with proposals/claims.
const botRateLimitMap = new Map<string, { count: number; resetAt: number }>();
const BOT_RATE_LIMIT = 60;
const BOT_RATE_WINDOW_MS = 60_000;
const BOT_PATH_PATTERNS = ["/accept-proposal", "/handoff", "/api/mcp"];

function isBotEndpoint(pathname: string): boolean {
  // Use segment-boundary matching to avoid false positives
  // e.g. /api/mcp should not match /api/mcp-unrelated
  return BOT_PATH_PATTERNS.some(p => {
    const idx = pathname.indexOf(p)
    if (idx === -1) return false
    const afterIdx = idx + p.length
    // Must be at end of path or followed by / or ?
    return afterIdx >= pathname.length || pathname[afterIdx] === "/" || pathname[afterIdx] === "?"
  })
}

function getBotRateLimit(ip: string): { remaining: number; resetAt: number; exceeded: boolean } {
  const now = Date.now();
  let entry = botRateLimitMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    if (botRateLimitMap.size >= 1_000) {
      const firstKey = botRateLimitMap.keys().next().value;
      if (firstKey !== undefined) botRateLimitMap.delete(firstKey);
    }
    entry = { count: 0, resetAt: now + BOT_RATE_WINDOW_MS };
    botRateLimitMap.set(ip, entry);
  }
  entry.count++;
  const remaining = Math.max(0, BOT_RATE_LIMIT - entry.count);
  return { remaining, resetAt: entry.resetAt, exceeded: entry.count > BOT_RATE_LIMIT };
}

// ── Settings cache (avoids DB query on every request) ──
// TTL: 60s — settings change rarely, no need to hit SQLite every request.
let _settingsCache: { timezone: string; weekStart: string; dateFormat: string } | null = null;
let _settingsCacheExpiry = 0;
const SETTINGS_CACHE_TTL_MS = 60_000;

function applyRateLimitHeaders(response: Response, remaining: number, resetAt: number, limit: number = RATE_LIMIT, windowSec: number = RATE_WINDOW_MS / 1000): void {
  const resetSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
  // Legacy headers (backward compat — used by existing n8n/custom scripts)
  response.headers.set("x-ratelimit-limit", String(limit))
  response.headers.set("x-ratelimit-remaining", String(remaining))
  response.headers.set("x-ratelimit-reset", String(Math.ceil(resetAt / 1000)))
  // IETF standard headers (draft-ietf-httpapi-ratelimit-headers-10)
  response.headers.set("RateLimit", `limit=${limit}, remaining=${remaining}, reset=${resetSeconds}`)
  response.headers.set("RateLimit-Policy", `${limit};w=${windowSec}`)
}

/**
 * Rewrite absolute paths in HTML responses when behind HA ingress.
 * The ingress proxy maps /{ingressPath}/* → http://addon:port/*
 * but if the HTML contains absolute paths like href="/tasks" or src="/_astro/page.js",
 * the browser resolves them against the HA root, bypassing ingress → 404.
 *
 * This rewrites ALL href="/...", src="/...", and action="/..." attributes
 * to include the ingress path prefix.
 */
async function rewriteIngressPaths(response: Response, ingressPath: string): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";

  // NOTE: CSS url() paths are rewritten at BUILD TIME by the
  // fontsource-relative-paths Vite plugin in astro.config.mjs.
  // No runtime CSS rewriting needed.

  if (!contentType.includes("text/html")) return response;

  // Guard: skip rewriting excessively large responses (>5MB) to prevent OOM.
  // Normal pages are <500KB; anything larger is likely a data export or error.
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 5 * 1024 * 1024) return response;

  const html = await response.text();

  // Double-check size after reading (content-length may be absent/wrong)
  if (html.length > 5 * 1024 * 1024) {
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // Inject runtime ingress path for client-side JS (must come before any scripts)
  const ingressScript = `<script>window.__ingress_path="${ingressPath}";</script>`;

  // Rewrite absolute paths in HTML attributes: href="/...", src="/...", action="/..."
  // Matches: href="/path", src="/path", action="/path" (with double or single quotes)
  // Does NOT match: href="//cdn.example.com" (protocol-relative), href="http://..." (absolute URL)
  const rewritten = html
    .replace("<head>", `<head>${ingressScript}`)
    .replace(/((?:href|src|action)=["'])\/(?!\/)/g, `$1${ingressPath}/`);

  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const onRequest: MiddlewareHandler = async ({ request, locals }, next) => {
  // Lazy-init HA integrations on first request (entity subscription + todo sync auto-start).
  // Fire-and-forget: don't block request processing on HA connection.
  initHAIntegrations().catch(() => {});

  const startTime = Date.now();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
  const supervisorTokenPresent = Boolean(process.env.SUPERVISOR_TOKEN);
  const ingressContext = resolveIngressContext(request.headers, supervisorTokenPresent, request.url);
  const { ingressPath, behindIngress } = ingressContext;

  locals.ingressPath = ingressPath;
  locals.behindIngress = behindIngress;
  locals.hassioTokenPresent = hasHassioToken(request.headers);

  // Extract authenticated HA user identity from Supervisor ingress headers
  locals.hassUserId = getHassUserId(request.headers, !supervisorTokenPresent)
  locals.hassIsAdmin = isHassAdmin(request.headers, !supervisorTokenPresent)

  // ── Agent/Automation source identification ──
  // n8n, Node-RED, and AI agents should send these headers to identify themselves.
  // Validate against known sources to prevent log injection.
  const rawSource = request.headers.get("x-automation-source")?.toLowerCase().replace(/[^a-z0-9_-]/g, "") ?? "browser"
  const automationSource = KNOWN_AUTOMATION_SOURCES.has(rawSource) ? rawSource : "unknown"
  const agentId = (request.headers.get("x-agent-id") ?? "").slice(0, 128).replace(/[^\w.-]/g, "")
  locals.automationSource = automationSource
  locals.agentId = agentId

  // ── W3C Traceparent — distributed trace context ──
  const traceCtx = parseTraceparent(request.headers.get("traceparent"))
  locals.traceId = traceCtx.traceId
  locals.spanId = traceCtx.spanId
  locals.traceFlags = traceCtx.traceFlags

  // Suppress ingress.path.missing for healthcheck — it runs every 30s from
  // inside the container with SUPERVISOR_TOKEN but no x-ingress-path header.
  // Logging this would produce ~2,880 warnings/day, burying real issues.
  const url = new URL(request.url);
  if (behindIngress && !ingressPath && !url.pathname.startsWith("/api/health")) {
    logger.log("warn", {
      event: "ingress.path.missing",
      domain: "observability",
      component: "middleware",
      request_id: requestId,
      message: "Ingress mode active without x-ingress-path header; using supervisor-token context only.",
    });
  }

  // Load regional settings for SSR (cached for 60s to avoid DB per-request)
  locals.timezone = "Europe/Dublin";
  locals.weekStart = "monday";
  locals.dateFormat = "relative";
  const now = Date.now();
  if (_settingsCache && now < _settingsCacheExpiry) {
    locals.timezone = _settingsCache.timezone;
    locals.weekStart = _settingsCache.weekStart;
    locals.dateFormat = _settingsCache.dateFormat as DateFormat;
  } else {
    try {
      await ensureSchema();
      const db = getPersistenceClient();
      const res = await db.execute("SELECT key, value FROM settings WHERE key IN ('timezone', 'week_start', 'date_format')");
      for (const row of res.rows) {
        if (row.key === "timezone" && typeof row.value === "string") locals.timezone = row.value;
        if (row.key === "week_start" && typeof row.value === "string") locals.weekStart = row.value;
        if (row.key === "date_format" && typeof row.value === "string") locals.dateFormat = row.value as DateFormat;
      }
      _settingsCache = { timezone: locals.timezone, weekStart: locals.weekStart, dateFormat: locals.dateFormat };
      _settingsCacheExpiry = now + SETTINGS_CACHE_TTL_MS;
    } catch {
      /* ignore db errors, defaults used */
    }
  }

  // Rate limiting (API routes only)
  // Extract client IP — strip port numbers, normalize whitespace.
  // x-forwarded-for can contain multiple IPs; use the leftmost (client).
  // Note: behind HA Supervisor ingress, this is trusted.
  const rawIp = (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || request.headers.get("x-real-ip")
    || "127.0.0.1")
    .replace(/:\d+$/, "")   // strip port (e.g. "192.168.1.1:54321" → "192.168.1.1")
    .replace(/^\[|\]$/g, ""); // unwrap IPv6 brackets
  const ip = rawIp || "127.0.0.1";
  const rateInfo = getRateLimit(ip);

  if (rateInfo.exceeded && url.pathname.startsWith("/api/")) {
    const retryAfter = Math.ceil((rateInfo.resetAt - Date.now()) / 1000)
    return apiRateLimited(retryAfter, `Rate limit exceeded (${RATE_LIMIT}/min). Retry after ${retryAfter}s.`, {
      "x-ratelimit-limit": String(RATE_LIMIT),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.ceil(rateInfo.resetAt / 1000)),
      "RateLimit": `limit=${RATE_LIMIT}, remaining=0, reset=${retryAfter}`,
      "RateLimit-Policy": `${RATE_LIMIT};w=${RATE_WINDOW_MS / 1000}`,
    })
  }

  // Bot-specific rate limiting (PRA-08) — stricter 60/min for bot mutation endpoints
  if (url.pathname.startsWith("/api/") && isBotEndpoint(url.pathname)) {
    const botRate = getBotRateLimit(ip);
    if (botRate.exceeded) {
      logger.log("warn", {
        event: "http.bot_rate_limited",
        domain: "security",
        component: "middleware",
        request_id: requestId,
        message: `Bot rate limit exceeded: ${request.method} ${url.pathname} from ${ip}`,
      });
      const retryAfter = Math.ceil((botRate.resetAt - Date.now()) / 1000)
      return apiRateLimited(retryAfter, `Bot rate limit exceeded (${BOT_RATE_LIMIT}/min). Retry after ${retryAfter}s.`, {
        "x-ratelimit-limit": String(BOT_RATE_LIMIT),
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.ceil(botRate.resetAt / 1000)),
        "RateLimit": `limit=${BOT_RATE_LIMIT}, remaining=0, reset=${retryAfter}`,
        "RateLimit-Policy": `${BOT_RATE_LIMIT};w=${BOT_RATE_WINDOW_MS / 1000}`,
      })
    }
  }

  // ── Agent Token Authorization (zero-trust, opt-in) ──
  // Resolve Bearer token from Authorization header.
  // Explicit tokens retain their own permissions even inside HA ingress.
  let resolvedAgent: ResolvedAgent | null = null
  if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/health")) {
    try {
      resolvedAgent = await resolveAgentAuth(request)
    } catch (authError) {
      // resolveAgentAuth throws a Response for invalid/revoked/expired tokens
      if (authError instanceof Response) return authError
      // Credential verification errors must not turn an explicit token into anonymous access.
      logger.log("warn", {
        event: "http.agent_auth_error",
        domain: "security",
        component: "middleware",
        request_id: requestId,
        message: `Agent auth error: ${authError instanceof Error ? authError.message : "unknown"}`,
      })
      return apiProblem({ status: 503, detail: "Agent authentication is temporarily unavailable." })
    }

    // Scope enforcement — check route-level permissions for agent tokens
    const requiredScope = resolveRouteScope(url.pathname, request.method)
    if (resolvedAgent) {
      if (!requiredScope) return apiProblem({ status: 403, detail: "This operation is not available to agent tokens." })
      const scopeError = requireScope(resolvedAgent, requiredScope)
      if (scopeError) return scopeError
    } else if (requiredScope === "settings:write" &&
      (supervisorTokenPresent || locals.hassUserId) && !locals.hassIsAdmin && !isNativeBackupHook(request)) {
      return apiProblem({ status: 403, detail: "A Home Assistant administrator must change household settings." })
    }
  }

  // Attach agent info to locals for downstream route access
  locals.agentToken = resolvedAgent ?? undefined
  if (resolvedAgent) locals.hassIsAdmin = false // Explicit token authority never inherits browser-admin headers.

  // CSRF origin check for mutating API requests (defense-in-depth)
  const method = request.method.toUpperCase();
  if (["POST", "PUT", "DELETE", "PATCH"].includes(method) && url.pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    const host = request.headers.get("host") ?? url.host;
    const isDev = import.meta.env.DEV;

    if (!isCsrfAllowed({ behindIngress, isDev, origin, referer, host })) {
      logger.log("warn", {
        event: "http.csrf_blocked",
        domain: "security",
        component: "middleware",
        request_id: requestId,
        message: `CSRF blocked: ${method} ${url.pathname} origin=${origin} host=${host} behindIngress=${behindIngress}`,
      });
      return new Response(
        JSON.stringify({ error: "CSRF origin mismatch" }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }
  }

  // ── Idempotency-Key — exactly-once execution for state-mutating requests ──
  // If a request includes an Idempotency-Key header and we have a cached response,
  // return the cached response immediately (prevents duplicate task creation etc.)
  const idempotencyKey = request.headers.get("idempotency-key")
  const isMutatingApi = url.pathname.startsWith("/api/") && ["POST", "PATCH", "DELETE"].includes(method)

  if (idempotencyKey && isMutatingApi) {
    // Check for cached response
    const cached = idempotencyCache.get(idempotencyKey)
    if (cached) {
      logger.log("info", {
        event: "http.idempotency_cache_hit",
        domain: "observability",
        component: "middleware",
        request_id: requestId,
        message: `Idempotency cache hit for key ${idempotencyKey.slice(0, 8)}...`,
      })
      const cachedHeaders = new Headers(cached.headers)
      cachedHeaders.set("Idempotency-Key-Status", "cached")
      cachedHeaders.set("x-request-id", requestId)
      return new Response(cached.body, {
        status: cached.status,
        headers: cachedHeaders,
      })
    }

    // Check for in-flight (concurrent duplicate)
    if (idempotencyCache.isInFlight(idempotencyKey)) {
      return apiProblem({
        status: 409,
        title: "Duplicate Request In Flight",
        detail: "A request with this Idempotency-Key is currently being processed",
        type: "https://meitheal.local/problems/idempotency-conflict",
      })
    }

    // Mark as in-flight before processing
    idempotencyCache.markInFlight(idempotencyKey)
  }

  const securityHeaders = buildSecurityHeaders(behindIngress, import.meta.env.DEV);

  // HA Supervisor already validates ingress sessions before proxying requests.
  // No additional auth enforcement needed on our side.

  let response = await next();

  // ── Cache response for idempotency ──
  if (idempotencyKey && isMutatingApi && response.status < 500) {
    try {
      const cloned = response.clone()
      const body = await cloned.text()
      const headers: Record<string, string> = {}
      cloned.headers.forEach((value, key) => { headers[key] = value })
      idempotencyCache.set(idempotencyKey, { status: cloned.status, headers, body, processedAt: Date.now() })
      response.headers.set("Idempotency-Key-Status", "processed")
    } catch {
      // Cache failure is non-fatal — just remove in-flight marker
      idempotencyCache.remove(idempotencyKey)
    }
  } else if (idempotencyKey && isMutatingApi) {
    // Don't cache 5xx errors — allow retries
    idempotencyCache.remove(idempotencyKey)
  }
  // Rewrite HTML paths when behind HA ingress
  if (ingressPath) {
    response = await rewriteIngressPaths(response, ingressPath);
    // Echo ingress path as response header so client-side JS can read it
    // without relying solely on window.__ingress_path injection.
    response.headers.set("x-ingress-path", ingressPath);
  }

  // Service-Worker-Allowed: let SW claim scope broader than its script path.
  // Required for ingress: SW at /api/hassio_ingress/{token}/sw.js needs to
  // control scope /api/hassio_ingress/{token}/. Without this header, browsers
  // restrict SW scope to the script's directory.
  response.headers.set("Service-Worker-Allowed", "/");

  // Inject security + observability headers on all responses
  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }
  response.headers.set("x-request-id", requestId);
  response.headers.set("x-response-time", `${Date.now() - startTime}ms`);
  if (url.pathname.startsWith("/api/")) {
    applyRateLimitHeaders(response, rateInfo.remaining, rateInfo.resetAt);
    const elapsed = Date.now() - startTime;

    // ── Structured API request log (Grafana/Loki compatible) ──
    // Log all API requests for agent traceability and observability.
    // Only log at "info" level for non-health endpoints to avoid noise.
    const isHealth = url.pathname === "/api/health"
    if (!isHealth) {
      logger.log(elapsed > 1000 ? "warn" : "info", {
        event: elapsed > 1000 ? "http.slow_request" : "http.api_request",
        domain: "observability",
        component: "middleware",
        request_id: requestId,
        trace_id: locals.traceId,
        span_id: locals.spanId,
        message: `${request.method} ${url.pathname} → ${response.status} (${elapsed}ms)`,
        metadata: {
          method: request.method,
          path: url.pathname,
          status: response.status,
          latency_ms: elapsed,
          automation_source: automationSource,
          ...(agentId ? { agent_id: agentId } : {}),
          ...(locals.hassUserId ? { ha_user_id: locals.hassUserId } : {}),
        },
      })
    } else if (elapsed > 1000) {
      // Still log slow health checks
      logger.log("warn", {
        event: "http.slow_request",
        domain: "observability",
        component: "middleware",
        request_id: requestId,
        message: `Slow health check: ${elapsed}ms`,
      })
    }
  }
  return response;
};
