// layout-body-controller.ts — Extracted from Layout.astro module <script> block
// Handles: sidebar badge hydration, sync notifications, route cleanup,
// and ingress state persistence.
import { TASK_COUNTS_CHANGED } from "./deferral-client"
import { initIngressNavigation } from "./ingress-navigation"
import { pageLifecycle } from "./page-lifecycle"

pageLifecycle.onPageLoad(initIngressNavigation)

// ───── Sidebar Badge Hydration ─────
// SSR renders the badge with server-side count, but it can be stale or 0
// if the DB wasn't ready during SSR. This hydrates it client-side.
async function refreshSidebarBadge() {
  const badge = document.getElementById("nav-count-tasks")
  if (!badge) return
  try {
    const res = await fetch("/api/tasks?status=active&deferred=0&limit=1")
    if (!res.ok) return
    const data = await res.json()
    if (badge.isConnected && typeof data.total === "number") {
      badge.textContent = String(data.total)
    }
  } catch {
    /* best-effort */
  }
}
refreshSidebarBadge()
pageLifecycle.onPageLoad(signal => {
  window.addEventListener(TASK_COUNTS_CHANGED, () => { void refreshSidebarBadge() }, { signal })
})

// Re-hydrate badge when tasks change (listen for custom events from task operations)
// ⚠️ Intentionally permanent: this module loads once at app level and must persist
// across all Astro navigations. No per-page cleanup needed (no AbortSignal).
window.addEventListener("meitheal-tasks-changed", () =>
  refreshSidebarBadge(),
)

// ───── Sync Notifications ─────
// ⚠️ Intentionally permanent: app-wide sync notification handler.
window.addEventListener("meitheal-sync", async (e: Event) => {
  const ce = e as CustomEvent
  if (ce.detail?.type === "conflict-resolved") {
    const { showToast } = await import("@lib/toast")
    showToast("common.sync_conflict_merged", "success")
  } else if (ce.detail?.type === "sync-error" && ce.detail.error) {
    const { showToast } = await import("@lib/toast")
    showToast(ce.detail.error, "error")
  }
})

// ───── Route Transition Cleanup ─────
// ⚠️ Intentionally permanent: must survive all navigations to reset overflow.
window.addEventListener("pagehide", () => {
  const taskOverlay = document.getElementById("task-detail-overlay")
  if (taskOverlay && taskOverlay.classList.contains("active")) {
    taskOverlay.classList.remove("active")
    document.body.style.overflow = ""
  }
})

// ───── Ingress State Persistence ─────
// Save current route + scroll so that when HA destroys the iframe
// (user clicks another sidebar item) and recreates it (clicks back),
// we can restore the position instead of always landing on Dashboard.
;(function initIngressStatePersistence() {
  const ip = window.__ingress_path
  if (!ip) return

  const STORAGE_KEY = "meitheal-navigation-state"
  const SCROLL_KEY = "meitheal-restore-scroll"
  const prefix = ip.replace(/\/+$/, "")

  function toAppPath(pathname: string): string {
    if (prefix && (pathname === prefix || pathname === prefix + "/")) return "/"
    if (prefix && pathname.startsWith(prefix + "/")) {
      return pathname.slice(prefix.length).replace(/^\/+/, "/") || "/"
    }
    return pathname || "/"
  }

  let activePath = toAppPath(window.location.pathname)
  let pendingNavigation = false

  function writeState(path: string, scrollY: number) {
    try {
      sessionStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          path,
          scrollY,
          timestamp: Date.now(),
        }),
      )
    } catch { /* non-fatal */ }
  }

  function recordScroll() {
    if (pendingNavigation) return
    const currentPath = toAppPath(window.location.pathname)
    if (currentPath !== activePath) return
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as { path?: unknown }
        if (typeof parsed.path === "string" && parsed.path !== currentPath) return
      }
    } catch { /* non-fatal */ }
    writeState(currentPath, window.scrollY)
  }

  // Record current path on load and Astro page swaps
  writeState(activePath, window.scrollY)
  document.addEventListener("astro:page-load", () => {
    pendingNavigation = false
    activePath = toAppPath(window.location.pathname)
    writeState(activePath, window.scrollY)
  })

  // Update target path on capture-phase click of internal links before navigation begins
  document.addEventListener("click", event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const target = event.target
    const link = target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null
    if (!link || link.download || (link.target && link.target !== "_self")) return
    try {
      const url = new URL(link.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const nextPath = toAppPath(url.pathname)
      pendingNavigation = nextPath !== activePath
      writeState(nextPath, nextPath === activePath ? window.scrollY : 0)
    } catch { /* ignore invalid href */ }
  }, { capture: true })

  // Only update scrollY on unload when stored path still matches current pathname
  window.addEventListener("beforeunload", recordScroll)

  // Debounced scroll tracking
  let scrollTimer: ReturnType<typeof setTimeout> | null = null
  window.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(recordScroll, 500)
    },
    { passive: true },
  )

  // Restore scroll position after redirect (if pending)
  const pendingScroll = sessionStorage.getItem(SCROLL_KEY)
  if (pendingScroll) {
    sessionStorage.removeItem(SCROLL_KEY)
    const y = parseInt(pendingScroll, 10)
    if (y > 0) {
      // Delay to let the page render first
      requestAnimationFrame(() => {
        window.scrollTo(0, y)
      })
    }
  }
})()
