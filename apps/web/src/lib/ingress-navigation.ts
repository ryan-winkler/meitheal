const ROUTE_PARAM = "meitheal"

/** Keep the embedded app's route in the same-origin Home Assistant panel URL. */
export function initIngressNavigation(signal: AbortSignal): void {
  const prefix = (window.__ingress_path ?? "").replace(/\/+$/, "")
  if (!prefix || window.parent === window) return

  const host = window.parent
  let panelPath: string
  try {
    if (host.location.origin !== location.origin || !host.document.querySelector("home-assistant")) return
    panelPath = host.location.pathname
  } catch {
    return
  }

  function appRoute(url: URL): string | null {
    if (url.origin !== location.origin || !url.pathname.startsWith(prefix + "/")) return null
    return url.pathname.slice(prefix.length).replace(/^\/+/, "/") + url.search + url.hash
  }

  function hostRoute(): string | null {
    try {
      if (host.location.pathname !== panelPath) return null
      const route = new URL(host.location.href).searchParams.get(ROUTE_PARAM)
      if (!route?.startsWith("/") || route.startsWith("//") || route.includes("\\")) return null
      const url = new URL(route, location.origin)
      return url.origin === location.origin ? url.pathname + url.search + url.hash : null
    } catch {
      return null
    }
  }

  function reflect(route = appRoute(new URL(location.href))): void {
    if (!route) return
    try {
      if (host.location.pathname !== panelPath) return
      const url = new URL(host.location.href)
      if (url.searchParams.get(ROUTE_PARAM) === route) return
      url.searchParams.set(ROUTE_PARAM, route)
      host.history.replaceState(host.history.state, "", url)
    } catch {
      // Cross-origin or sandboxed hosts keep using native iframe navigation.
    }
  }

  const saved = hostRoute()
  const current = appRoute(new URL(location.href))
  if (saved && current === "/" && saved !== "/") {
    const nextUrl = new URL(prefix + saved, location.origin)
    if (nextUrl.origin === location.origin) {
      location.replace(nextUrl.pathname + nextUrl.search + nextUrl.hash) // nosemgrep
    }
    return
  }
  reflect()

  const push = history.pushState
  const replace = history.replaceState
  const pushWithRoute: History["pushState"] = function (data, unused, url) {
    push.call(history, data, unused, url)
    reflect()
  }
  const replaceWithRoute: History["replaceState"] = function (data, unused, url) {
    replace.call(history, data, unused, url)
    reflect()
  }
  history.pushState = pushWithRoute
  history.replaceState = replaceWithRoute

  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null
    if (!link || link.download || (link.target && link.target !== "_self")) return
    // Reflect native navigation before a root link can reload the iframe.
    reflect(appRoute(new URL(link.href)))
  }, { signal })

  window.addEventListener("hashchange", () => reflect(), { signal })
  window.addEventListener("popstate", () => reflect(), { signal })
  signal.addEventListener("abort", () => {
    if (history.pushState === pushWithRoute) history.pushState = push
    if (history.replaceState === replaceWithRoute) history.replaceState = replace
  }, { once: true })
}
