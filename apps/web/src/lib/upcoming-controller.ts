import { createClientLogger } from "@lib/client-logger"
import { onTaskCompleted } from "@lib/gamification-hook"
import { initPageShellNavigation } from "@lib/page-shell-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import { showToast } from "@lib/toast"
import { taskApi } from "@lib/task-api-client"
import { UPCOMING_SECTIONS } from "@lib/upcoming-registry"

const log = createClientLogger("tasks", "upcoming-shell")

export function initUpcomingPage(): void {
  initPageShellNavigation({
    barId: "upcoming-bar",
    shellId: "upcoming-shell",
    sectionSelector: "[data-upcoming-section]",
    sectionIds: UPCOMING_SECTIONS.map((section) => section.id),
    defaultSectionId: "upcoming-overview",
    flashClass: "page-shell__section--flash",
    sectionLinkSelectors: ["[data-upcoming-section-link]"],
  })

  initTaskCheckboxes()
  initAccordions()
}

function initTaskCheckboxes(): void {
  document.querySelectorAll<HTMLInputElement>(".task-checkbox").forEach((checkbox) => {
    pageLifecycle.on(checkbox, "change", async () => {
      const id = checkbox.dataset.id
      if (!id) return

      try {
        const completed = await taskApi.updateTask(id, {
          status: checkbox.checked ? "complete" : "pending",
        })

        if (!checkbox.checked) return

        onTaskCompleted(completed)
        const item = checkbox.closest(".task-item") as HTMLElement | null
        if (!item) return

        item.style.opacity = "0.4"
        item.style.transition = "opacity 0.3s"
        setTimeout(() => item.remove(), 800)
      } catch (error) {
        checkbox.checked = !checkbox.checked
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
