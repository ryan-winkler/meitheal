// layout-body-controller.ts — Extracted from Layout.astro module <script> block
// Handles: sidebar badge hydration, sync notifications, route cleanup,
// and ingress state persistence.
import { TASK_COUNTS_CHANGED } from "./deferral-client"
import { initIngressNavigation } from "./ingress-navigation"
import { initStatePersistence } from "./ingress-state-persistence"
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
    document.body.classList.remove("has-docked-inspector")
    document.body.style.overflow = ""
  }
})

// ───── Ingress State Persistence ─────
initStatePersistence()
