/**
 * PillarCard controller — client-side interactions for principles section
 *
 * Handles:
 * - Toggle expand/collapse of principles list
 * - "Show all" / "Show less" toggle for overflow principles
 *
 * Uses pageLifecycle.on() for automatic cleanup on page transitions.
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
    const chevron = toggle?.querySelector<HTMLElement>("[data-principles-chevron]")

    if (!toggle || !list) continue

    // Toggle expand/collapse
    pageLifecycle.on(toggle, "click", (e: Event) => {
      e.preventDefault()
      e.stopPropagation()
      const expanded = toggle.getAttribute("aria-expanded") === "true"
      toggle.setAttribute("aria-expanded", String(!expanded))
      list.setAttribute("aria-hidden", String(expanded))
      if (chevron) {
        chevron.style.transform = expanded ? "" : "rotate(90deg)"
      }
    })

    // Show all / show less toggle
    if (showAllBtn && overflowItems.length > 0) {
      const totalCount = overflowItems.length + list.querySelectorAll("li:not([data-overflow-principle])").length
      let showingAll = false

      pageLifecycle.on(showAllBtn, "click", (e: Event) => {
        e.preventDefault()
        e.stopPropagation()
        showingAll = !showingAll

        for (const item of overflowItems) {
          item.setAttribute("aria-hidden", String(!showingAll))
        }

        showAllBtn.textContent = showingAll
          ? "Show less"
          : `Show all ${totalCount}`
      })
    }
  }
}

pageLifecycle.onPageLoad(init)
