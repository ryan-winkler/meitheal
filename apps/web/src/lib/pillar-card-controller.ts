import type { Principle } from "@domains/pillars/principle-service"
import { pageLifecycle } from "./page-lifecycle"

pageLifecycle.onPageLoad(signal => {
  document.addEventListener("click", event => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-pillar-json] button")
    const card = button?.closest<HTMLElement>("[data-pillar-json]")
    if (!button || !card) return

    if (button.matches("[data-principles-toggle]")) {
      const open = button.getAttribute("aria-expanded") !== "true"
      button.setAttribute("aria-expanded", String(open))
      card.querySelector("[data-principles-list]")?.setAttribute("aria-hidden", String(!open))
      return
    }

    if (button.matches("[data-show-all-toggle]")) {
      const open = button.getAttribute("aria-expanded") !== "true"
      button.setAttribute("aria-expanded", String(open))
      for (const row of card.querySelectorAll("[data-overflow-principle]")) row.setAttribute("aria-hidden", String(!open))
      button.textContent = open ? "Show less" : `Show all ${card.querySelector("[data-principles-count]")?.textContent}`
      return
    }

    const action = button.dataset.action
    if (action !== "open-detail" && action !== "add-principle" && action !== "edit-pillar") return
    const pillar = JSON.parse(card.dataset.pillarJson ?? "{}")
    document.dispatchEvent(new CustomEvent(action === "edit-pillar" ? "edit-pillar" : "open-pillar-detail", {
      detail: { ...pillar, showPrincipleForm: action === "add-principle", opener: button },
    }))
  }, { signal })

  document.addEventListener("pillar-principles-saved", ((event: CustomEvent<{ id: string; principles: Principle[] }>) => {
    const { id, principles } = event.detail
    const card = document.querySelector<HTMLElement>(`[data-pillar-id="${CSS.escape(id)}"]`)
    const list = card?.querySelector("[data-principles-list]")
    const toggle = card?.querySelector<HTMLButtonElement>("[data-principles-toggle]")
    const showAll = card?.querySelector<HTMLButtonElement>("[data-show-all-toggle]")
    const count = card?.querySelector("[data-principles-count]")
    const template = card?.querySelector<HTMLTemplateElement>("[data-principle-row]")
    if (!card || !list || !toggle || !showAll || !count || !template) return

    const pillar = JSON.parse(card.dataset.pillarJson ?? "{}")
    card.dataset.pillarJson = JSON.stringify({ ...pillar, principles })
    count.textContent = String(principles.length)
    toggle.disabled = principles.length === 0
    if (toggle.disabled) {
      toggle.setAttribute("aria-expanded", "false")
      list.setAttribute("aria-hidden", "true")
    }

    const showingAll = showAll.getAttribute("aria-expanded") === "true"
    showAll.hidden = principles.length <= 5
    showAll.textContent = showingAll ? "Show less" : `Show all ${principles.length}`
    list.replaceChildren(...principles.map((principle, index) => {
      const row = template.content.firstElementChild!.cloneNode(true) as HTMLElement
      row.querySelector(".pillar-card__principle-text")!.textContent = principle.statement
      if (principle.isNonNegotiable) row.classList.add("pillar-card__principle--non-negotiable")
      else row.querySelector(".pillar-card__principle-shield")?.remove()
      if (index >= 5) {
        row.classList.add("pillar-card__principle--overflow")
        row.setAttribute("data-overflow-principle", "")
        row.setAttribute("aria-hidden", String(!showingAll))
      }
      return row
    }))
  }) as EventListener, { signal })

  requestAnimationFrame(() => {
    if (signal.aborted) return
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-pillar-json] button[data-action]")) {
      button.disabled = false
    }
  })
})
