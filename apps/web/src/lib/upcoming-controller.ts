import { createClientLogger } from "@lib/client-logger"
import { bindCardPreferencesSync } from "@lib/card-view-sync"
import { onTaskCompleted } from "@lib/gamification-hook"
import { initPageShellNavigation } from "@lib/page-shell-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { taskApi } from "@lib/task-api-client"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { UPCOMING_SECTIONS } from "@lib/upcoming-registry"

const log = createClientLogger("tasks", "upcoming-shell")

export function initUpcomingPage(): void {
  const shell = document.getElementById("upcoming-shell")
  initPageShellNavigation({
    barId: "upcoming-bar",
    shellId: "upcoming-shell",
    sectionSelector: "[data-upcoming-section]",
    sectionIds: UPCOMING_SECTIONS.map((section) => section.id),
    defaultSectionId: "upcoming-overview",
    preserveOverviewOnLoad: true,
  })

  bindCardPreferencesSync(shell, pageLifecycle.signal)
  initTaskCheckboxes()
  initPromoteButtons()
  initTaskRowClicks(shell)
  initAccordions()
}

function initPromoteButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".upcoming-promote-btn").forEach((btn) => {
    pageLifecycle.on(btn, "click", async (event) => {
      event.stopPropagation()
      const id = btn.dataset.id
      if (!id || btn.dataset.busy === "true") return
      btn.dataset.busy = "true"
      const current = btn.getAttribute("aria-pressed") === "true"
      const next = !current
      const row = btn.closest<HTMLElement>(".task-item")

      const applyState = (promoted: boolean) => {
        btn.classList.toggle("is-promoted", promoted)
        btn.setAttribute("aria-pressed", String(promoted))
        const label = promoted ? "Remove promotion" : "Promote to top"
        btn.title = label
        btn.setAttribute("aria-label", label)
        if (row) {
          row.dataset.promoted = String(promoted)
          const labelsWrap = row.querySelector<HTMLElement>(".task-labels")
          const existingPill = labelsWrap?.querySelector<HTMLElement>(".task-promoted-pill")
          if (promoted && labelsWrap && !existingPill) {
            const pill = document.createElement("span")
            pill.className = "task-promoted-pill"
            pill.textContent = "Promoted"
            labelsWrap.prepend(pill)
          } else if (!promoted && existingPill) {
            existingPill.remove()
          }
        }
      }

      applyState(next)
      try {
        await taskApi.updateTask(id, { is_promoted: next })
        showToast(next ? "common.promoted" : "common.demoted")
      } catch (error) {
        applyState(current)
        log.error("Failed to toggle upcoming task promotion", error)
        showToast("common.failed_update", "error")
      } finally {
        delete btn.dataset.busy
      }
    })
  })
}

function initTaskRowClicks(shell: HTMLElement | null): void {
  if (!shell) return
  pageLifecycle.on(shell, "click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    if (!target || event.defaultPrevented || target.closest("a, button, input, label")) return
    const row = target.closest<HTMLElement>(".task-item")
    const id = row?.dataset.id
    if (id) openTaskDetailHandoff(id)
  })
}

function initTaskCheckboxes(): void {
  document.querySelectorAll<HTMLInputElement>(".task-checkbox").forEach((checkbox) => {
    pageLifecycle.on(checkbox, "click", event => {
      if (checkbox.hasAttribute("aria-disabled")) event.preventDefault()
    })
    pageLifecycle.on(checkbox, "change", async () => {
      const id = checkbox.dataset.id
      if (!id || !checkbox.checked || checkbox.hasAttribute("aria-disabled")) return

      checkbox.setAttribute("aria-disabled", "true")
      try {
        const completed = await taskApi.updateTask(id, { status: "complete" })
        onTaskCompleted(completed)
        const item = checkbox.closest<HTMLElement>(".task-item")
        if (!item) return

        item.style.opacity = "0.4"
        setTimeout(() => {
          const availableCheckbox = ".task-checkbox:not([aria-disabled])"
          const nextFocus = item.contains(document.activeElement)
            ? item.nextElementSibling?.querySelector<HTMLElement>(availableCheckbox)
              ?? item.previousElementSibling?.querySelector<HTMLElement>(availableCheckbox)
              ?? item.closest(".day-card--populated")?.querySelector<HTMLElement>(".day-header")
            : undefined
          item.remove()
          nextFocus?.focus()
        }, 800)
      } catch (error) {
        checkbox.checked = false
        checkbox.removeAttribute("aria-disabled")
        log.error("Failed to update upcoming task state", error)
        showToast("common.failed_update", "error")
      }
    })
  })
}

function initAccordions(): void {
  document.querySelectorAll<HTMLElement>(".day-header").forEach((header) => {
    const toggleAccordion = () => {
      const isExpanded = header.getAttribute("aria-expanded") === "true"
      header.setAttribute("aria-expanded", String(!isExpanded))
      const list = header.nextElementSibling
      if (!(list instanceof HTMLElement) || !list.classList.contains("task-list")) {
        return
      }

      list.classList.toggle("collapsed", isExpanded)
      list.inert = isExpanded
    }

    pageLifecycle.on(header, "click", toggleAccordion)
    pageLifecycle.on(header, "keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent
      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
        return
      }

      keyboardEvent.preventDefault()
      toggleAccordion()
    })
  })
}
