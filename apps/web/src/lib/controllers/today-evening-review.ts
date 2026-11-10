/**
 * Today Evening Review — G34
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Shows an evening review banner after 6 PM when incomplete tasks exist.
 * Offers "snooze all to tomorrow" or dismiss.
 */

import type { ListenerManager } from "../managed-listeners"
import { taskApi } from "../task-api-client"
import { showToast } from "../toast"

const EVENING_REVIEW_KEY = "meitheal-evening-review-dismissed"

export function setupEveningReview(
  container: HTMLElement,
  lm: ListenerManager,
): void {
  container.querySelector(".evening-review-banner")?.remove()
  const currentHour = new Date().getHours()
  if (currentHour < 18) return // Only show after 6 PM

  // Check if already dismissed today
  const todayStr = new Date().toISOString().split("T")[0]
  const dismissed = localStorage.getItem(EVENING_REVIEW_KEY)
  if (dismissed === todayStr) return

  // Count incomplete tasks
  const incompleteTasks = container.querySelectorAll(".tli:not(.tli--done)")
  if (incompleteTasks.length === 0) return

  const banner = document.createElement("div")
  banner.className = "evening-review-banner"
  banner.style.cssText = `
    background: var(--bg-card); border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px); padding: 12px;
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px;
  `
  banner.innerHTML = `
    <span style="font-size: 20px;" aria-hidden="true">🌙</span>
    <div style="flex: 1 1 12rem; min-width: 0;">
      <strong>Evening Review</strong>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
        ${incompleteTasks.length} task${incompleteTasks.length === 1 ? "" : "s"} still open. Snooze them until tomorrow if needed.
      </div>
    </div>
    <button type="button" class="btn btn-sm evening-snooze-all" title="Snooze all to tomorrow"
      style="font-size: 12px; min-height: 44px;">Snooze All</button>
    <button type="button" class="btn btn-sm evening-dismiss" title="Dismiss"
      aria-label="Dismiss evening review" style="font-size: 12px; padding: 4px 8px; min-height: 44px; min-width: 44px;">✕</button>
  `

  const statsContainer = container.querySelector("#daily-stats-container")
  if (statsContainer) {
    statsContainer.after(banner)
  }

  lm.on(banner.querySelector(".evening-dismiss")!, "click", () => {
    localStorage.setItem(EVENING_REVIEW_KEY, todayStr!)
    banner.remove()
  })

  lm.on(banner.querySelector(".evening-snooze-all")!, "click", async () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = tomorrow.toISOString().split("T")[0]!

    const ids = Array.from(incompleteTasks).map(el =>
      (el as HTMLElement).dataset.id
    ).filter(Boolean) as string[]

    try {
      await Promise.all(ids.map(id => taskApi.updateTask(id, { due_date: dateStr })))
      showToast("common.task_snoozed")
      localStorage.setItem(EVENING_REVIEW_KEY, todayStr!)
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-evening-reschedule" } })), 500)
    } catch {
      showToast("common.failed", "error")
    }
  })
}
