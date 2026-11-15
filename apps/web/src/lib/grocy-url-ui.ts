export const LEGACY_HASSIO_INGRESS_PATH = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]+\/?$/
const INTERNAL_ADDON_CONTAINER_HOST = /^(?:[0-9a-f]{8}|local|core|addon)-[a-z0-9-]+$/i

/**
 * True when `rawUrl` is a browser-reachable Grocy HTTP(S) URL rather than a legacy
 * Supervisor ingress path/host or an internal Supervisor add-on container hostname.
 */
export function isBrowserReachableGrocyUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim()
  if (!trimmed || LEGACY_HASSIO_INGRESS_PATH.test(trimmed)) return false
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return false
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
  const hostname = parsed.hostname.toLowerCase()
  if (!hostname || hostname === "supervisor" || INTERNAL_ADDON_CONTAINER_HOST.test(hostname)) {
    return false
  }
  return true
}
