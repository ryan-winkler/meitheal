/**
 * Ingress-aware URL helper for client-side fetch calls.
 *
 * HA Supervisor ingress proxies requests through a path prefix
 * (e.g. /api/hassio_ingress/{token}/). The server injects this
 * prefix as window.__ingress_path. All client-side fetch calls
 * must use this helper to prefix their paths.
 *
 * Bounded context: auth (ingress)
 */

// Window.__ingress_path is declared in types/window.d.ts

/**
 * Prefix an absolute path with the HA ingress path if present.
 *
 * @example
 * // Without ingress (local dev): apiUrl("/api/health") → "/api/health"
 * // With ingress: apiUrl("/api/health") → "/api/hassio_ingress/{token}/api/health"
 */
export function apiUrl(path: string): string {
  const base = typeof window !== "undefined" ? (window.__ingress_path ?? "") : "";
  return `${base}${path}`;
}
