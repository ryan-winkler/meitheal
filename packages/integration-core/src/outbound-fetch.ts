/**
 * Outbound fetch policy for integration traffic (webhooks, n8n, CalDAV).
 *
 * Meitheal is self-hosted, so loopback and private LAN targets stay allowed by
 * default: n8n, CalDAV servers and other Home Assistant add-ons live there.
 * Callers handling ad-hoc user-supplied test URLs can pass `allowPrivate: false`
 * to reject loopback and private addresses at both URL parse time and socket
 * connect time. What is never allowed is a target no integration has a reason
 * to reach: cloud metadata services, the Home Assistant Supervisor API (by
 * hostname, alias or resolved address), scoped IPv6 zone IDs, link-local,
 * unspecified, IPv4-compatible, multicast and reserved ranges.
 *
 * The policy is checked twice: once on the URL (literal IPs and names), and
 * again on every address DNS returns when the socket connects, so a name that
 * later resolves to a blocked address (DNS rebinding) is refused too.
 * Redirects are never followed implicitly; a caller that wants them asks for
 * "manual" and re-checks each hop. Outbound TLS verification is always kept
 * active (trust local development CAs via NODE_EXTRA_CA_CERTS).
 */
import dns from "node:dns"
import { BlockList, isIP } from "node:net"

declare const validatedOutboundBrand: unique symbol

/** URL instance that has passed assertOutboundUrl validation. */
export type ValidatedOutboundUrl = URL & {
  readonly [validatedOutboundBrand]: true
}

export class OutboundUrlError extends Error {
  override name = "OutboundUrlError"
}

export interface OutboundPolicyOptions {
  /** Whether private/loopback/localhost targets are allowed (default: true). */
  allowPrivate?: boolean
}

const blocked = new BlockList()
blocked.addSubnet("0.0.0.0", 8, "ipv4") // "this network", unspecified
blocked.addSubnet("169.254.0.0", 16, "ipv4") // link-local, AWS/GCP/Azure metadata
blocked.addSubnet("224.0.0.0", 4, "ipv4") // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4") // reserved, broadcast
blocked.addAddress("100.100.100.200", "ipv4") // Alibaba Cloud metadata
blocked.addAddress("172.30.32.2", "ipv4") // Home Assistant Supervisor bridge IP
blocked.addSubnet("::", 96, "ipv6") // unspecified + deprecated IPv4-compatible ::/96 (::1 carved out below)
blocked.addSubnet("::ffff:0:0:0", 96, "ipv6") // SIIT IPv4-translated
blocked.addSubnet("64:ff9b:1::", 48, "ipv6") // RFC 8215 local-use NAT64
blocked.addSubnet("2001::", 32, "ipv6") // Teredo tunneling
blocked.addSubnet("2002::", 16, "ipv6") // deprecated 6to4 tunneling
blocked.addSubnet("fe80::", 10, "ipv6") // link-local
blocked.addSubnet("ff00::", 8, "ipv6") // multicast
blocked.addAddress("fd00:ec2::254", "ipv6") // AWS metadata over IPv6

const privateOrLoopback = new BlockList()
privateOrLoopback.addSubnet("127.0.0.0", 8, "ipv4")
privateOrLoopback.addSubnet("10.0.0.0", 8, "ipv4")
privateOrLoopback.addSubnet("172.16.0.0", 12, "ipv4")
privateOrLoopback.addSubnet("192.168.0.0", 16, "ipv4")
privateOrLoopback.addAddress("::1", "ipv6")
privateOrLoopback.addSubnet("fc00::", 7, "ipv6")

const BLOCKED_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.internal",
  "instance-data",
  "instance-data.ec2.internal",
  // The Home Assistant Supervisor API and its internal aliases.
  "supervisor",
  "supervisor.internal",
  "hassio",
  "hassio.internal",
])

const BLOCKED_HOSTNAME_SUFFIXES = [
  ".hass.io",
  ".metadata.google.internal",
  ".metadata.goog",
  ".metadata.internal",
  ".instance-data",
  ".ec2.internal",
]

function stripTrailingDots(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 46) {
    end--
  }
  return end === value.length ? value : value.slice(0, end)
}

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase()
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1)
  }
  return stripTrailingDots(normalized)
}

function stripZoneId(address: string): string {
  const pct = address.indexOf("%")
  return pct >= 0 ? address.slice(0, pct) : address
}

function isLocalhostHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  return host === "localhost" || host.endsWith(".localhost")
}

