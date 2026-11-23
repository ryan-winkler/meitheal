/**
 * Today Habits Section — G38/G39
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Handles habit completion and "save task as habit" action
 * in the Today page habits section.
 */

import { createSpriteIconElement } from "../../generated/icon-registry"
import type { ListenerManager } from "../managed-listeners"
import { showToast } from "../toast"
import { onTaskCompleted } from "../gamification-hook"

export function setupHabitsSection(
  container: HTMLElement,
  lm: ListenerManager,
): void {
  const section = container.querySelector("#section-habits")
  if (!section) return

  section.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".habit-card__complete")
    if (!btn || btn.disabled) return

    const card = btn.closest<HTMLElement>(".habit-card")
    if (!card) return

    const habitId = card.dataset.habitId
    if (!habitId) return

    const priorNodes = Array.from(btn.childNodes, node => node.cloneNode(true))
    // Optimistic UI
    btn.disabled = true
    btn.replaceChildren(createSpriteIconElement("check", { size: 14 }), document.createTextNode(" Done"))
    card.classList.add("habit-card--done")

    try {
      const res = await fetch("/api/habits", { signal: lm.signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", templateId: habitId }),
      })
      if (!res.ok) throw new Error("Failed")
      showToast("Routine completed!", "success")

      // Trigger gamification
      try { onTaskCompleted() } catch { /* optional */ }
    } catch {
      btn.disabled = false
      btn.replaceChildren(...priorNodes)
      card.classList.remove("habit-card--done")
      showToast("Failed to complete routine", "error")
    }
  })
}
