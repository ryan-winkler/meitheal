/**
 * Ingress State Persistence — restores navigation position after
 * HA Supervisor destroys and recreates the addon iframe.
 *
 * When the user clicks away from Meitheal in the HA sidebar and
 * clicks back, the iframe is destroyed and recreated from scratch,
 * always loading the root `/` URL.  This module persists the current
 * route + scroll position to `sessionStorage` and restores it on
 * reload if the saved state is less than 60 seconds old.
 *
 * Bounded context: auth (ingress)
 *
 * @module ingress-state-persistence
 */

// Window globals (typed in types/window.d.ts):
//   __ingress_path

// ── Constants ──────────────────────────────────────────────────────
const STORAGE_KEY = "meitheal-navigation-state";
const MAX_AGE_MS = 60_000; // 60 seconds — state expires after this
const SCROLL_DEBOUNCE_MS = 500;

// ── Types ──────────────────────────────────────────────────────────
export interface NavigationState {
  /** Internal path, e.g. "/kanban" or "/settings" */
  path: string;
  /** Vertical scroll position in pixels */
  scrollY: number;
  /** Unix timestamp (ms) when this state was last saved */
  timestamp: number;
}

// ── Save / Read helpers ────────────────────────────────────────────

/**
 * Save the current navigation state to sessionStorage.
 */
export function saveNavigationState(path: string, scrollY = 0): void {
  try {
    const state: NavigationState = {
      path,
      scrollY,
      timestamp: Date.now(),
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const state: NavigationState = JSON.parse(raw);

    // Validate shape
    if (
      typeof state.path !== "string" ||
      typeof state.scrollY !== "number" ||
      typeof state.timestamp !== "number"
    ) {
      return null;
    }

    // Check freshness
    if (Date.now() - state.timestamp > MAX_AGE_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

/**
 * Determine whether this page load should restore a saved route.
 * Only restores when:
 * 1. Running inside HA ingress (window.__ingress_path is set)
 * 2. Current path is "/" (the default ingress entry point)
 * 3. A valid, non-expired saved state exists pointing to a different path
 */
export function shouldRestore(
  currentPath: string,
  ingressPath: string | undefined,
): boolean {
  if (!ingressPath) return false; // Not behind ingress
  if (currentPath !== "/") return false; // Already on a sub-route
  const state = getNavigationState();
  if (!state) return false;
  if (state.path === "/") return false; // Saved path is root — nothing to restore
  return true;
}

// ── Initialization ─────────────────────────────────────────────────

let scrollTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Initialize the state persistence system.
 * Call once on page load. Safe to call multiple times (idempotent).
 * MP-01: All listeners use AbortController signal for cleanup.
 */
export function initStatePersistence(): void {
  if (typeof window === "undefined") return;
  if (!window.__ingress_path) return; // Only active behind HA ingress

  const currentPath = window.location.pathname;

  // Save the current page on every load (including initial)
  saveNavigationState(currentPath, 0);

  // MP-01: AbortController for listener cleanup on page transitions
  const controller = new AbortController();
  const { signal } = controller;

  // Debounced scroll tracking
  window.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        saveNavigationState(window.location.pathname, window.scrollY);
      }, SCROLL_DEBOUNCE_MS);
    },
    { passive: true, signal },
  );

  // Astro client-side navigation: save state on page transitions
  document.addEventListener("astro:page-load", () => {
    const path = window.location.pathname;
    saveNavigationState(path, 0);
  }, { signal });

  // P1-5: visibilitychange is more reliable than beforeunload in HA iframe
  // context — iOS WKWebView and some Android WebViews don't fire beforeunload
  // when the ingress iframe is destroyed. visibilitychange fires consistently.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      saveNavigationState(window.location.pathname, window.scrollY);
    }
  }, { signal });

  // Save state just before the page unloads (fallback for non-iframe contexts)
  // Also abort the controller to clean up all listeners
  window.addEventListener("beforeunload", () => {
    saveNavigationState(window.location.pathname, window.scrollY);
    controller.abort();
  });
}