function configuredSupervisorHostname(): string {
  const raw = process.env.SUPERVISOR_URL
  if (!raw) return ""
  try {
    return normalizeHostname(new URL(raw).hostname)
  } catch {
    return ""
  }
}

function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (!host || host.includes("%")) return true
  if (BLOCKED_HOSTNAMES.has(host)) return true
  if (BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true
  const configuredSupervisorHost = configuredSupervisorHostname()
  if (configuredSupervisorHost && host === configuredSupervisorHost) return true
  return false
}

function isAsciiHexGroup(value: string): boolean {
  if (value.length === 0 || value.length > 4) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const isDigit = code >= 48 && code <= 57
    const isLowerHex = code >= 97 && code <= 102
    if (!isDigit && !isLowerHex) return false
  }
  return true
}

function parseEmbeddedIPv4Tail(tail: string, allowCompressedZeroHigh = false): string | null {
  if (!tail) return "0.0.0.0"
  if (isIP(tail) === 4) return tail
  if (allowCompressedZeroHigh && isAsciiHexGroup(tail)) {
    const low = Number.parseInt(tail, 16)
    return `0.0.${(low >> 8) & 0xff}.${low & 0xff}`
  }
  const colonIdx = tail.indexOf(":")
  if (colonIdx <= 0 || colonIdx !== tail.lastIndexOf(":")) return null
  const highStr = tail.slice(0, colonIdx)
  const lowStr = tail.slice(colonIdx + 1)
  if (!isAsciiHexGroup(highStr) || !isAsciiHexGroup(lowStr)) return null
  const high = Number.parseInt(highStr, 16)
  const low = Number.parseInt(lowStr, 16)
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}

