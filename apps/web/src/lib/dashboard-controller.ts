import { DASHBOARD_SECTIONS, type DashboardSectionId } from "@lib/dashboard-registry"
import { pageLifecycle } from "@lib/page-lifecycle"
import { taskApi } from "@lib/task-api-client"
import { showToast } from "@lib/toast"
import {
  initUnifiedBarNewTaskButton,
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTitleSwitcher,
  setUnifiedBarSwitcherActiveState,
} from "@lib/unified-bar-controller"

const DASHBOARD_BAR_ID = "dashboard-bar"
const DASHBOARD_SECTION_IDS = new Set(
  DASHBOARD_SECTIONS.map((section) => section.id),
)

function resolveDashboardSectionId(anchorId: string): DashboardSectionId | null {
  const target = document.getElementById(anchorId)
  if (!target) return null

  const maybeSectionId =
    target.closest<HTMLElement>("[data-dashboard-section]")?.id ||
    target.id ||
    null

  if (!maybeSectionId || !DASHBOARD_SECTION_IDS.has(maybeSectionId as DashboardSectionId)) {
    return null
  }

  return maybeSectionId as DashboardSectionId
}

function updateActiveSectionState(sectionId: DashboardSectionId): void {
  document
    .querySelectorAll<HTMLElement>("[data-unified-bar-section]")
    .forEach((link) => {
      const active = link.dataset.unifiedBarSection === sectionId
      link.classList.toggle("is-active", active)
      link.setAttribute("aria-current", active ? "location" : "false")
      link.setAttribute("aria-selected", active ? "true" : "false")
      link.setAttribute("tabindex", active ? "0" : "-1")
    })

  setUnifiedBarSwitcherActiveState(DASHBOARD_BAR_ID, sectionId)
}

function scrollToDashboardAnchor(
  anchorId: string,
  behavior: ScrollBehavior = "smooth",
): void {
  const target = document.getElementById(anchorId)
  if (!target) return

  target.scrollIntoView({ behavior, block: "start" })
  history.replaceState(null, "", `#${anchorId}`)

  const sectionId = resolveDashboardSectionId(anchorId)
  if (sectionId) {
    updateActiveSectionState(sectionId)
  }

  target.classList.add("dashboard-section--flash")
  setTimeout(() => target.classList.remove("dashboard-section--flash"), 1000)
}

function syncDashboardSectionFromHash(): void {
  const hash = window.location.hash.replace("#", "")
  const sectionId = hash ? resolveDashboardSectionId(hash) : null
  updateActiveSectionState(sectionId ?? "dashboard-overview")
}

function initDashboardSectionLinks(): void {
  document
    .querySelectorAll<HTMLElement>("[data-unified-bar-section-link], [data-dashboard-section-link]")
    .forEach((link) => {
      pageLifecycle.on(link, "click", (event) => {
        event.preventDefault()
        const targetId = link.getAttribute("href")?.replace("#", "")
        if (!targetId) return
        scrollToDashboardAnchor(targetId)
      })
    })
}

function initDashboardIntersectionTracking(): void {
  const sections = document.querySelectorAll<HTMLElement>("[data-dashboard-section]")
  if (sections.length === 0) return

  const observer = new IntersectionObserver(
    (entries) => {
      const active = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0]

      if (!active?.target.id) return

      const sectionId = resolveDashboardSectionId(active.target.id)
      if (sectionId) {
        updateActiveSectionState(sectionId)
      }
    },
    {
      rootMargin: "-25% 0px -45% 0px",
      threshold: [0.2, 0.45, 0.7],
    },
  )

  sections.forEach((section) => observer.observe(section))
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  })
}

