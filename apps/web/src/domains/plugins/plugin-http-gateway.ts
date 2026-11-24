/**
 * SSRF-Hardened Outbound HTTP Gateway for Plugins
 *
 * Enforces:
 *   - Plugin enabled + Safe Mode off + `http:outbound` permission
 *   - Exact hostname matching against `manifest.allowedHosts` (or admin-approved `$userServer`)
 *   - HTTPS required for external hosts (HTTP allowed only for explicitly approved local `$userServer`)
 *   - Strict blocking of loopback, link-local, cloud metadata, CGNAT, multicast,
 *     IPv4-mapped IPv6, and Home Assistant internal hosts (`supervisor`, `hassio`)
 *   - RFC 1918 private IPs blocked unless explicitly approved via `$userServer`
 *   - `redirect: "manual"` to prevent 302-based SSRF bypasses
 *   - Server-side `{{secret:key}}` header template substitution (requires `secrets:use`)
 *   - Response body capped at 1 MB and timeout capped at 15 s
 *
 * @domain plugins
 * @bounded-context plugins
 */
import { lookup as nodeDnsLookup } from "node:dns/promises"
import { isIP } from "node:net"
import { checkPluginCapability } from "./plugin-permissions"
import type {
  PluginHttpRequestInput,
  PluginHttpResponse,
  PluginRecord,
  PluginResult,
} from "./types"

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"])
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "supervisor",
  "hassio",
  "metadata.google.internal",
  "metadata",
])
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "transfer-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-ingress-path",
  "x-hass-user-id",
  "x-hass-is-admin",
])
const SECRET_TEMPLATE_RE = /\{\{secret:([a-zA-Z][a-zA-Z0-9_-]{1,63})\}\}/g

export const MAX_PLUGIN_HTTP_TIMEOUT_MS = 15_000
export const DEFAULT_PLUGIN_HTTP_TIMEOUT_MS = 8_000
export const MAX_PLUGIN_HTTP_RESPONSE_BYTES = 1024 * 1024 // 1 MB

export interface PluginHttpGatewayDeps {
  dnsLookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>
  fetchImpl?: typeof fetch
  resolveSecret?: (pluginId: string, key: string) => Promise<string | null>
}

function fail(errorCode: string, error: string, status = 403): PluginResult<never> {
  return { ok: false, errorCode, error, status }
}

function parseIpv4Octets(ip: string): number[] | null {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  const octets = parts.map((p) => Number.parseInt(p, 10))
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return octets
}

