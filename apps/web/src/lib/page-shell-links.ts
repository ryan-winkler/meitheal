export function buildIngressPagePath(routePath: string, hash?: string): string {
  const ingressPath = window.__ingress_path || ""
  const normalizedPath = routePath.startsWith("/") ? routePath : `/${routePath}`
  const normalizedHash = hash ? `#${hash.replace(/^#/, "")}` : ""
  return `${ingressPath}${normalizedPath}${normalizedHash}`
}

export function buildCompanionNavigateUrl(path: string): string {
  return `homeassistant://navigate${path}`
}

export function buildCompanionXCallbackUrl(path: string, server?: string): string {
  const params = new URLSearchParams({ path })
  if (server) params.set("server", server)
  return `homeassistant://x-callback-url/navigate?${params.toString()}`
}
