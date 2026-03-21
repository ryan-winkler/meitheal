/**
 * PillarCard controller — client-side interactions for principles section
 *
 * Handles:
 * - Toggle expand/collapse of principles list
 * - "Show all" / "Show less" toggle for overflow principles
 *
 * Wired via pageLifecycle.onLoad — each card instance is self-contained.
 *
 * @domain pillars
 * @phase 19 — Pillars UX Polish
 */
import { pageLifecycle } from "./page-lifecycle"

function init() {
  const cards = document.querySelectorAll<HTMLElement>("[data-pillar-principles]")
  if (!cards.length) return

  for (const card of cards) {
    const toggle = card.querySelector<HTMLButtonElement>("[data-principles-toggle]")
    const list = card.querySelector<HTMLUListElement>("[data-principles-list]")
    const showAllBtn = card.querySelector<HTMLButtonElement>("[data-show-all-toggle]")
    const overflowItems = card.querySelectorAll<HTMLLIElement>("[data-overflow-principle]")

    if (!toggle || !list) continue

    // Toggle expand/collapse
    toggle.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      const expanded = toggle.getAttribute("aria-expanded") === "true"
      toggle.setAttribute("aria-expanded", String(!expanded))
      list.setAttribute("aria-hidden", String(expanded))
    })

    // Show all / show less toggle
    if (showAllBtn && overflowItems.length > 0) {
      let showingAll = false

      showAllBtn.addEventListener("click", (e) => {
        e.preventDefault()
        e.stopPropagation()
        showingAll = !showingAll

        for (const item of overflowItems) {
          item.setAttribute("aria-hidden", String(!showingAll))
        }

        showAllBtn.textContent = showingAll
          ? "Show less"
          : `Show all ${Number(overflowItems.length) + (list.querySelectorAll("li:not([data-overflow-principle])").length)}`
      })
    }
  }
}

pageLifecycle.onPageLoad(init)