function initDashboardGoToTop(): void {
  const button = document.getElementById("dashboard-go-top")
  const shell = document.getElementById("dashboard-shell")
  if (!button || !shell) return

  shell.style.position = "relative"

  const sentinel = document.createElement("div")
  sentinel.setAttribute("aria-hidden", "true")
  sentinel.style.cssText =
    "position:absolute;top:420px;width:1px;height:1px;pointer-events:none;"
  shell.appendChild(sentinel)

  const observer = new IntersectionObserver(
    (entries) => {
      const isAboveFold = entries[0]?.isIntersecting ?? true
      button.classList.toggle("is-visible", !isAboveFold)
      button.toggleAttribute("hidden", isAboveFold)
    },
    { threshold: 0 },
  )

  observer.observe(sentinel)
  pageLifecycle.signal.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  })

  pageLifecycle.on(button, "click", () => {
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`)
    window.scrollTo({ top: 0, behavior: "smooth" })
    updateActiveSectionState("dashboard-overview")
  })
}

function initDashboardTabsKeyboard(): void {
  const tabContainer = document.getElementById(`${DASHBOARD_BAR_ID}-tabs`)
  if (!tabContainer) return

  pageLifecycle.on(tabContainer, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key !== "ArrowLeft" && keyboardEvent.key !== "ArrowRight") {
      return
    }

    const visibleTabs = Array.from(
      tabContainer.querySelectorAll<HTMLElement>(
        "[data-unified-bar-tab]:not([data-overflow-hidden])",
      ),
    )
    const currentIndex = visibleTabs.findIndex((tab) => tab === document.activeElement)
    if (currentIndex === -1) return

    keyboardEvent.preventDefault()
    const direction = keyboardEvent.key === "ArrowRight" ? 1 : -1
    const nextIndex = (currentIndex + direction + visibleTabs.length) % visibleTabs.length
    const nextTab = visibleTabs[nextIndex]
    if (!nextTab) return

    nextTab.focus()
    nextTab.click()
  })
}

function initDashboardShell(): void {
  initDashboardSectionLinks()
  initDashboardIntersectionTracking()
  initDashboardGoToTop()
  initDashboardTabsKeyboard()
  initUnifiedBarTitleSwitcher({
    barId: DASHBOARD_BAR_ID,
    onSelect: (sectionId) => {
      scrollToDashboardAnchor(sectionId)
    },
  })
  initUnifiedBarSearchLauncher(DASHBOARD_BAR_ID)
  initUnifiedBarNewTaskButton({
    barId: DASHBOARD_BAR_ID,
    fallbackMessage: "Task modal not ready - try again",
  })
  initUnifiedBarTabOverflow(DASHBOARD_BAR_ID)

  pageLifecycle.on(window, "hashchange", () => {
    syncDashboardSectionFromHash()
  })

  syncDashboardSectionFromHash()

  const hash = window.location.hash.replace("#", "")
  if (!hash) return

  requestAnimationFrame(() => {
    scrollToDashboardAnchor(hash, "auto")
  })
}

function initQuickAddForm(): void {
  const form = document.getElementById("quick-add-form") as HTMLFormElement | null
  const input = document.getElementById("quick-title") as HTMLInputElement | null
  const taskList = document.getElementById("task-list")
  const openCount = document.getElementById("dashboard-stat-open-count")
  if (!form || !input || !taskList) return

  pageLifecycle.on(form, "submit", async (event) => {
    event.preventDefault()

    const title = input.value.trim()
    if (!title) return

    const emptyState = taskList.querySelector(".bento-empty-state")
    if (emptyState) emptyState.remove()

    const newCard = document.createElement("div")
    newCard.className = "bento-card"
    newCard.style.borderLeft = "3px solid #eab308"

    const body = document.createElement("div")
    body.className = "bento-card-body"

    const titleEl = document.createElement("div")
    titleEl.className = "bento-card-title"
    titleEl.textContent = title

    const footer = document.createElement("div")
    footer.className = "bento-card-footer"

    const badge = document.createElement("span")
    badge.className = "task-badge badge-pending"
    badge.textContent = "Pending"
    footer.appendChild(badge)

    body.append(titleEl, footer)
    newCard.append(body)
    newCard.style.animation = "fade-in 300ms ease"
    taskList.prepend(newCard)
    input.value = ""

    if (openCount) {
      openCount.textContent = String(Number(openCount.textContent ?? "0") + 1)
    }

    try {
      const areaId = window.__activeArea ?? "default"
      await taskApi.createTask({
        title,
        area_id: areaId === "all" ? "default" : areaId,
      })
      showToast("common.task_created")
      form.classList.add("flash-success")
      setTimeout(() => form.classList.remove("flash-success"), 600)
    } catch (error) {
      showToast((error as Error).message || "common.failed_create", "error")
      newCard.remove()
      if (openCount) {
        openCount.textContent = String(Math.max(0, Number(openCount.textContent ?? "1") - 1))
      }
    }
  })
}

function initOpenTaskFilter(): void {
  const openSelect = document.getElementById("my-open-user-filter") as HTMLSelectElement | null
  const openList = document.getElementById("my-open-list")
  const openCount = document.getElementById("my-open-count")
  const titleEl = document.getElementById("open-tasks-title")
  const kanbanLink = document.getElementById("kanban-link") as HTMLAnchorElement | null
  if (!openSelect || !openList) return

  // Capture narrowed references for use in closures (TS can't narrow across function boundaries)
  const select = openSelect
  const list = openList

  function applyOpenFilter(): void {
    const value = select.value
    let visible = 0

    list
      .querySelectorAll<HTMLElement>(".task-item[data-assigned]")
      .forEach((item) => {
        const assigned = item.dataset.assigned || ""
        let show = true

        if (value === "__unassigned__") show = !assigned
        else if (value !== "all") show = assigned === value

        item.style.display = show ? "" : "none"
        if (show) visible += 1
      })

    if (openCount) {
      openCount.textContent = `${visible} open task${visible !== 1 ? "s" : ""}`
    }

    if (titleEl) {
      if (value === "all" || value === "__unassigned__") {
        titleEl.textContent = "Focus Queue"
      } else {
        const selectedOption = select.options[select.selectedIndex]
        const name = selectedOption?.textContent || value
        titleEl.textContent = `${name}'s Queue`
      }
    }

    if (kanbanLink) {
      const ingressPath = window.__ingress_path || ""
      kanbanLink.href =
        value === "all"
          ? `${ingressPath}/tasks`
          : `${ingressPath}/tasks?user=${encodeURIComponent(value)}`
    }
  }

  taskApi
    .listUsers()
    .then((users: Array<{ id: string; display_name?: string; name?: string }>) => {
      users.forEach((user) => {
        const option = document.createElement("option")
        option.value = user.id
        option.textContent = user.display_name || user.name || user.id
        select.appendChild(option)
      })

      const unassignedOption = document.createElement("option")
      unassignedOption.value = "__unassigned__"
      unassignedOption.textContent = "Unassigned"
      select.appendChild(unassignedOption)

      const saved = localStorage.getItem("meitheal-dashboard-user-filter")
      if (saved) select.value = saved

      applyOpenFilter()
    })
    .catch(() => {})

  pageLifecycle.on(select, "change", () => {
    localStorage.setItem("meitheal-dashboard-user-filter", select.value)
    applyOpenFilter()
  })
}

function initTaskDetailLaunchers(): void {
  pageLifecycle.on(document, "click", (event) => {
    const target = event.target as HTMLElement

    const editButton = target.closest<HTMLElement>(".card-edit-btn")
    if (editButton) {
      event.stopPropagation()
      const taskId = editButton.dataset.id
      if (taskId && typeof window.openTaskDetail === "function") {
        window.openTaskDetail(taskId)
      }
      return
    }

    const taskCard = target.closest<HTMLElement>(".task-item[data-id], .bento-card[data-id]")
    if (!taskCard || target.closest("input, button, a")) return

    const taskId = taskCard.dataset.id
    if (taskId && typeof window.openTaskDetail === "function") {
      window.openTaskDetail(taskId)
    }
  })
}

function bootDashboardPage(): void {
  const shell = document.getElementById("dashboard-shell")
  if (!shell || shell.dataset.dashboardBooted === "true") return

  shell.dataset.dashboardBooted = "true"

  initDashboardShell()
  initQuickAddForm()
  initOpenTaskFilter()
  initTaskDetailLaunchers()
}

bootDashboardPage()

pageLifecycle.onPageLoad(() => {
  try { bootDashboardPage() } catch (e) { console.error("[Meitheal][dashboard] Boot failed", e) }
})