function parseIpv6Groups(ip: string): number[] | null {
  let working = ip.toLowerCase()
  // Handle embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1 or 0:0:0:0:0:ffff:127.0.0.1)
  const lastColon = working.lastIndexOf(":")
  if (lastColon !== -1 && working.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4Octets(working.slice(lastColon + 1))
    if (!v4) return null
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16)
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16)
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`
  }

  const halves = working.split("::")
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(":").filter(Boolean) : []
  const missing = 8 - (left.length + right.length)
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 0)) return null

  const rawGroups = halves.length === 2 ? [...left, ...Array<string>(missing).fill("0"), ...right] : left
  if (rawGroups.length !== 8) return null
  const groups = rawGroups.map((g) => Number.parseInt(g, 16))
  if (groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null
  return groups
}

export type IpClassification = "public" | "private_lan" | "blocked_internal"

export function classifyIpAddress(rawIp: string): IpClassification {
  const ip = rawIp.trim().replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase()
  const version = isIP(ip)
  if (version === 0) return "blocked_internal"

  if (version === 6) {
    const g = parseIpv6Groups(ip)
    if (!g) return "blocked_internal"

    // IPv4-mapped IPv6 (::ffff:0:0/96) or IPv4-compatible (::/96) in ANY compressed/expanded form
    const firstFiveZero = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0
    if (firstFiveZero && g[5] === 0xffff) {
      const v4 = `${(g[6]! >> 8) & 255}.${g[6]! & 255}.${(g[7]! >> 8) & 255}.${g[7]! & 255}`
      return classifyIpAddress(v4)
    }

    // Unspecified (::) and Loopback (::1) in any form (including 0:0:0:0:0:0:0:1)
    if (firstFiveZero && g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
      return "blocked_internal"
    }
    // Discard-only 100::/64
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return "blocked_internal"
    // Link-local fe80::/10, multicast ff00::/8
    if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00) return "blocked_internal"
    // Unique local fc00::/7
    if ((g[0]! & 0xfe00) === 0xfc00) return "private_lan"
    return "public"
  }

  const o = parseIpv4Octets(ip)
  if (!o) return "blocked_internal"
  const [a, b] = [o[0]!, o[1]!]

  // 0.0.0.0/8 (this network), 127.0.0.0/8 (loopback), 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 0 || a === 127) return "blocked_internal"
  if (a === 169 && b === 254) return "blocked_internal"
  // 100.64.0.0/10 (CGNAT / Tailscale / internal overlays)
  if (a === 100 && b >= 64 && b <= 127) return "blocked_internal"
  // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  if (a >= 224) return "blocked_internal"

  // RFC 1918 private LAN ranges (only permitted when explicitly admin-approved via $userServer)
  if (a === 10) return "private_lan"
  if (a === 172 && b >= 16 && b <= 31) return "private_lan"
  if (a === 192 && b === 168) return "private_lan"

  return "public"
}

function parseApprovedUserServer(rawUrl: string | null): URL | null {
  if (!rawUrl) return null
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null
    return parsed
  } catch {
    return null
  }
}

export async function validatePluginTargetUrl(
  plugin: Pick<PluginRecord, "id" | "manifest" | "approvedUserServer">,
  rawUrl: string,
  dnsLookup: (hostname: string) => Promise<Array<{ address: string; family: number }>>,
): Promise<PluginResult<{ url: URL; isApprovedUserServer: boolean; resolvedAddresses: Array<{ address: string; family: number }> }>> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return fail("INVALID_URL", "Target URL is not a valid absolute URL.", 400)
  }

  if (parsed.username || parsed.password) {
    return fail("INVALID_URL", "Embedded credentials in URLs are forbidden.", 400)
  }

  const host = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return fail("HOST_BLOCKED", `Target host "${host}" is blocked by network policy.`, 403)
  }

  const allowsUserServer = plugin.manifest.allowedHosts.includes("$userServer")
  const approvedServer = allowsUserServer ? parseApprovedUserServer(plugin.approvedUserServer) : null
  const matchesApprovedUserServer =
    approvedServer !== null &&
    approvedServer.hostname.toLowerCase() === host &&
    approvedServer.protocol === parsed.protocol &&
    approvedServer.port === parsed.port

  const matchesExplicitAllowlist = plugin.manifest.allowedHosts.some(
    (allowed) => allowed !== "$userServer" && allowed.toLowerCase() === host,
  )

  if (!matchesExplicitAllowlist && !matchesApprovedUserServer) {
    return fail(
      "HOST_BLOCKED",
      `Host "${host}" is not listed in allowedHosts or approved as the plugin server URL.`,
      403,
    )
  }

  // Require HTTPS for all external allowlisted hosts. Allow HTTP only if admin explicitly approved an HTTP $userServer.
  if (parsed.protocol !== "https:" && !(matchesApprovedUserServer && parsed.protocol === "http:")) {
    return fail("HTTPS_REQUIRED", "External plugin HTTP requests must use HTTPS.", 403)
  }

  // Resolve hostname (or inspect literal IP) to block SSRF targets
  const resolvedAddresses: Array<{ address: string; family: number }> = []
  const literalIp = host.replace(/^\[|\]$/g, "")
  const literalVersion = isIP(literalIp)
  if (literalVersion !== 0) {
    resolvedAddresses.push({ address: literalIp, family: literalVersion })
  } else {
    try {
      const resolved = await dnsLookup(host)
      if (!resolved || resolved.length === 0) {
        return fail("DNS_RESOLUTION_FAILED", `Could not resolve host "${host}".`, 502)
      }
      for (const rec of resolved) resolvedAddresses.push({ address: rec.address, family: rec.family })
    } catch {
      return fail("DNS_RESOLUTION_FAILED", `Could not resolve host "${host}".`, 502)
    }
  }

  for (const rec of resolvedAddresses) {
    const kind = classifyIpAddress(rec.address)
    if (kind === "blocked_internal") {
      return fail("HOST_BLOCKED", `Resolved IP for "${host}" is in a blocked internal range.`, 403)
    }
    if (kind === "private_lan" && !matchesApprovedUserServer) {
      return fail(
        "HOST_BLOCKED",
        `Resolved IP for "${host}" is on a private network. Approve it explicitly as a self-hosted server URL first.`,
        403,
      )
    }
  }

  return { ok: true, data: { url: parsed, isApprovedUserServer: matchesApprovedUserServer, resolvedAddresses } }
}

export async function executePluginHttpRequest(
  plugin: PluginRecord,
  safeMode: boolean,
  input: PluginHttpRequestInput,
  deps: PluginHttpGatewayDeps = {},
): Promise<PluginResult<PluginHttpResponse>> {
  const permCheck = checkPluginCapability(plugin, "http:outbound", safeMode)
  if (!permCheck.ok) return permCheck

  const method = String(input.method ?? "GET").toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    return fail("INVALID_METHOD", `HTTP method "${method}" is not allowed.`, 400)
  }

  if (typeof input.url !== "string" || input.url.length > 2048) {
    return fail("INVALID_URL", "Request URL must be a string under 2048 characters.", 400)
  }

  // Never allow secret placeholders inside URLs (prevents secret leaks in query strings / logs)
  if (input.url.includes("{{secret:")) {
    return fail("SECRET_IN_URL_FORBIDDEN", "Secrets can only be injected in request headers, never in URLs.", 400)
  }

  const dnsLookup =
    deps.dnsLookup ??
    ((hostname: string) => nodeDnsLookup(hostname, { all: true }))

  const targetResult = await validatePluginTargetUrl(plugin, input.url, dnsLookup)
  if (!targetResult.ok) return targetResult

  // Build sanitized headers and substitute {{secret:key}} templates on the server
  const outHeaders = new Headers()
  outHeaders.set("User-Agent", `Meitheal-Plugin/${plugin.id}`)
  const secretValuesToScrub: string[] = []

  if (input.headers && typeof input.headers === "object") {
    for (const [rawKey, rawVal] of Object.entries(input.headers)) {
      const key = rawKey.trim()
      const lowerKey = key.toLowerCase()
      if (!key || FORBIDDEN_REQUEST_HEADERS.has(lowerKey)) continue
      if (typeof rawVal !== "string" || rawVal.length > 4096) continue

      let resolvedValue = rawVal
      const matches = [...rawVal.matchAll(SECRET_TEMPLATE_RE)]
      if (matches.length > 0) {
        const secretPerm = checkPluginCapability(plugin, "secrets:use", safeMode)
        if (!secretPerm.ok) return secretPerm
        if (!deps.resolveSecret) {
          return fail("SECRET_UNAVAILABLE", "Secret store is unavailable.", 500)
        }
        for (const match of matches) {
          const secretKey = match[1]!
          const secretVal = await deps.resolveSecret(plugin.id, secretKey)
          if (!secretVal) {
            return fail(
              "SECRET_NOT_CONFIGURED",
              `Secret "${secretKey}" is not configured for plugin "${plugin.id}".`,
              400,
            )
          }
          secretValuesToScrub.push(secretVal)
          resolvedValue = resolvedValue.replace(match[0], secretVal)
        }
      }
      outHeaders.set(key, resolvedValue)
    }
  }

  let bodyPayload: string | undefined
  if (input.body !== undefined && method !== "GET") {
    bodyPayload = typeof input.body === "string" ? input.body : JSON.stringify(input.body)
    if (bodyPayload.length > 512 * 1024) {
      return fail("BODY_TOO_LARGE", "Plugin request body exceeds 512 KB.", 400)
    }
    if (!outHeaders.has("content-type")) {
      outHeaders.set("content-type", "application/json")
    }
  }

  const timeoutMs = Math.min(
    MAX_PLUGIN_HTTP_TIMEOUT_MS,
    Math.max(500, Number(input.timeoutMs) || DEFAULT_PLUGIN_HTTP_TIMEOUT_MS),
  )
  const fetchImpl = deps.fetchImpl ?? fetch
  const pinnedAddresses = targetResult.data.resolvedAddresses
  let pinnedDispatcher: { close(): Promise<void>; destroy(): Promise<void> } | null = null

  try {
    let requestInit: RequestInit = {
      method,
      headers: outHeaders,
      ...(bodyPayload !== undefined ? { body: bodyPayload } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    }

    // Pin the TCP connection to the exact validated IP(s) to prevent DNS-rebinding TOCTOU SSRF.
    if (!deps.fetchImpl && pinnedAddresses.length > 0) {
      const { Agent, Dispatcher1Wrapper } = await import("undici")
      const dispatcher = new Dispatcher1Wrapper(
        new Agent({
          connect: {
            lookup: (_hostname, options, callback) => {
              if (typeof options === "object" && options !== null && "all" in options && options.all) {
                callback(null, pinnedAddresses.map((r) => ({ address: r.address, family: r.family })))
                return
              }
              const first = pinnedAddresses[0]!
              callback(null, first.address, first.family)
            },
          },
        }),
      )
      pinnedDispatcher = dispatcher
      requestInit = { ...requestInit, dispatcher } as RequestInit
    }

    const response = await fetchImpl(targetResult.data.url.toString(), requestInit)

    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {})
      return fail("REDIRECT_BLOCKED", "External redirects are blocked by the plugin HTTP gateway.", 502)
    }

    const arrayBuf = await response.arrayBuffer()
    if (arrayBuf.byteLength > MAX_PLUGIN_HTTP_RESPONSE_BYTES) {
      return fail("RESPONSE_TOO_LARGE", "Upstream response exceeds the 1 MB plugin gateway limit.", 502)
    }

    let text = Buffer.from(arrayBuf).toString("utf8")
    // Defense-in-depth: never reflect an injected secret back to plugin JS
    for (const secretVal of secretValuesToScrub) {
      if (secretVal.length >= 6 && text.includes(secretVal)) {
        text = text.split(secretVal).join("[REDACTED]")
      }
    }

    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }

    const safeResponseHeaders: Record<string, string> = {}
    for (const allowedHeader of ["content-type", "etag", "x-ratelimit-remaining", "link"]) {
      const value = response.headers.get(allowedHeader)
      if (value) safeResponseHeaders[allowedHeader] = value
    }

    return {
      ok: true,
      data: {
        status: response.status,
        ok: response.ok,
        headers: safeResponseHeaders,
        json,
        text,
      },
    }
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
    return fail(
      isAbort ? "GATEWAY_TIMEOUT" : "GATEWAY_FETCH_FAILED",
      isAbort ? "Upstream request timed out." : "Upstream request failed.",
      504,
    )
  } finally {
    if (pinnedDispatcher) {
      void pinnedDispatcher.close().catch(() => pinnedDispatcher?.destroy().catch(() => {}))
    }
  }
}
