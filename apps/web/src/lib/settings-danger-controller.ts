/**
 * Danger zone settings controller.
 *
 * Handles purge all tasks, reset settings, and factory reset.
 * All destructive operations require confirmation dialogs.
 */
import { confirmDialog } from "@lib/confirm-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { settingsStore } from "@lib/settings-store"
import { showToast } from "@lib/toast"

export function initDangerZoneSettings(): void {
  // Purge all tasks
  const purgeBtn = document.getElementById("purge-tasks")
  if (purgeBtn) {
    pageLifecycle.on(purgeBtn, "click", async () => {
    const ok = await confirmDialog({
      title: "Purge All Tasks",
      message: "This will permanently delete ALL tasks. This action is irreversible.",
      variant: "danger",
      confirmText: "Purge Everything",
    })
    if (!ok) return
    const typed = prompt("Type YES to confirm purge:")
    if (typed?.toUpperCase() !== "YES") {
      showToast("settings.purge_cancelled", "error")
      return
    }
    try {
      const res = await fetch(
        (window.__ingress_path || "") + "/api/tasks?purge=all",
        { method: "DELETE", signal: pageLifecycle.signal },
      )
      if (res.ok) {
        showToast("settings.purge_success")
        // Full reload required — all task views, counts, and kanban state are stale after purge
        setTimeout(() => {
          if (pageLifecycle.signal.aborted) return
          window.location.reload()
        }, 1000)
      } else showToast("settings.purge_failed", "error")
    } catch {
      showToast("common.network_error", "error")
    }
    })
  }

  // Reset settings
  const resetBtn = document.getElementById("reset-settings")
  if (resetBtn) {
    pageLifecycle.on(resetBtn, "click", async () => {
    const ok = await confirmDialog({
      title: "Reset Settings",
      message: "This will reset ALL settings to their default values.",
      variant: "warning",
      confirmText: "Reset All",
    })
    if (!ok) return
    try {
      const res = await fetch(
        (window.__ingress_path || "") + "/api/settings?reset=all",
        { method: "DELETE", signal: pageLifecycle.signal },
      )
      if (res.ok) {
        showToast("settings.reset_success")
        settingsStore.invalidate()
        // Full reload required — every setting (theme, locale, sidebar, integrations) changed
        setTimeout(() => {
          if (pageLifecycle.signal.aborted) return
          window.location.reload()
        }, 1000)
      } else showToast("settings.reset_failed", "error")
    } catch {
      showToast("common.network_error", "error")
    }
    })
  }
}
