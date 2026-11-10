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

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function rememberDismissal(date: string): void {
  try { localStorage.setItem(EVENING_REVIEW_KEY, date) } catch { /* Storage can be blocked in embedded contexts. */ }
}

export function setupEveningReview(
  container: HTMLElement,
  lm: ListenerManager,
): void {
  container.querySelector(".evening-review-banner")?.remove()
  const now = new Date()
  const currentHour = now.getHours()
  if (currentHour < 18) return // Only show after 6 PM

  // Check if already dismissed today
  const todayStr = localDateKey(now)
  try {
    if (localStorage.getItem(EVENING_REVIEW_KEY) === todayStr) return
  } catch { /* Continue the review when storage is unavailable. */ }

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
    rememberDismissal(todayStr)
    banner.remove()
  })

  lm.on(banner.querySelector(".evening-snooze-all")!, "click", async () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateStr = localDateKey(tomorrow)

    const ids = Array.from(incompleteTasks).map(el =>
      (el as HTMLElement).dataset.id
    ).filter(Boolean) as string[]

    try {
      await Promise.all(ids.map(id => taskApi.updateTask(id, { due_date: dateStr })))
      showToast("common.task_snoozed")
      rememberDismissal(todayStr)
      setTimeout(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "today-evening-reschedule" } })), 500)
    } catch {
      showToast("common.failed", "error")
    }
  })
}
