/** Only these content-free resources remain available during continuity recovery. */
export function continuityDiagnosticPath(path: string): boolean {
  return ["/api/health", "/api/health/live", "/api/health/ready", "/favicon.ico", "/favicon.svg", "/robots.txt"].includes(path) || path.startsWith("/_astro/")
}

export function continuityRequestAllowed(path: string, routePattern: string): boolean {
  return continuityDiagnosticPath(path) && continuityDiagnosticPath(routePattern)
}
