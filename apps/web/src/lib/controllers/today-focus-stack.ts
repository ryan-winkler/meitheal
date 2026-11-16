/**
 * Today Focus Stack — PRA-02
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * ADHD decision support — top 3 actionable tasks with clear next action.
 * Handles completion animation and full-stack-clear celebration.
 */

import { createSpriteIconElement } from "../../generated/icon-registry"
import type { ListenerManager } from "../managed-listeners"
import { taskApi } from "../task-api-client"
import { showToast } from "../toast"
import { onTaskCompleted } from "../gamification-hook"
import { openTaskDetailHandoff } from "../task-detail-handoff"
import { lockTodayTaskStatus, syncTodayTaskStatus } from "../today-list"

export function setupFocusStack(
  container: HTMLElement,
  lm: ListenerManager,
): void {
  const stack = container.querySelector("#section-focus-stack") as HTMLElement | null
  if (!stack) return

  const hadCards = Boolean(stack.querySelector(".focus-card"))

  function showClearedStack() {
    if (!hadCards || stack!.querySelector(".focus-card, .focus-stack--cleared")) return
    void import("@lib/celebrations").then(({ celebrateFocusStackClear }) => celebrateFocusStackClear())
    const cleared = document.createElement("div")
    cleared.className = "focus-stack--cleared"
    cleared.setAttribute("role", "status")
    cleared.append(createSpriteIconElement("confetti", { size: 32 }))
    const message = document.createElement("div")
    message.className = "focus-stack__cleared-msg"
    message.textContent = "Focus Stack cleared!"
    const detail = document.createElement("div")
    detail.className = "focus-stack__cleared-sub"
    detail.textContent = "Great focus session — take a breath"
    cleared.append(message, detail)
    stack!.replaceChildren(cleared)
  }
  lm.on(container, "meitheal:today-status-committed", showClearedStack)

  // ── Complete button handler ──
  lm.on(stack, "click", async (e: Event) => {
    const target = e.target as HTMLElement

    // Complete button
    const completeBtn = target.closest(".focus-card__complete") as HTMLButtonElement | null
    if (completeBtn) {
      e.stopPropagation()
      const id = completeBtn.dataset.id
      if (!id) return

      const unlock = lockTodayTaskStatus(container, id)
      if (!unlock) return
      const card = completeBtn.closest(".focus-card") as HTMLElement

      try {
        const completed = await taskApi.updateTask(id, { status: "complete" })
        showToast("common.task_completed")
        onTaskCompleted(completed)

        // Animate card out
        card?.classList.add("focus-card--completing")
        syncTodayTaskStatus(container, id, "complete")
        lm.onTimeout(() => {
          card?.remove()
          showClearedStack()
        }, 350)
      } catch {
        showToast("common.failed_update", "error")
      } finally {
        unlock()
        if (card?.classList.contains("focus-card--completing")) completeBtn.disabled = true
      }
      return
    }

    // Click card body → open task detail
    const focusCard = target.closest(".focus-card") as HTMLElement | null
    if (focusCard && !e.defaultPrevented && !target.closest("a")) {
      const taskId = focusCard.dataset.id
      if (taskId) {
        openTaskDetailHandoff(taskId)
      }
    }
  })
}
