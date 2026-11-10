/**
 * Card actions on the Kanban board, with the same lane move path as drag and drop.
 * @domain kanban
 */
import type { KanbanRefreshFocus } from "./kanban-page-controller"
import { confirmDialog } from "@lib/confirm-dialog"
import { showToast } from "@lib/toast"

export function initContextMenu(
  board: HTMLElement,
  buildTaskApiUrl: (taskId: string) => string,
  moveTask: (card: HTMLElement, lane: HTMLElement) => Promise<void>,
  refreshBoard: (focus?: KanbanRefreshFocus) => Promise<void>,
  signal: AbortSignal,
): void {
  const menu = document.createElement("div")
  menu.id = "kanban-card-menu"
  menu.className = "kanban-context-menu"
  menu.setAttribute("role", "group")
  menu.hidden = true
  document.body.append(menu)

  let trigger: HTMLButtonElement | null = null
  const pendingPromotions = new Set<string>()

  function closeMenu(restoreFocus = false) {
    const previous = trigger
    trigger = null
    menu.hidden = true
    previous?.setAttribute("aria-expanded", "false")
    if (restoreFocus) previous?.focus({ preventScroll: true })
  }

  function positionMenu() {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      closeMenu()
      return
    }

    const gap = 6
    const edge = 8
    const below = window.innerHeight - rect.bottom - gap - edge
    const above = rect.top - gap - edge
    const placeBelow = below >= menu.scrollHeight || below >= above
    menu.style.maxHeight = `${Math.max(0, placeBelow ? below : above)}px`
    const left = getComputedStyle(trigger).direction === "rtl" ? rect.left : rect.right - menu.offsetWidth
    menu.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - menu.offsetWidth - edge))}px`
    menu.style.top = `${placeBelow ? rect.bottom + gap : rect.top - gap - menu.offsetHeight}px`
  }

  function addAction(label: string, run: () => void, destructive = false) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = destructive ? "ctx-item ctx-delete" : "ctx-item"
    button.textContent = label
    button.addEventListener("click", () => {
      closeMenu(true)
      run()
    }, { signal })
    menu.append(button)
  }

  board.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement).closest<HTMLButtonElement>(".card-more-btn")
    const card = btn?.closest<HTMLElement>(".kanban-card")
    const id = card?.dataset.id
    if (!btn || !card || !id) return
    event.stopPropagation()
    if (trigger === btn) {
      closeMenu(true)
      return
    }

    closeMenu()
    trigger = btn
    btn.setAttribute("aria-expanded", "true")
    menu.setAttribute("aria-label", btn.title)
    menu.replaceChildren()

    const current = card.closest<HTMLElement>(".kanban-column")
    const promoted = card.dataset.promoted === "true"
    if (!pendingPromotions.has(id)) {
      const action = promoted
        ? window.mI18n?.get("kanban.demote_card") ?? "Remove promotion"
        : window.mI18n?.get("kanban.promote_card") ?? "Promote to top"
      addAction(action, async () => {
        pendingPromotions.add(id)
        try {
          const response = await fetch(buildTaskApiUrl(id), {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ is_promoted: !promoted }),
            signal,
          })
          if (!response.ok) throw new Error("Promotion rejected")
          if (signal.aborted) return
          showToast(promoted
            ? window.mI18n?.get("kanban.card_demoted") ?? "Promotion removed"
            : window.mI18n?.get("kanban.card_promoted") ?? "Promoted to the top of the lane")
          const lane = current?.dataset.status
          await refreshBoard(lane ? { taskId: id, lane, firstPage: !promoted } : { taskId: id })
        } catch {
          if (!signal.aborted) showToast(window.mI18n?.get("kanban.promotion_failed") ?? "Couldn’t save the promotion. Try again.", "error")
        } finally {
          pendingPromotions.delete(id)
        }
      })
    }

    const label = document.createElement("p")
    label.className = "ctx-heading"
    label.textContent = window.mI18n?.get("kanban.move_to") ?? "Move to"
    menu.append(label)
    for (const lane of board.querySelectorAll<HTMLElement>(".kanban-column")) {
      if (lane === current) continue
      const title = lane.querySelector(".kanban-column-title")?.textContent?.trim()
      if (title) addAction(title, () => { void moveTask(card, lane) })
    }

    addAction(window.mI18n?.get("kanban.delete_task") ?? "Delete task", async () => {
      const confirmed = await confirmDialog({ message: "Delete this task permanently?", variant: "danger", confirmText: "Delete" })
      if (!confirmed) return
      try {
        const res = await fetch(buildTaskApiUrl(id), { method: "DELETE" })
        if (res.ok) {
          const lane = current instanceof HTMLElement ? current.dataset.status : undefined
          showToast("Task deleted")
          await refreshBoard(lane ? { lane } : undefined)
          return
        }
      } catch {
        // Keep the existing card available for retry.
      }
      showToast("Failed to delete task", "error")
    }, true)

    menu.hidden = false
    menu.style.maxHeight = ""
    positionMenu()
    menu.querySelector("button")?.focus({ preventScroll: true })
  }, { signal })

  document.addEventListener("pointerdown", event => {
    const target = event.target as Node
    if (trigger && !menu.contains(target) && !trigger.contains(target)) closeMenu()
  }, { signal })
  document.addEventListener("focusin", event => {
    const target = event.target as Node
    if (trigger && !menu.contains(target) && !trigger.contains(target)) closeMenu()
  }, { signal })
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    } else if (event.key === "Tab") {
      const actions = menu.querySelectorAll("button")
      if (event.shiftKey && event.target === actions[0]) {
        event.preventDefault()
        closeMenu(true)
      } else if (!event.shiftKey && event.target === actions[actions.length - 1]) {
        closeMenu(true)
      }
    }
  }, { signal })
  window.addEventListener("resize", positionMenu, { signal })
  window.addEventListener("scroll", event => {
    if (event.target !== menu) positionMenu()
  }, { signal, capture: true })
  signal.addEventListener("abort", () => {
    closeMenu()
    menu.remove()
  }, { once: true })
}
