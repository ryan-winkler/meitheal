import { getSettingsRevision } from "./domains/tasks/persistence/settings-repository"
import type { MiddlewareHandler } from "astro";
import { apiProblem, apiRateLimited } from "./lib/api-response";
import { resolveIngressContext } from "@domains/auth/ingress";
import { getIngressTransport } from "../scripts/ingress-transport.mjs";
import { buildSecurityHeaders, isCsrfAllowed } from "@domains/auth/ingress-policy";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { getPersistenceClient, ensureDatabaseSchemaSupported, ensureSchema } from "@domains/tasks/persistence/store";
import { initHAIntegrations } from "@domains/ha";
import { startInactivityScheduler } from "@domains/tasks/task-inactivity-scheduler"
import type { DateFormat } from "./lib/date";
import { replayTaskRequest, taskRetryKey } from "./lib/idempotent-task-request"
import { rejectBoardSelectionInUrl } from "./domains/tasks/board-availability"
import { hasScope, isAssignedTaskScopedRoute, resolveAgentRouteScope } from "@meitheal/domain-auth"
import { resolveAgentAuth, type ResolvedAgent } from "./lib/agent-token-guard"
import { rewriteIngressHtml } from "./lib/rewrite-ingress-html"
import { commentAttemptHeader, commentMentionContextHeader } from "./lib/comment-mentions"
import { activeParticipantRequired, hasCurrentTaskParticipant, taskParticipantBodySignal } from "./lib/task-participant"

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
const BOT_PATH_PATTERNS = ["/accept-proposal", "/api/mcp"];

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
let _settingsCacheRevision = -1
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

function isPinRoute(path: string) {
  return path === "/api/task-pins" || path === "/pinned"
}

const onlineReadPaths = new Set(["/api/search", "/api/saved-filters", "/activity"])
const mentionPaths = new Set(["/api/comment-people", "/api/mention-inbox", "/mention-inbox"])
const taskHistoryPath = /^\/api\/tasks\/[^/]+\/(?:activity|timeline)$/
const draftPath = "/api/task-drafts"
const inactivityApiPath = "/api/task-inactivity"
const inactivityPagePath = "/inactivity"
const labelCleanupPath = "/api/labels/cleanup"
const commentPaths = new Set(["/api/tasks/[id]/comments", "/api/tasks/[id]/comments/[commentId]"])
const reactionPaths = new Set([
  "/api/tasks/reaction-counts",
  "/api/tasks/[id]/reactions",
  "/api/tasks/[id]/reactions/[reactionId]",
  "/api/tasks/[id]/comments/[commentId]/reactions",
  "/api/tasks/[id]/comments/[commentId]/reactions/[reactionId]",
])

