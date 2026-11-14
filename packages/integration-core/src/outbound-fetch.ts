/**
 * Outbound fetch policy for integration traffic (webhooks, n8n, CalDAV).
 *
 * Meitheal is self-hosted, so loopback and private LAN targets stay allowed:
 * n8n, CalDAV servers and other Home Assistant add-ons live there. What is
 * never allowed is a target no integration has a reason to reach: cloud
 * metadata services, the Supervisor API, link-local, unspecified, multicast
 * and reserved ranges.
 *
 * The policy is checked twice: once on the URL (literal IPs and names), and
 * again on every address DNS returns when the socket connects, so a name that
 * later resolves to a blocked address (DNS rebinding) is refused too.
 * Redirects are never followed implicitly; a caller that wants them asks for
 * "manual" and re-checks each hop.
 */
import dns from "node:dns"
import { BlockList, isIP } from "node:net"

export class OutboundUrlError extends Error {
  override name = "OutboundUrlError"
}

const blocked = new BlockList()
blocked.addSubnet("0.0.0.0", 8, "ipv4")          // "this network", unspecified
blocked.addSubnet("169.254.0.0", 16, "ipv4")     // link-local, AWS/GCP/Azure metadata
blocked.addSubnet("224.0.0.0", 4, "ipv4")        // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4")        // reserved, broadcast
blocked.addAddress("100.100.100.200", "ipv4")    // Alibaba Cloud metadata
blocked.addAddress("::", "ipv6")                 // unspecified
blocked.addSubnet("fe80::", 10, "ipv6")          // link-local
blocked.addSubnet("ff00::", 8, "ipv6")           // multicast
blocked.addAddress("fd00:ec2::254", "ipv6")      // AWS metadata over IPv6

const BLOCKED_HOSTNAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.internal",
  "instance-data",
  "instance-data.ec2.internal",
  // The Home Assistant Supervisor API. Integrations never call it through
  // these helpers, and a webhook must not be pointed at it.
  "supervisor",
])

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
}

/** Map an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) to IPv4. */
function unmapIPv4(address: string): string {
  const match = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(address)
  if (!match) return address
  const tail = match[1]!
  if (isIP(tail) === 4) return tail
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail)
  if (!hex) return address
  const high = parseInt(hex[1]!, 16)
  const low = parseInt(hex[2]!, 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".")
}

/** True when an IP address is one integration traffic must never reach. */
export function isBlockedOutboundAddress(address: string): boolean {
  const normalized = unmapIPv4(normalizeHostname(address))
  const family = isIP(normalized)
  if (family === 4) return blocked.check(normalized, "ipv4")
  if (family === 6) return blocked.check(normalized, "ipv6")
  return false
}

/** Parse and check an outbound URL; throws OutboundUrlError when it is not allowed. */
export function assertOutboundUrl(raw: string | URL): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundUrlError("Invalid URL format")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OutboundUrlError("Only http: and https: URLs are allowed")
  }
  const host = normalizeHostname(url.hostname)
  if (!host) throw new OutboundUrlError("URL has no host")
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new OutboundUrlError(`Host "${host}" is not an allowed integration target`)
  }
  if (isBlockedOutboundAddress(host)) {
    throw new OutboundUrlError(`Address ${host} is not an allowed integration target`)
  }
  return url
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void

/** dns.lookup replacement for socket connects that refuses blocked addresses. */
export function guardedLookup(hostname: string, options: dns.LookupOptions | LookupCallback, callback?: LookupCallback): void {
  const done = (typeof options === "function" ? options : callback) as LookupCallback
  const opts: dns.LookupOptions = typeof options === "function" ? {} : options
  if (BLOCKED_HOSTNAMES.has(normalizeHostname(hostname))) {
    done(new OutboundUrlError(`Host "${hostname}" is not an allowed integration target`), "")
    return
  }
  // Read dns.lookup at call time so a test's resolver stub is honoured.
  dns.lookup(hostname, { ...opts, all: true }, (error, addresses) => {
    if (error) return done(error, "")
    const refused = addresses.find(entry => isBlockedOutboundAddress(entry.address))
    if (refused) {
      return done(new OutboundUrlError(`${hostname} resolves to ${refused.address}, which is not an allowed integration target`), "")
    }
    if (!addresses.length) return done(Object.assign(new Error(`No addresses for ${hostname}`), { code: "ENOTFOUND" }), "")
    if (opts.all) return done(null, addresses)
    const first = addresses[0]!
    done(null, first.address, first.family)
  })
}

export type OutboundRequestInit = Omit<RequestInit, "redirect"> & {
  /** "error" (default) rejects any redirect; "manual" returns the 3xx for the caller to re-check. */
  redirect?: "error" | "manual"
}

/**
 * fetch() under the outbound policy. In development, a self-signed
 * certificate is accepted for hosts ending in ".internal" only.
 */
export async function fetchOutbound(url: string | URL, options: OutboundRequestInit = {}): Promise<Response> {
  const target = assertOutboundUrl(url)
  const relaxTls = process.env.NODE_ENV === "development" && target.hostname.endsWith(".internal")

  const { Agent, Dispatcher1Wrapper } = await import("undici")
  const dispatcher = new Dispatcher1Wrapper(new Agent({
    connect: { lookup: guardedLookup, ...(relaxTls ? { rejectUnauthorized: false } : {}) },
  }))

  try {
    const init = { ...options, redirect: options.redirect ?? "error", dispatcher }
    return await fetch(target, init as RequestInit)
  } finally {
    // close() lets the in-flight response body finish before the pool closes.
    void dispatcher.close().catch(() => dispatcher.destroy())
  }
}

/** @deprecated Use fetchOutbound; kept so existing imports keep working. */
export const fetchWithDevelopmentTls = fetchOutbound
