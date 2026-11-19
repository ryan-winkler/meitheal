/**
 * Ingress State Persistence — restores navigation position after
 * HA Supervisor destroys and recreates the addon iframe.
 *
 * Bounded context: auth (ingress)
 *
 * @module ingress-state-persistence
 */

const STORAGE_KEY = "meitheal-navigation-state"
const SCROLL_KEY = "meitheal-restore-scroll"
const MAX_AGE_MS = 60_000
const SCROLL_DEBOUNCE_MS = 500

function scopedKey(key: string): string | null {
  if (typeof document === "undefined") return null
  const { workspaceScope, workspaceFrozen } = document.documentElement.dataset
  if (window.__ingress_path && (!workspaceScope || workspaceFrozen)) return null
  return workspaceScope ? `${key}:${workspaceScope}` : key
}

let pendingDestination: { path: string; timestamp: number } | undefined

export interface NavigationState {
  /** Ingress-stripped internal path + search + hash, e.g. "/tickets/MTH-142" or "/tasks?view=timeline" */
  path: string
  /** Vertical scroll position in pixels */
  scrollY: number
  /** Unix timestamp (ms) when this state was last saved */
  timestamp: number
}

/**
 * Strip the Home Assistant ingress prefix from a pathname or full relative URL
 * (`pathname + search + hash`), always returning a leading-slash internal route.
 */
export function stripIngressPrefix(
  rawPath: string,
  ingressPath: string | undefined = typeof window !== "undefined" ? window.__ingress_path : undefined,
): string {
  const value = rawPath || "/"
  const prefix = (ingressPath ?? "").replace(/\/+$/, "")
  if (!prefix) {
    return value.startsWith("/") ? value : `/${value}`
  }
  if (value === prefix) return "/"
  if (value.startsWith(`${prefix}/`)) {
    return value.slice(prefix.length).replace(/^\/+/, "/")
  }
  if (value.startsWith(`${prefix}?`) || value.startsWith(`${prefix}#`)) {
    return `/${value.slice(prefix.length)}`
  }
  return value.startsWith("/") ? value : `/${value}`
}

function currentInternalRoute(): string {
  const full = `${window.location.pathname}${window.location.search}${window.location.hash}`
  return stripIngressPrefix(full, window.__ingress_path)
}

/**
 * Save the current navigation state to sessionStorage.
 * When `path` is omitted, captures the current browser URL (behind HA ingress only).
 */
export function saveNavigationState(path?: string, scrollY?: number): void {
  try {
    const key = scopedKey(STORAGE_KEY)
    if (!key) return
    let resolvedPath: string
    let resolvedScrollY: number
    if (path === undefined) {
      if (typeof window === "undefined" || !window.__ingress_path) return
      resolvedPath = currentInternalRoute()
      if (pendingDestination && resolvedPath !== pendingDestination.path &&
        Date.now() - pendingDestination.timestamp <= MAX_AGE_MS) return
      pendingDestination = undefined
      resolvedScrollY = scrollY ?? window.scrollY
    } else {
      resolvedPath = stripIngressPrefix(path)
      resolvedScrollY = scrollY ?? (typeof window !== "undefined" ? window.scrollY : 0)
    }

    const state: NavigationState = {
      path: resolvedPath,
      scrollY: resolvedScrollY,
      timestamp: Date.now(),
    }
    sessionStorage.setItem(key, JSON.stringify(state))
  } catch {
    // sessionStorage full or unavailable — silently ignore
  }
}

/**
 * Read the saved navigation state.
 * Returns `null` if missing, malformed, or expired (> MAX_AGE_MS).
 */
export function getNavigationState(): NavigationState | null {
  try {
    const key = scopedKey(STORAGE_KEY)
    if (!key) return null
    const raw = sessionStorage.getItem(key)
    if (!raw) return null

    const state: NavigationState = JSON.parse(raw)

    if (
      typeof state.path !== "string" ||
      typeof state.scrollY !== "number" ||
      typeof state.timestamp !== "number"
    ) {
      return null
    }

    if (Date.now() - state.timestamp > MAX_AGE_MS) {
      sessionStorage.removeItem(key)
      return null
    }

    return {
      ...state,
      path: stripIngressPrefix(state.path),
    }
  } catch {
    return null
  }
}

/**
 * Determine whether this page load should restore a saved route.
 */
export function shouldRestore(
  currentPath: string,
  ingressPath: string | undefined,
): boolean {
  if (!ingressPath) return false
  if (stripIngressPrefix(currentPath, ingressPath) !== "/") return false
  const state = getNavigationState()
  if (!state) return false
  if (stripIngressPrefix(state.path, ingressPath) === "/") return false
  return true
}

/** Remember the destination while the old document is still firing lifecycle events. */
export function saveNavigationDestination(path: string): void {
  const route = stripIngressPrefix(path)
  const sameDocument = typeof window !== "undefined" &&
    route.split("#", 1)[0] === currentInternalRoute().split("#", 1)[0]
  pendingDestination = sameDocument ? undefined : { path: route, timestamp: Date.now() }
  saveNavigationState(route, 0)
}

let scrollTimer: ReturnType<typeof setTimeout> | null = null
let activeController: AbortController | null = null

/**
 * Initialize runtime ingress state persistence and pending scroll restoration.
 * Safe to call multiple times (aborts previous listeners).
 */
export function initStatePersistence(): void {
  if (typeof window === "undefined") return
  if (!window.__ingress_path) return

  activeController?.abort()
  const controller = new AbortController()
  activeController = controller
  const { signal } = controller

  signal.addEventListener("abort", () => {
    if (scrollTimer) clearTimeout(scrollTimer)
    scrollTimer = null
  }, { once: true })
  saveNavigationState()

  window.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        saveNavigationState()
      }, SCROLL_DEBOUNCE_MS)
    },
    { passive: true, signal },
  )

  document.addEventListener(
    "astro:page-load",
    () => {
      saveNavigationState()
    },
    { signal },
  )

  window.addEventListener("hashchange", () => saveNavigationState(), { signal })

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        saveNavigationState()
      }
    },
    { signal },
  )

  window.addEventListener(
    "beforeunload",
    () => {
      saveNavigationState()
      controller.abort()
    },
    { signal },
  )

  try {
    const scrollKey = scopedKey(SCROLL_KEY)
    const pendingScroll = scrollKey && sessionStorage.getItem(scrollKey)
    if (pendingScroll && scrollKey) {
      sessionStorage.removeItem(scrollKey)
      const y = parseInt(pendingScroll, 10)
      if (y > 0) {
        requestAnimationFrame(() => {
          window.scrollTo(0, y)
        })
      }
    }
  } catch {
    /* non-fatal */
  }
}
