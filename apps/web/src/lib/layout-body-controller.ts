// layout-body-controller.ts — Extracted from Layout.astro module <script> block
// Handles: sidebar badge hydration, sync notifications, route cleanup,
// and ingress state persistence.
import { TASK_COUNTS_CHANGED } from "./deferral-client"
import { initIngressNavigation } from "./ingress-navigation"
import { initStatePersistence } from "./ingress-state-persistence"
import { pageLifecycle } from "./page-lifecycle"
import { showToast } from "./toast"

pageLifecycle.onPageLoad(initIngressNavigation)

// ───── Sidebar Badge Hydration ─────
// Refresh the active-task count when an integration mounts the optional badge.
async function refreshSidebarBadge() {
  const badge = document.getElementById("nav-count-tasks")
  if (!badge) return
  try {
    const res = await fetch("/api/tasks?status=active&deferred=0&limit=1")
    if (!res.ok) return
    const data = await res.json()
    if (badge.isConnected && typeof data.total === "number") {
      badge.textContent = String(data.total)
      badge.hidden = data.total <= 0
      badge.setAttribute("aria-label", `${data.total} active`)
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
window.addEventListener("meitheal-sync", (e: Event) => {
  const ce = e as CustomEvent
  if (ce.detail?.type === "conflict-resolved") {
    showToast("common.sync_conflict_merged", "success")
  } else if (ce.detail?.type === "sync-error" && ce.detail.error) {
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