function looksLikeNumericIpv4Literal(value: string): boolean {
  if (!value) return false
  const first = value.charCodeAt(0)
  if (first < 48 || first > 57) return false
  for (let i = 1; i < value.length; i++) {
    const c = value.charCodeAt(i)
    const ok = (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || c === 46 || c === 120
    if (!ok) return false
  }
  return true
}

function canonicalizeIpLiteral(address: string): string {
  const clean = stripZoneId(address)
  if (!clean.includes(":")) {
    if (isIP(clean) === 4 || !looksLikeNumericIpv4Literal(clean)) return clean
    try {
      const urlHost = new URL(`http://${clean}`).hostname.toLowerCase()
      return isIP(urlHost) === 4 ? urlHost : clean
    } catch {
      return clean
    }
  }
  try {
    const urlHost = new URL(`http://[${clean}]`).hostname.toLowerCase()
    return urlHost.startsWith("[") && urlHost.endsWith("]") ? urlHost.slice(1, -1) : urlHost
  } catch {
    return clean
  }
}

/**
 * Unmap IPv4-mapped IPv6 (::ffff:0:0/96), SIIT (::ffff:0:0:0/96), and NAT64
 * well-known prefix (64:ff9b::/96) to dotted-quad IPv4 without backtracking regexes.
 */
function unmapIPv4(address: string): string {
  const canonical = canonicalizeIpLiteral(address)
  if (canonical.startsWith("::ffff:0:")) {
    const siitTail = canonical.slice("::ffff:0:".length)
    if (siitTail.includes(":") || isIP(siitTail) === 4) {
      return parseEmbeddedIPv4Tail(siitTail, false) ?? canonical
    }
  }
  if (canonical.startsWith("::ffff:")) {
    return parseEmbeddedIPv4Tail(canonical.slice("::ffff:".length), false) ?? canonical
  }
  if (canonical === "64:ff9b::" || canonical.startsWith("64:ff9b::")) {
    return parseEmbeddedIPv4Tail(canonical.slice("64:ff9b::".length), true) ?? canonical
  }
  return canonical
}

/** True when an IP address is one integration traffic must never reach. */
export function isBlockedOutboundAddress(address: string): boolean {
  const raw = normalizeHostname(address)
  if (raw.includes("%")) return true
  const canonical = canonicalizeIpLiteral(raw)
  if (isIP(canonical) === 6 && canonical !== "::1" && blocked.check(canonical, "ipv6")) {
    return true
  }
  const normalized = unmapIPv4(canonical)
  const family = isIP(normalized)
  if (family === 0) return false
  const supHost = configuredSupervisorHostname()
  if (supHost) {
    const supCanonical = unmapIPv4(supHost)
    if (isIP(supCanonical) !== 0 && normalized === supCanonical) return true
  }
  if (family === 4) return blocked.check(normalized, "ipv4")
  if (normalized === "::1") return false
  return blocked.check(normalized, "ipv6")
}

/** True when an IP address is blocked, loopback, RFC1918 private, or IPv6 ULA. */
export function isPrivateOutboundAddress(address: string): boolean {
  if (isBlockedOutboundAddress(address)) return true
  const normalized = unmapIPv4(normalizeHostname(address))
  const family = isIP(normalized)
  if (family === 4) return privateOrLoopback.check(normalized, "ipv4")
  if (family === 6) return privateOrLoopback.check(normalized, "ipv6")
  return false
}

/** Parse and check an outbound URL; throws OutboundUrlError when it is not allowed. */
export function assertOutboundUrl(raw: string | URL, options: OutboundPolicyOptions = {}): ValidatedOutboundUrl {
  const allowPrivate = options.allowPrivate ?? true
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundUrlError("Invalid URL format")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError("Only http: and https: URLs are allowed")
  }
  if (url.username || url.password) {
    throw new OutboundUrlError("Outbound URL must not include embedded credentials")
  }
  const host = normalizeHostname(url.hostname)
  if (!host) throw new OutboundUrlError("URL has no host")
  if (isBlockedHostname(host)) {
    throw new OutboundUrlError(`Host "${host}" is not an allowed integration target`)
  }
  if (isBlockedOutboundAddress(host)) {
    throw new OutboundUrlError(`Address ${host} is not an allowed integration target`)
  }
  if (!allowPrivate && (isLocalhostHostname(host) || isPrivateOutboundAddress(host))) {
    throw new OutboundUrlError("URL points to a private/internal network address")
  }
  return url as ValidatedOutboundUrl
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void

let cachedLookupFn: typeof dns.lookup | null = null
let cachedSupervisorEnv = ""
let cachedSupervisorIps: Set<string> = new Set()
let cachedSupervisorExpiry = 0

function resolveSupervisorIps(
  lookupFn: typeof dns.lookup,
  cb: (ips: Set<string>, customSupervisorFailed: boolean) => void,
): void {
  const now = Date.now()
  const supEnv = process.env.SUPERVISOR_URL ?? ""
  if (cachedLookupFn === lookupFn && cachedSupervisorEnv === supEnv && now < cachedSupervisorExpiry) {
    cb(cachedSupervisorIps, false)
    return
  }

  const namesToProbe = ["supervisor"]
  const supHost = configuredSupervisorHostname()
  let customHostToResolve = ""
  const staticIps = new Set<string>()
  if (supHost) {
    const unmapped = unmapIPv4(supHost)
    if (isIP(unmapped) !== 0) {
      staticIps.add(unmapped)
    } else {
      customHostToResolve = supHost
      if (!namesToProbe.includes(supHost)) {
        namesToProbe.push(supHost)
      }
    }
  }

  let remaining = namesToProbe.length
  const collected = new Set<string>(staticIps)
  let customFailed = false
  let finished = false
  const completeOne = () => {
    remaining--
    if (remaining > 0 || finished) return
    finished = true
    if (!customFailed) {
      cachedLookupFn = lookupFn
      cachedSupervisorEnv = supEnv
      cachedSupervisorIps = collected
      cachedSupervisorExpiry = now + 30_000
    }
    cb(collected, customFailed)
  }

  for (const name of namesToProbe) {
    let probeDone = false
    const markProbe = (resolvedAny: boolean) => {
      if (probeDone) return
      probeDone = true
      if (customHostToResolve && name === customHostToResolve && !resolvedAny) {
        customFailed = true
      }
      completeOne()
    }
    try {
      lookupFn(name, { all: true }, (err, entries) => {
        let added = false
        if (!err && Array.isArray(entries)) {
          for (const entry of entries) {
            if (!entry.address.includes("%")) {
              collected.add(unmapIPv4(normalizeHostname(entry.address)))
              added = true
            }
          }
        }
        markProbe(added)
      })
    } catch {
      markProbe(false)
    }
  }
}

function toAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

function getSupervisorIps(
  lookupFn: typeof dns.lookup,
  signal?: AbortSignal | null,
): Promise<{ ips: Set<string>; customSupervisorFailed: boolean }> {
  if (signal?.aborted) {
    return Promise.reject(toAbortReason(signal))
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      reject(toAbortReason(signal!))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    resolveSupervisorIps(lookupFn, (ips, customSupervisorFailed) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      resolve({ ips, customSupervisorFailed })
    })
  })
}

