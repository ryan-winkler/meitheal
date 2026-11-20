/**
 * Shared Kanban card promotion toggle (Tabler Star button + Context Menu).
 * Keeps promotion state, optimistic feedback, API persistence, and board refresh DRY.
 * @domain kanban
 */
import type { KanbanRefreshFocus } from "./kanban-page-controller"
import { showToast } from "@lib/toast"

export interface PromotionToggleOptions {
  card: HTMLElement
  buildTaskApiUrl: (taskId: string) => string
  refreshBoard: (focus?: KanbanRefreshFocus) => Promise<void>
  pendingPromotions: Set<string>
  signal: AbortSignal
}

export function syncCardPromotedUi(card: HTMLElement, promoted: boolean): void {
  card.dataset.promoted = String(promoted)
  const star = card.querySelector<HTMLButtonElement>(".kanban-promote-star")
  if (!star) return
  star.setAttribute("aria-pressed", String(promoted))
  const actionLabel = promoted
    ? window.mI18n?.get("kanban.demote_card") ?? "Remove promotion"
    : window.mI18n?.get("kanban.promote_card") ?? "Promote to top"
  const title = card.dataset.title ?? ""
  star.title = actionLabel
  star.setAttribute("aria-label", title ? `${actionLabel}: ${title}` : actionLabel)
}

export async function toggleCardPromotion({
  card,
  buildTaskApiUrl,
  refreshBoard,
  pendingPromotions,
  signal,
}: PromotionToggleOptions): Promise<void> {
  const id = card.dataset.id
  if (!id || pendingPromotions.has(id)) return

  const wasPromoted = card.dataset.promoted === "true"
  const nextPromoted = !wasPromoted
  const lane = card.closest<HTMLElement>(".kanban-column")?.dataset.status

  pendingPromotions.add(id)
  syncCardPromotedUi(card, nextPromoted)
  card.setAttribute("aria-busy", "true")

  try {
    const response = await fetch(buildTaskApiUrl(id), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_promoted: nextPromoted }),
      signal,
    })
    if (!response.ok) throw new Error("Promotion rejected")
    if (signal.aborted) return

    showToast(nextPromoted
      ? window.mI18n?.get("kanban.card_promoted") ?? "Promoted to the top of the lane"
      : window.mI18n?.get("kanban.card_demoted") ?? "Promotion removed")
    await refreshBoard(lane ? { taskId: id, lane, firstPage: nextPromoted } : { taskId: id })
  } catch {
    if (card.isConnected) syncCardPromotedUi(card, wasPromoted)
    if (!signal.aborted) {
      showToast(window.mI18n?.get("kanban.promotion_failed") ?? "Couldn’t save the promotion. Try again.", "error")
    }
  } finally {
    pendingPromotions.delete(id)
    if (card.isConnected) card.removeAttribute("aria-busy")
  }
}
