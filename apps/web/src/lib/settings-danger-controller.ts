/**
 * Danger zone settings controller.
 *
 * Handles purge all tasks, reset settings, and data retention deletion.
 * All destructive operations require confirmation dialogs.
 */
import { confirmDialog } from "@lib/confirm-dialog"
import { promptDialog } from "@lib/prompt-dialog"
import { pageLifecycle } from "@lib/page-lifecycle"
import { settingsStore } from "@lib/settings-store"
import { showToast } from "@lib/toast"

function clearPreviewResult(previewResult: HTMLElement): void {
  previewResult.replaceChildren()
}

function appendPreviewLine(
  previewResult: HTMLElement,
  text: string,
  {
    color,
    strong = false,
    subtle = false,
  }: {
    color?: string
    strong?: boolean
    subtle?: boolean
  } = {},
): void {
  const line = document.createElement("span")
  if (color) line.style.color = color
  if (subtle) {
    line.style.fontSize = "12px"
    line.style.color = "var(--text-muted)"
    line.style.marginTop = "4px"
    line.style.display = "inline-block"
  }
  if (strong) {
    const strongEl = document.createElement("strong")
    strongEl.textContent = text
    line.appendChild(strongEl)
  } else {
    line.textContent = text
  }
  previewResult.appendChild(line)
}

function renderRetentionPreview(
  previewResult: HTMLElement,
  {
    count,
    months,
    cutoffDate,
  }: {
    count: number
    months: number | string
    cutoffDate?: string
  },
): void {
  clearPreviewResult(previewResult)

  if (count === 0) {
    appendPreviewLine(
      previewResult,
      `✅ No completed tasks older than ${months} months. Nothing to delete.`,
      { color: "var(--success)" },
    )
    return
  }

  const lead = document.createElement("span")
  lead.style.color = "var(--warning)"
  lead.append("⚠ ")

  const countStrong = document.createElement("strong")
  countStrong.textContent = String(count)
  lead.appendChild(countStrong)
  lead.append(
    ` completed/archived task${count === 1 ? "" : "s"} last updated before `,
  )

  const cutoffStrong = document.createElement("strong")
  cutoffStrong.textContent = cutoffDate ?? ""
  lead.appendChild(cutoffStrong)
  lead.append(" will be permanently deleted.")

  previewResult.appendChild(lead)
  previewResult.appendChild(document.createElement("br"))
  appendPreviewLine(
    previewResult,
    "This includes their comments, activity logs, and task links.",
    { subtle: true },
  )
}

function renderRetentionDeleteSuccess(
  previewResult: HTMLElement,
  deletedCount: number,
): void {
  clearPreviewResult(previewResult)
  appendPreviewLine(
    previewResult,
    `✅ ${deletedCount} task${deletedCount === 1 ? "" : "s"} permanently deleted.`,
    { color: "var(--success)" },
  )
}

