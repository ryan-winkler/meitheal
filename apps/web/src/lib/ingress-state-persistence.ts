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
    return value.slice(prefix.length) || "/"
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
    let resolvedPath: string
    let resolvedScrollY: number
    if (path === undefined) {
      if (typeof window === "undefined" || !window.__ingress_path) return
      resolvedPath = currentInternalRoute()
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
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state))
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
    const raw = sessionStorage.getItem(STORAGE_KEY)
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
      sessionStorage.removeItem(STORAGE_KEY)
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

  saveNavigationState(currentInternalRoute(), window.scrollY)

  window.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        saveNavigationState(currentInternalRoute(), window.scrollY)
      }, SCROLL_DEBOUNCE_MS)
    },
    { passive: true, signal },
  )

  document.addEventListener(
    "astro:page-load",
    () => {
      saveNavigationState(currentInternalRoute(), window.scrollY)
    },
    { signal },
  )

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "hidden") {
        saveNavigationState(currentInternalRoute(), window.scrollY)
      }
    },
    { signal },
  )

  window.addEventListener(
    "beforeunload",
    () => {
      saveNavigationState(currentInternalRoute(), window.scrollY)
      controller.abort()
    },
    { signal },
  )

  try {
    const pendingScroll = sessionStorage.getItem(SCROLL_KEY)
    if (pendingScroll) {
      sessionStorage.removeItem(SCROLL_KEY)
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
