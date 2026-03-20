/**
 * Today Focus Stack — PRA-02
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * ADHD decision support — top 3 actionable tasks with clear next action.
 * Handles completion animation and full-stack-clear celebration.
 */

import type { ListenerManager } from "../managed-listeners"
import { taskApi } from "../task-api-client"
import { showToast } from "../toast"
import { onTaskCompleted } from "../gamification-hook"
import { openTaskDetailHandoff } from "../task-detail-handoff"

export function setupFocusStack(
  container: HTMLElement,
  lm: ListenerManager,
): void {
  const stack = container.querySelector("#section-focus-stack") as HTMLElement | null
  if (!stack) return

  const totalCards = stack.querySelectorAll(".focus-card").length
  let completedCards = 0

  // ── Complete button handler ──
  lm.on(stack, "click", async (e: Event) => {
    const target = e.target as HTMLElement

    // Complete button
    const completeBtn = target.closest(".focus-card__complete") as HTMLButtonElement | null
    if (completeBtn) {
      e.stopPropagation()
      const id = completeBtn.dataset.id
      if (!id) return

      completeBtn.disabled = true
      const card = completeBtn.closest(".focus-card") as HTMLElement

      try {
        await taskApi.updateTask(id, { status: "complete" })
        showToast("common.task_completed")
        onTaskCompleted()

        // Animate card out
        card?.classList.add("focus-card--completing")
        completedCards++

        // Also mark in main task list if visible
        const mainCheckbox = container.querySelector(
          `.tli__checkbox[data-id="${id}"]`
        ) as HTMLInputElement | null
        if (mainCheckbox) {
          mainCheckbox.checked = true
          mainCheckbox.closest(".tli")?.classList.add("tli--done")
        }

        setTimeout(() => {
          card?.remove()

          // All cleared → celebration!
          if (completedCards >= totalCards) {
            import("@lib/celebrations").then(({ celebrateFocusStackClear }) => {
              celebrateFocusStackClear()
            })
            // Replace stack content with cleared message
            stack.innerHTML = `
              <div class="focus-stack--cleared">
                <div style="font-size: 32px;">🎉</div>
                <div class="focus-stack__cleared-msg">Focus Stack cleared!</div>
                <div class="focus-stack__cleared-sub">Great focus session — take a breath</div>
              </div>
            `
          }
        }, 350)
      } catch {
        completeBtn.disabled = false
        showToast("common.failed_update", "error")
      }
      return
    }

    // Click card body → open task detail
    const focusCard = target.closest(".focus-card") as HTMLElement | null
    if (focusCard) {
      const taskId = focusCard.dataset.id
      if (taskId) {
        openTaskDetailHandoff(taskId)
      }
    }
  })
}
