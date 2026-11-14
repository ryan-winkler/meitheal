const hostAuthority = /^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::\d{1,5})?$/i

/** Link generation only. Astro replaces the incoming host when allowedDomains is unset. */
export function getA2ALinkOrigin(request: Request, fallback: URL): string {
  const host = request.headers.get("host")
  if (!host || !hostAuthority.test(host)) return fallback.origin

  // HA Core forwards the original Host and protocol through Supervisor.
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim().toLowerCase()
  const scheme = fallback.protocol === "https:" || forwardedProto === "https" ? "https" : "http"
  return URL.parse(`${scheme}://${host}`)?.origin ?? fallback.origin
}