export function initDangerZoneSettings(): void {
  initRetentionSettings()

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
    const typed = await promptDialog({
      title: "Final Confirmation",
      message: "Type YES to confirm purge",
      placeholder: "YES",
      confirmText: "Purge",
      validate: (v) => v.toUpperCase() !== "YES" ? "You must type YES to confirm" : "",
    })
    if (!typed) {
      showToast("settings.purge_cancelled", "error")
      return
    }
    try {
      const res = await fetch(
        "/api/tasks?purge=all",
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
        "/api/settings?reset=all",
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

/**
 * Data retention controls — preview and delete completed/archived tasks by age.
 *
 * Flow: select months → preview count → confirm → delete
 * No automation, no scheduled purge — user-initiated only.
 */
function initRetentionSettings(): void {
  const monthsSelect = document.getElementById("retention-months-select") as HTMLSelectElement | null
  const previewBtn = document.getElementById("retention-preview-btn") as HTMLButtonElement | null
  const deleteBtn = document.getElementById("retention-delete-btn") as HTMLButtonElement | null
  const previewResult = document.getElementById("retention-preview-result")

  if (!monthsSelect || !previewBtn || !deleteBtn || !previewResult) return

  let lastPreviewCount = 0
  let lastPreviewMonths = 0
  let lastCutoffDate = ""

  // Enable preview button when a month is selected
  pageLifecycle.on(monthsSelect, "change", () => {
    previewBtn.disabled = !monthsSelect.value
    deleteBtn.disabled = true
    previewResult.style.display = "none"
    lastPreviewCount = 0
  })

  // Preview: fetch count of tasks that would be deleted
  pageLifecycle.on(previewBtn, "click", async () => {
    const months = monthsSelect.value
    if (!months) return

    previewBtn.disabled = true
    previewBtn.textContent = "⏳ Counting…"

    try {
      const res = await fetch(
        `/api/tasks/delete-completed?months=${months}`,
        { signal: pageLifecycle.signal },
      )
      if (!res.ok) {
        showToast("common.network_error", "error")
        return
      }
      const data = await res.json() as { count: number; months: number; cutoffDate: string }
      lastPreviewCount = data.count
      lastPreviewMonths = data.months
      lastCutoffDate = data.cutoffDate

      if (data.count === 0) {
        renderRetentionPreview(previewResult, {
          count: 0,
          months,
        })
        deleteBtn.disabled = true
      } else {
        renderRetentionPreview(previewResult, {
          count: data.count,
          months: data.months,
          cutoffDate: data.cutoffDate,
        })
        deleteBtn.disabled = false
        deleteBtn.textContent = `🗑 Delete ${data.count} Task${data.count === 1 ? "" : "s"}`
      }
      previewResult.style.display = "block"
    } catch {
      showToast("common.network_error", "error")
    } finally {
      previewBtn.disabled = false
      previewBtn.textContent = "🔍 Preview"
    }
  })

  // Delete: confirm then execute
  pageLifecycle.on(deleteBtn, "click", async () => {
    if (lastPreviewCount === 0) return

    const ok = await confirmDialog({
      title: "Delete Old Completed Tasks",
      message:
        `This will permanently delete ${lastPreviewCount} completed/archived task${lastPreviewCount === 1 ? "" : "s"} ` +
        `last updated before ${lastCutoffDate}.\n\n` +
        `💡 Consider exporting your data first (App & PWA → Export).\n\n` +
        `This action cannot be undone.`,
      variant: "danger",
      confirmText: `Delete ${lastPreviewCount} Task${lastPreviewCount === 1 ? "" : "s"}`,
    })
    if (!ok) return

    deleteBtn.disabled = true
    deleteBtn.textContent = "⏳ Deleting…"

    try {
      const res = await fetch(
        `/api/tasks/delete-completed?months=${lastPreviewMonths}&confirm=true`,
        { method: "DELETE", signal: pageLifecycle.signal },
      )
      if (res.ok) {
        const data = await res.json() as { deleted: number }
        showToast(`Deleted ${data.deleted} old task${data.deleted === 1 ? "" : "s"}`)
        // Reset UI state
        renderRetentionDeleteSuccess(previewResult, data.deleted)
        deleteBtn.disabled = true
        deleteBtn.textContent = "🗑 Delete Tasks"
        lastPreviewCount = 0
        // Reload after delay to update all views
        setTimeout(() => {
          if (pageLifecycle.signal.aborted) return
          window.location.reload()
        }, 1500)
      } else {
        showToast("Deletion failed", "error")
        deleteBtn.disabled = false
        deleteBtn.textContent = `🗑 Delete ${lastPreviewCount} Task${lastPreviewCount === 1 ? "" : "s"}`
      }
    } catch {
      showToast("common.network_error", "error")
      deleteBtn.disabled = false
      deleteBtn.textContent = `🗑 Delete ${lastPreviewCount} Task${lastPreviewCount === 1 ? "" : "s"}`
    }
  })
}