export const onRequest: MiddlewareHandler = async (context, next) => {
  const { request, routePattern, url } = context
  const requestUrl = new URL(request.url)
  const requestPath = requestUrl.pathname
  const pinRoute = isPinRoute(routePattern) || isPinRoute(url.pathname)
  const onlineReadRoute = onlineReadPaths.has(routePattern) || onlineReadPaths.has(url.pathname)
  const mentionRoute = mentionPaths.has(routePattern) || mentionPaths.has(url.pathname)
  const draftRoute = routePattern === draftPath || url.pathname === draftPath
  const inactivityApi = routePattern === inactivityApiPath || url.pathname === inactivityApiPath
  const inactivityPage = routePattern === inactivityPagePath || url.pathname === inactivityPagePath
  const labelCleanup = routePattern === labelCleanupPath || url.pathname === labelCleanupPath
  const hasTaskHistoryPath = taskHistoryPath.test(requestPath)
  const taskHistoryRoute = hasTaskHistoryPath || taskHistoryPath.test(routePattern) || taskHistoryPath.test(url.pathname)
  const participantRoute = commentPaths.has(routePattern) || reactionPaths.has(routePattern)
  const privateTaskRoute = pinRoute || draftRoute || inactivityApi || inactivityPage || mentionRoute || labelCleanup
  if (!privateTaskRoute && !onlineReadRoute && !taskHistoryRoute && !participantRoute) {
    return handleRequest(context, next, requestUrl)
  }
  if (draftRoute && (requestPath !== draftPath || requestUrl.search)) {
    return new Response(null, { status: requestPath !== draftPath ? 404 : 400, headers: { "cache-control": "private, no-store" } })
  }
  if (labelCleanup && (requestPath !== labelCleanupPath || requestUrl.search)) {
    return Response.json({ ok: false, errorCode: "invalid", detail: "Use the canonical label cleanup path without query parameters." }, {
      status: requestPath !== labelCleanupPath ? 404 : 400, headers: { "cache-control": "private, no-store" },
    })
  }
  if ((inactivityApi && requestPath !== inactivityApiPath) || (inactivityPage && requestPath !== inactivityPagePath)) {
    return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } })
  }
  if (inactivityApi && requestUrl.search) {
    return new Response(null, { status: 400, headers: { "cache-control": "private, no-store" } })
  }
  // Astro matches decoded paths, while the agent guard checks the original request path.
  if (((onlineReadPaths.has(routePattern) || mentionPaths.has(routePattern)) && requestPath !== routePattern) ||
      (taskHistoryRoute && !hasTaskHistoryPath) ||
      (isPinRoute(routePattern) && routePattern !== url.pathname)) {
    return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } })
  }
  let response: Response
  try {
    response = await handleRequest(context, next, requestUrl, privateTaskRoute)
  } catch (error) {
    if (!labelCleanup) throw error
    return Response.json({ ok: false, errorCode: "unavailable", detail: "Could not verify label cleanup. Try again." }, {
      status: 503, headers: { "cache-control": "private, no-store" },
    })
  }
  if (labelCleanup && response.status >= 400) {
    const codes: Record<number, string> = {
      400: "invalid", 401: "denied", 403: "denied", 405: "method", 413: "tooLarge", 415: "media",
      429: "busy", 499: "cancelled", 503: "unavailable",
    }
    let errorCode = codes[response.status] ?? "unavailable"
    if (response.status === 409) {
      const payload = await response.clone().json().catch(() => null)
      if (payload?.errorCode === "stale" || payload?.errorCode === "blocked") errorCode = payload.errorCode
    }
    const headers = new Headers(response.headers)
    headers.set("cache-control", "private, no-store")
    headers.set("content-type", "application/json")
    headers.delete("content-length")
    return Response.json({ ok: false, errorCode, detail: "Review unused labels again with a current administrator session." }, {
      status: response.status, headers,
    })
  }
  if (!participantRoute || !response.headers.has("cache-control")) {
    const commentSuccess = commentPaths.has(routePattern) && response.ok
    response.headers.set("cache-control", commentSuccess ? "no-store" : "private, no-store")
  }
  return response
}

