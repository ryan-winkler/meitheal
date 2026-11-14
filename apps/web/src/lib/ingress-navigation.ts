const ROUTE_PARAM = "meitheal"
const NAVIGATION_STATE_KEY = "meitheal-navigation-state"

function ingressPrefix(): string {
  return (window.__ingress_path ?? "").replace(/\/+$/, "")
}

/**
 * Normalize an app route + optional ingress prefix into a safe same-origin path.
 * Blocks scheme-relative (`//`), backslash (`\`), and cross-origin/scripted URLs.
 */
export function safeIngressHref(rawPath: string, prefix = ingressPrefix()): string {
  const cleanPrefix = prefix.replace(/\/+$/, "")
  const safePrefix =
    cleanPrefix.startsWith("/") && !cleanPrefix.startsWith("//") && !cleanPrefix.includes("\\")
      ? cleanPrefix
      : ""
  const trimmed = (rawPath || "/").trim()
  if (!trimmed || /^[\w.+-]+:/i.test(trimmed) || trimmed.startsWith("//") || trimmed.includes("\\")) {
    return `${safePrefix}/`
  }
  const route = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const stripped =
    safePrefix && (route === safePrefix || route.startsWith(`${safePrefix}/`))
      ? route.slice(safePrefix.length) || "/"
      : route
  if (!stripped.startsWith("/") || stripped.startsWith("//") || stripped.includes("\\")) {
    return `${safePrefix}/`
  }
  return `${safePrefix}${stripped}`
}

function appRouteFromUrl(url: URL, prefix: string): string | null {
  if (url.origin !== location.origin) return null
  if (url.pathname === prefix || url.pathname === prefix + "/") {
    return "/" + url.search + url.hash
  }
  if (!url.pathname.startsWith(prefix + "/")) return null
  return url.pathname.slice(prefix.length).replace(/^\/+/, "/") + url.search + url.hash
}

function normalizeDestinationRoute(appPath: string, prefix: string): string {
  const trimmed = (appPath || "/").trim()
  if (!trimmed) return "/"
  try {
    const base = prefix ? prefix + "/" : "/"
    const url = new URL(trimmed, location.origin + base)
    const stripped = prefix ? appRouteFromUrl(url, prefix) : null
    if (stripped) return stripped
    const rawPath = url.pathname || "/"
    return (rawPath.startsWith("/") ? rawPath : "/" + rawPath) + url.search + url.hash
  } catch {
    return trimmed.startsWith("/") ? trimmed : "/" + trimmed
  }
}

function reflectHostRoute(route: string): void {
  if (window.parent === window) return
  const host = window.parent
  try {
    if (host.location.origin !== location.origin || !host.document.querySelector("home-assistant")) return
    const url = new URL(host.location.href)
    if (url.searchParams.get(ROUTE_PARAM) === route) return
    url.searchParams.set(ROUTE_PARAM, route)
    host.history.replaceState(host.history.state, "", url)
  } catch {
    // Cross-origin or sandboxed hosts keep using native iframe navigation.
  }
}

/** Persist and sync programmatic navigation destinations before window.location changes. */
export function syncIngressDestination(appPath: string): void {
  const prefix = ingressPrefix()
  const route = normalizeDestinationRoute(appPath, prefix)
  const routePath = route.split(/[?#]/)[0] || "/"

  if (prefix) {
    try {
      sessionStorage.setItem(
        NAVIGATION_STATE_KEY,
        JSON.stringify({
          path: routePath,
          scrollY: 0,
          timestamp: Date.now(),
        }),
      )
    } catch {
      // sessionStorage may be disabled in sandboxed contexts
    }
  }

  reflectHostRoute(route)
}

/** Keep the embedded app's route in the same-origin Home Assistant panel URL. */
export function initIngressNavigation(signal: AbortSignal): void {
  const prefix = ingressPrefix()
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
    return appRouteFromUrl(url, prefix)
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
    const nextUrl = new URL(safeIngressHref(saved, prefix), location.origin)
    if (nextUrl.origin === location.origin) {
      location.replace(nextUrl.pathname + nextUrl.search + nextUrl.hash) // nosemgrep: javascript.browser.security.open-redirect.js-open-redirect, javascript.browser.security.open-redirect-from-function.js-open-redirect-from-function
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
    const route = appRoute(new URL(link.href, location.href))
    if (!route) return
    // Reflect native navigation before a root link can reload the iframe.
    reflect(route)
  }, { capture: true, signal })

  window.addEventListener("hashchange", () => reflect(), { signal })
  window.addEventListener("popstate", () => reflect(), { signal })
  signal.addEventListener("abort", () => {
    if (history.pushState === pushWithRoute) history.pushState = push
    if (history.replaceState === replaceWithRoute) history.replaceState = replace
  }, { once: true })
}