/** Build a dns.lookup replacement for socket connects enforcing the outbound policy. */
export function createGuardedLookup(policy: OutboundPolicyOptions = {}) {
  const allowPrivate = policy.allowPrivate ?? true
  return function guardedLookupImpl(
    hostname: string,
    options: dns.LookupOptions | number | LookupCallback,
    callback?: LookupCallback,
  ): void {
    const done = (typeof options === "function" ? options : callback) as LookupCallback
    const opts: dns.LookupOptions =
      typeof options === "number" ? { family: options } : !options || typeof options === "function" ? {} : options
    if (isBlockedHostname(hostname)) {
      done(new OutboundUrlError(`Host "${hostname}" is not an allowed integration target`), "")
      return
    }
    if (!allowPrivate && isLocalhostHostname(hostname)) {
      done(new OutboundUrlError("URL points to a private/internal network address"), "")
      return
    }
    // Read dns.lookup at call time so a test's resolver stub is honoured.
    const currentLookup = dns.lookup
    resolveSupervisorIps(currentLookup, (supervisorIps, customSupervisorFailed) => {
      if (customSupervisorFailed) {
        done(new OutboundUrlError("Configured SUPERVISOR_URL hostname could not be resolved safely"), "")
        return
      }
      currentLookup(hostname, { ...opts, all: true }, (error, addresses) => {
        if (error) return done(error, "")
        const refused = addresses.find((entry) => {
          if (isBlockedOutboundAddress(entry.address)) return true
          const canonical = unmapIPv4(normalizeHostname(entry.address))
          if (supervisorIps.has(canonical)) return true
          if (!allowPrivate && isPrivateOutboundAddress(entry.address)) return true
          return false
        })
        if (refused) {
          return done(
            new OutboundUrlError(
              `${hostname} resolves to ${refused.address}, which is not an allowed integration target`,
            ),
            "",
          )
        }
        if (!addresses.length) {
          return done(Object.assign(new Error(`No addresses for ${hostname}`), { code: "ENOTFOUND" }), "")
        }
        if (opts.all) return done(null, addresses)
        const first = addresses[0]!
        done(null, first.address, first.family)
      })
    })
  }
}

/** Default dns.lookup replacement allowing LAN/loopback while blocking metadata and Supervisor targets. */
export const guardedLookup = createGuardedLookup()

export type OutboundRequestInit = Omit<RequestInit, "redirect"> & OutboundPolicyOptions & {
  /** "error" (default) rejects any redirect; "manual" returns the 3xx for the caller to re-check. */
  redirect?: "error" | "manual"
}

async function dispatchValidatedOutbound(
  target: ValidatedOutboundUrl,
  init: RequestInit,
): Promise<Response> {
  return fetch(target.href, init) // nosemgrep
}

/**
 * fetch() under the shared outbound policy: URL validation, connect-time DNS
 * validation (including Supervisor IP/alias blocking), no implicit redirects,
 * and mandatory TLS certificate verification.
 */
export async function fetchOutbound(
  url: string | URL,
  options: OutboundRequestInit = {},
): Promise<Response> {
  const { allowPrivate = true, redirect = "error", ...requestOptions } = options
  const target = assertOutboundUrl(url, { allowPrivate })

  // Node/undici skips connect.lookup when the URL host is already an IP literal,
  // so verify literal IPs against dynamically resolved Supervisor addresses up front.
  const canonicalHost = unmapIPv4(normalizeHostname(target.hostname))
  if (isIP(canonicalHost) !== 0) {
    const { ips: supervisorIps, customSupervisorFailed } = await getSupervisorIps(dns.lookup, requestOptions.signal)
    if (customSupervisorFailed) {
      throw new OutboundUrlError("Configured SUPERVISOR_URL hostname could not be resolved safely")
    }
    if (supervisorIps.has(canonicalHost)) {
      throw new OutboundUrlError(`Address ${target.hostname} is not an allowed integration target`)
    }
  }

  const { Agent, Dispatcher1Wrapper } = await import("undici")
  const dispatcher = new Dispatcher1Wrapper(
    new Agent({
      connect: { lookup: allowPrivate ? guardedLookup : createGuardedLookup({ allowPrivate: false }) },
    }),
  )

  try {
    const init = { ...requestOptions, redirect, dispatcher }
    return await dispatchValidatedOutbound(target, init as RequestInit)
  } finally {
    // close() lets the in-flight response body finish before the pool closes.
    void dispatcher.close().catch(() => dispatcher.destroy())
  }
}

/** @deprecated Use fetchOutbound; kept so existing imports keep working. */
export const fetchWithDevelopmentTls = fetchOutbound
