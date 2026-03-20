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
  _lm: ListenerManager,
): void {
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
    background: rgba(99, 102, 241, 0.1); border: 1px solid rgba(99, 102, 241, 0.25);
    border-radius: var(--radius-md, 8px); padding: 14px 18px; margin-bottom: 16px;
    display: flex; align-items: center; gap: 12px; font-size: 14px;
  `
  banner.innerHTML = `
    <span style="font-size: 22px;">🌙</span>
    <div style="flex: 1;">
      <strong>Evening Review</strong>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
        ${incompleteTasks.length} task${incompleteTasks.length === 1 ? "" : "s"} still open — snooze what can wait, complete what you can!
      </div>
    </div>
    <button type="button" class="btn btn-sm evening-snooze-all" title="Snooze all to tomorrow"
      style="font-size: 12px;">⏰ Snooze All</button>
    <button type="button" class="btn btn-sm evening-dismiss" title="Dismiss"
      style="font-size: 12px; padding: 4px 8px;">✕</button>
  `

  const statsContainer = container.querySelector("#daily-stats-container")
  if (statsContainer) {
    statsContainer.after(banner)
  }

  banner.querySelector(".evening-dismiss")?.addEventListener("click", () => {
    localStorage.setItem(EVENING_REVIEW_KEY, todayStr!)
    banner.remove()
  })

  banner.querySelector(".evening-snooze-all")?.addEventListener("click", async () => {
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
