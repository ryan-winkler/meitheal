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
import { isDoneStatus } from "../status-config"
import { openTaskDetailHandoff } from "../task-detail-handoff"
import { lockTodayTaskStatus, syncTodayTaskStatus } from "../today-list"

export function setupFocusStack(
  container: HTMLElement,
  lm: ListenerManager,
) {
  const stack = container.querySelector<HTMLElement>("#section-focus-stack")
  if (!stack) return () => {}
  const header = stack.querySelector<HTMLElement>(".focus-stack__header")
  const count = header?.querySelector(".focus-stack__subtitle")
  const cards = [...stack.querySelectorAll<HTMLElement>(".focus-card[data-id]")]
  const completionTimers = new Map<HTMLElement, number>()

  function renderStack() {
    const remaining = cards.filter(card => !card.hidden && !card.inert).length
    if (count) count.textContent = `${remaining} to focus on`

    const allHidden = cards.every(card => card.hidden)
    header?.toggleAttribute("hidden", remaining === 0)
    const announcement = stack!.querySelector(".focus-stack--cleared")
    if (!allHidden) {
      announcement?.remove()
      return
    }
    if (announcement) return
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
    stack!.append(cleared)
    void import("@lib/celebrations").then(({ celebrateFocusStackClear }) => {
      if (!lm.disposed && cleared.isConnected) celebrateFocusStackClear()
    })
  }
  function settleCard(card: HTMLElement, done: boolean) {
    clearTimeout(completionTimers.get(card))
    completionTimers.delete(card)
    card.hidden = done
    card.inert = false
    card.classList.remove("focus-card--completing")
    renderStack()
  }

  lm.on(container, "meitheal:today-status-committed", event => {
    const { id } = (event as CustomEvent<{ id: string }>).detail
    const card = cards.find(item => item.dataset.id === id)
    if (!card || !isDoneStatus(card.dataset.status ?? "")) return
    if (completionTimers.has(card)) renderStack()
    else settleCard(card, true)
  })

  // ── Complete button handler ──
  lm.on(stack, "click", async (e: Event) => {
    const target = e.target as HTMLElement

    // Complete button
    const completeBtn = target.closest(".focus-card__complete") as HTMLButtonElement | null
    if (completeBtn) {
      e.stopPropagation()
      const id = completeBtn.dataset.id
      const card = completeBtn.closest<HTMLElement>(".focus-card")
      if (!id || !card || card.hidden || card.inert) return

      const unlock = lockTodayTaskStatus(container, id)
      if (!unlock) return
      try {
        const completed = await taskApi.updateTask(id, { status: "complete" })
        if (lm.disposed) return
        showToast("common.task_completed")
        onTaskCompleted(completed)

        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          card.classList.add("focus-card--completing")
          card.inert = true
          completionTimers.set(card, lm.onTimeout(() => settleCard(card, true), 350))
        }
        syncTodayTaskStatus(container, id, "complete")
      } catch {
        showToast("common.failed_update", "error")
      } finally {
        unlock()
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

  return (id: string, row?: HTMLElement) => {
    const card = cards.find(item => item.dataset.id === id)
    if (!card) return
    if (row) {
      const overdue = row.dataset.overdue === "true"
      card.classList.toggle("focus-card--overdue", overdue)
      card.querySelector(".focus-card__due")?.replaceChildren(
        createSpriteIconElement(overdue ? "alert-triangle" : "calendar-event", { size: 12 }),
        row.dataset.focusDueLabel!,
      )
    }
    settleCard(card, !row)
  }
}
