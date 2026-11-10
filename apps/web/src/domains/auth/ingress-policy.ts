export interface CsrfValidationInput {
  behindIngress: boolean;
  isDev: boolean;
  origin: string | null;
  referer: string | null;
  host: string;
}

function extractHost(urlValue: string | null): string | null {
  if (!urlValue) return null;
  try {
    return new URL(urlValue).host;
  } catch {
    return null;
  }
}

export function isCsrfAllowed(input: CsrfValidationInput): boolean {
  const { behindIngress, isDev, origin, referer, host } = input;
  // Behind ingress: HA Supervisor handles session auth; skip CSRF.
  // Dev mode: relaxed for local development.
  if (isDev || behindIngress) return true;

  const originHost = extractHost(origin);
  const refererHost = extractHost(referer);

  // Standalone mode: if neither origin nor referer is present,
  // reject the request. Browsers always send origin on cross-origin
  // POST/PUT/DELETE. Same-origin requests include referer by default.
  // Missing both headers likely indicates a non-browser client or
  // a stripped-headers attack.
  if (!origin && !referer) return false;

  return originHost === host || refererHost === host;
}

export function buildSecurityHeaders(behindIngress: boolean, isDev: boolean): Record<string, string> {
  const frameAncestors = behindIngress ? "*" : "'self'";
  return {
    "X-Content-Type-Options": "nosniff",
    // X-Frame-Options: ALLOW-FROM is deprecated and unsupported in modern
    // browsers. When behind ingress (or in HA addon), omit it entirely — CSP
    // frame-ancestors handles the policy. For standalone, use SAMEORIGIN.
    ...(!behindIngress ? { "X-Frame-Options": "SAMEORIGIN" } : {}),
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      // data: removed from script-src — it allows trivial XSS bypass via data: URIs
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:", // blob: for attachment previews
      "font-src 'self' data:",
      behindIngress
        ? "connect-src 'self' ws: wss: http://supervisor http://supervisor:*"
        : isDev
          ? "connect-src 'self' ws: wss:"
          : "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join("; "),
  };
}