async function handleRequest({ request, locals, routePattern }: Parameters<MiddlewareHandler>[0],
  next: Parameters<MiddlewareHandler>[1], url: URL, privatePersonalRoute = false) {
  const startTime = Date.now();
  const commentRoute = commentPaths.has(routePattern)
  const participantRoute = commentRoute || reactionPaths.has(routePattern)
  const privateLog = privatePersonalRoute || participantRoute
  const logPath = participantRoute ? routePattern : url.pathname
  const requestId = (privateLog ? null : request.headers.get("x-request-id")) ?? crypto.randomUUID();
  locals.requestId = requestId
  const supervisorMode = Boolean(process.env.SUPERVISOR_TOKEN);
  const transport = getIngressTransport();
  const { ingressPath, behindIngress, hassUserId, hassIsAdmin } = resolveIngressContext(request.headers, transport);
  const trustedLocalCaller = supervisorMode && (transport?.peer === "127.0.0.1" || transport?.peer === "::1");
  const databaseExportPath = "/api/export/database.sqlite"
  // Older workers bypass caching only for the canonical export path.
  if (routePattern === databaseExportPath && url.pathname !== databaseExportPath) {
    return apiProblem({
      status: 404,
      detail: "Database download not found.",
      extraHeaders: { "cache-control": "private, no-store" },
    })
  }
  // Astro can route a decoded API namespace that the raw-path scope checks would miss.
  if (routePattern.startsWith("/api/") && !url.pathname.startsWith("/api/")) {
    return new Response(null, { status: 404, headers: { "cache-control": "private, no-store" } })
  }
  const method = request.method.toUpperCase();
  const isHealthCheck = url.pathname === "/api/health" && (method === "GET" || method === "HEAD");

  locals.ingressPath = ingressPath;
  locals.behindIngress = behindIngress;
  locals.hassUserId = hassUserId;
  locals.hassIsAdmin = hassIsAdmin;

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

  // Rate limit by the trusted identity or actual transport peer. Caller-supplied
  // forwarded addresses must not create new rate-limit buckets.
  const ip = hassUserId ? `ha:${hassUserId}` : transport?.peer || "127.0.0.1";
  const rateInfo = url.pathname.startsWith("/api/") ? getRateLimit(ip) : null

  if (rateInfo?.exceeded) {
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
  if (rateInfo && isBotEndpoint(url.pathname)) {
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

  let resolvedAgent: ResolvedAgent | null = null
  if (url.pathname.startsWith("/api/") && !isHealthCheck) {
    try {
      resolvedAgent = await resolveAgentAuth(request)
    } catch (error) {
      if (error instanceof Response) return error
      throw error
    }

    if (resolvedAgent) {
      const scope = resolveAgentRouteScope(url.pathname, method)
      const isAssignedRoute = isAssignedTaskScopedRoute(url.pathname, method)
      if (!scope || !hasScope(resolvedAgent.scopes, scope, { isAssignedTaskRoute: isAssignedRoute })) {
        return apiProblem({
          status: 403,
          detail: scope ? `This operation requires the ${scope} scope.` : "This operation is unavailable to agent credentials.",
          type: "https://meitheal.local/problems/insufficient-scope",
        })
      }
    }
  }

  // Attach agent info to locals for downstream route access
  locals.agentToken = resolvedAgent ?? undefined

  const authenticatedTransport = behindIngress || trustedLocalCaller || resolvedAgent !== null;
  if (supervisorMode && !authenticatedTransport && !isHealthCheck) {
    return apiProblem({
      status: url.pathname.startsWith("/api/") ? 401 : 403,
      title: "Ingress or API credential required",
      detail: "Open Meitheal through Home Assistant or use an authorized API credential.",
      type: "https://meitheal.local/problems/ingress-required",
      extraHeaders: url.pathname.startsWith("/api/") ? { "WWW-Authenticate": "Bearer" } : undefined,
    });
  }

  // Browser requests without verified transport still require same-origin proof.
  if (["POST", "PUT", "DELETE", "PATCH"].includes(method) && url.pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer");
    const host = request.headers.get("host") ?? url.host;
    const isDev = import.meta.env.DEV;

    if (!authenticatedTransport) {
      if (url.pathname === "/api/mcp" || url.pathname.startsWith("/api/a2a")) {
        return new Response(
          JSON.stringify({
            status: 401,
            title: "Unauthorized",
            detail: "Use a valid, active Meitheal agent token.",
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/problem+json",
              "WWW-Authenticate": 'Bearer realm="Meitheal"',
              "Cache-Control": "no-store",
            },
          }
        )
      }
      if (!isCsrfAllowed({ behindIngress, isDev, origin, referer, host })) {
        logger.log("warn", {
          event: "http.csrf_blocked",
          domain: "security",
          component: "middleware",
          request_id: requestId,
          message: privatePersonalRoute ? "Private task origin check failed" :
            participantRoute ? `Origin check failed for ${logPath}` :
            `CSRF blocked: ${method} ${url.pathname} origin=${origin} host=${host} behindIngress=${behindIngress}`,
        });
        return new Response(
          JSON.stringify({ error: "CSRF origin mismatch" }),
          { status: 403, headers: { "content-type": "application/json" } }
        );
      }
    }
  }

  const unavailableBoard = rejectBoardSelectionInUrl(url, routePattern, method)
  if (unavailableBoard) return unavailableBoard

  let databaseAvailable = true
  try {
    const schemaCheck = ensureDatabaseSchemaSupported()
    if (schemaCheck) await schemaCheck
  } catch {
    if (!isHealthCheck) {
      return apiProblem({
        status: 503,
        detail: "The database is unavailable. Check the Meitheal startup log or the health endpoint.",
        extraHeaders: { "cache-control": "private, no-store" },
      })
    }
    databaseAvailable = false
  }

  // Lazy-init only after accepting the caller. Do not block on the HA connection.
  if (databaseAvailable) {
    initHAIntegrations().catch(() => {})
    if (method === "GET" && (!isHealthCheck || !supervisorMode || trustedLocalCaller)) startInactivityScheduler()
  }

  // Load regional settings for SSR (cached for 60s to avoid DB per-request)
  locals.timezone = "Europe/Dublin";
  locals.weekStart = "monday";
  locals.dateFormat = "relative";
  const now = Date.now();
  if (_settingsCache && now < _settingsCacheExpiry && _settingsCacheRevision === getSettingsRevision()) {
    locals.timezone = _settingsCache.timezone;
    locals.weekStart = _settingsCache.weekStart;
    locals.dateFormat = _settingsCache.dateFormat as DateFormat;
  } else if (databaseAvailable) {
    try {
      const settingsRevision = getSettingsRevision()
      await ensureSchema();
      const db = getPersistenceClient();
      const res = await db.execute("SELECT key, value FROM settings WHERE key IN ('timezone', 'week_start', 'date_format')");
      for (const row of res.rows) {
        let value: unknown = row.value
        if (typeof value === "string") {
          try { value = JSON.parse(value) } catch { /* legacy plain-text settings */ }
        }
        if (row.key === "timezone" && typeof value === "string") {
          try {
            new Intl.DateTimeFormat("en", { timeZone: value })
            locals.timezone = value
          } catch { /* retain the default for invalid stored zones */ }
        }
        if (row.key === "week_start" && (value === "monday" || value === "sunday" || value === "saturday")) locals.weekStart = value
        if (row.key === "date_format" && typeof value === "string" && ["relative", "absolute-iso", "absolute-eu", "absolute-us"].includes(value)) locals.dateFormat = value as DateFormat
      }
      _settingsCache = { timezone: locals.timezone, weekStart: locals.weekStart, dateFormat: locals.dateFormat };
      _settingsCacheExpiry = now + SETTINGS_CACHE_TTL_MS;
      _settingsCacheRevision = settingsRevision
    } catch {
      /* ignore db errors, defaults used */
    }
  }

  const principal = resolvedAgent ? `agent:${resolvedAgent.tokenId}` :
    hassUserId ? `ha:${hassUserId}` : undefined
  const replayBodySignal = commentRoute && request.headers.has("idempotency-key") ? taskParticipantBodySignal(request) : undefined
  // Recheck the rendered account before processing mention writes or returning a durable receipt.
  const commentMentionWrite = commentRoute && (
    (method === "POST" && request.headers.has(commentAttemptHeader)) ||
    ((method === "POST" || method === "PATCH") && request.headers.has(commentMentionContextHeader))
  )
  const retryKey = privatePersonalRoute || commentMentionWrite ? undefined : await taskRetryKey(request, url, principal, replayBodySignal)
  if (retryKey instanceof Response && !commentRoute) return retryKey
  locals.taskRetryKey = typeof retryKey === "string" ? retryKey : undefined

  const securityHeaders = buildSecurityHeaders(behindIngress, import.meta.env.DEV);
  let response: Response
  if (retryKey instanceof Response) {
    response = retryKey
  } else if (retryKey && commentRoute && !await hasCurrentTaskParticipant(locals, request.signal, true)) {
    response = activeParticipantRequired()
  } else {
    response = retryKey ? await replayTaskRequest(retryKey, next) : await next()
  }

  // Rewrite HTML paths when behind HA ingress
  if (ingressPath) {
    response = await rewriteIngressHtml(response, ingressPath, {
      wait: transport?.waitForHtmlDrain,
      signal: request.signal,
    })
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
  if (rateInfo) {
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
        ...(!privateLog ? { trace_id: locals.traceId, span_id: locals.spanId } : {}),
        message: `${request.method} ${logPath} → ${response.status} (${elapsed}ms)`,
        metadata: {
          method: request.method,
          path: logPath,
          status: response.status,
          latency_ms: elapsed,
          ...(!privateLog ? {
            automation_source: automationSource,
            ...(agentId ? { agent_id: agentId } : {}),
            ...(locals.hassUserId ? { ha_user_id: locals.hassUserId } : {}),
          } : {}),
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
