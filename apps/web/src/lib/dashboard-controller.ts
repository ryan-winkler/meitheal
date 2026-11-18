import { DASHBOARD_SECTIONS, type DashboardSectionId } from "@lib/dashboard-registry"
import { initPageShellSectionTracking } from "@lib/page-shell-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import { quickAddPayload } from "@lib/quick-add"
import { getStatusLabel, isActiveStatus, isClosedStatus, isDoneStatus } from "@lib/status-config"
import { taskApi } from "@lib/task-api-client"
import { taskBackgroundUrl } from "@lib/task-page-url"
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
    })

  setUnifiedBarSwitcherActiveState(DASHBOARD_BAR_ID, sectionId)
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
  const trackLinkedSection = initPageShellSectionTracking(
    document.querySelectorAll<HTMLElement>("[data-dashboard-section]"),
    resolveDashboardSectionId,
    updateActiveSectionState,
  )

  function scrollToDashboardAnchor(anchorId: string): void {
    const target = document.getElementById(anchorId)
    if (!target) return

    const sectionId = resolveDashboardSectionId(anchorId)
    trackLinkedSection(sectionId)
    target.scrollIntoView({ block: "start" })
    history.replaceState(history.state, "", `#${anchorId}`)

    if (sectionId) {
      updateActiveSectionState(sectionId)
    }
  }

  function syncDashboardSectionFromHash(): void {
    const hash = window.location.hash.replace("#", "")
    const sectionId = hash ? resolveDashboardSectionId(hash) : null
    trackLinkedSection(sectionId ?? "dashboard-overview", sectionId !== null)
    updateActiveSectionState(sectionId ?? "dashboard-overview")
  }

  function initDashboardSectionLinks(): void {
    document
      .querySelectorAll<HTMLElement>("[data-unified-bar-section-link]")
      .forEach((link) => {
        pageLifecycle.on(link, "click", (event) => {
          event.preventDefault()
          const targetId = link.getAttribute("href")?.replace("#", "")
          if (!targetId) return
          scrollToDashboardAnchor(targetId)
        })
      })
  }

  function initDashboardGoToTop(): void {
    const button = document.getElementById("dashboard-go-top")
    if (!button) return

    const updateVisibility = () => {
      const visible = window.scrollY > 420
      if (button.hidden === !visible) return
      button.classList.toggle("is-visible", visible)
      button.hidden = !visible
    }

    updateVisibility()
    pageLifecycle.on(window, "scroll", updateVisibility, { passive: true })
    pageLifecycle.on(button, "click", () => {
      history.replaceState(history.state, "", `${window.location.pathname}${window.location.search}`)
      trackLinkedSection("dashboard-overview")
      window.scrollTo({ top: 0 })
      updateActiveSectionState("dashboard-overview")
    })
  }

  initDashboardSectionLinks()
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

  const signal = pageLifecycle.signal
  const initialUrl = window.location.href
  requestAnimationFrame(() => {
    if (!signal.aborted && window.location.href === initialUrl) scrollToDashboardAnchor(hash)
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

    const text = input.value.trim()
    if (!text) return
    const { payload } = quickAddPayload(text)
    const title = payload.title

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
        ...payload,
        area_id: areaId === "all" ? "default" : areaId,
      })
      showToast("common.task_created")
      form.classList.add("flash-success")
      setTimeout(() => form.classList.remove("flash-success"), 600)
    } catch (error) {
      showToast((error as Error).message || "common.failed_create", "error")
      newCard.remove()
      if (!input.value) input.value = text
      if (openCount) {
        openCount.textContent = String(Math.max(0, Number(openCount.textContent ?? "1") - 1))
      }
    }
  })
}

function initOpenTaskFilter(): (() => void) | undefined {
  const openSelect = document.getElementById("my-open-user-filter") as HTMLSelectElement | null
  const openList = document.getElementById("my-open-list")
  const openCount = document.getElementById("my-open-count")
  const empty = document.getElementById("my-open-empty")
  const titleEl = document.getElementById("open-tasks-title")
  const kanbanLink = document.getElementById("kanban-link") as HTMLAnchorElement | null
  if (!openSelect || !openList) return

  // Capture narrowed references for use in closures (TS can't narrow across function boundaries)
  const select = openSelect
  const list = openList
  const signal = pageLifecycle.signal
  let refreshRequest: AbortController | undefined
  let refreshNumber = 0
  let countsAvailable = list.dataset.available === "true"
  let loadFailed = !countsAvailable

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
        show &&= !isClosedStatus(item.dataset.status ?? "")

        item.style.display = show ? "" : "none"
        if (show) visible += 1
      })

    if (empty) {
      empty.textContent = loadFailed ? "Couldn’t refresh open work. Reload to try again." : "No open tasks for this selection."
      empty.hidden = !loadFailed && visible !== 0
    }
    if (openCount) {
      openCount.hidden = !countsAvailable
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
  return () => {
    applyOpenFilter()
    refreshRequest?.abort()
    const request = new AbortController()
    refreshRequest = request
    const lifetime = AbortSignal.any([signal, request.signal, AbortSignal.timeout(10_000)])
    const url = taskBackgroundUrl()
    url.hash = ""
    url.searchParams.set("dashboardQueueRefresh", `${performance.timeOrigin}-${++refreshNumber}`)
    void fetch(url, { signal: lifetime, redirect: "error", cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error("Dashboard request failed")
        const html = new DOMParser().parseFromString(await response.text(), "text/html")
        if (lifetime.aborted) return
        const favorites = document.querySelector<HTMLElement>("#dashboard-favorites")
        const refreshedFavorites = html.querySelector<HTMLElement>('#dashboard-favorites[data-available="true"]')
        if (favorites && refreshedFavorites) {
          favorites.hidden = refreshedFavorites.hidden
          favorites.replaceChildren(...refreshedFavorites.childNodes)
        }
        const replacement = html.querySelector('#my-open-list[data-available="true"]')
        if (!replacement) throw new Error("Open queue unavailable")
        list.replaceChildren(...replacement.childNodes)
        countsAvailable = true
        loadFailed = false
        applyOpenFilter()
      })
      .catch(() => {
        if (signal.aborted || request.signal.aborted) return
        loadFailed = true
        applyOpenFilter()
      })
  }
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
  const updateOpenQueue = initOpenTaskFilter()
  initTaskDetailLaunchers()
  pageLifecycle.on(document, "meitheal:task-status-saved", event => {
    const { id, status, deferred } = (event as CustomEvent<{ id: string; status: string; deferred?: boolean }>).detail
    if (typeof status !== "string") return
    const done = isDoneStatus(status)
    for (const card of shell.querySelectorAll<HTMLElement>(`:is(.task-item, .bento-card)[data-id="${CSS.escape(id)}"]`)) {
      card.toggleAttribute("data-work-active", isActiveStatus(status))
      card.dataset.status = status
      card.querySelector(".bento-card-title")?.classList.toggle("done", done)
      const badge = card.querySelector(".task-badge")
      if (!badge) continue
      badge.className = "task-badge badge-" + (done ? "complete" : status)
      badge.textContent = getStatusLabel(status) + (deferred && card.classList.contains("bento-card")
        ? " · " + (window.mI18n?.get("deferral.title") ?? "Deferred") : "")
    }
    updateOpenQueue?.()
  })
}

bootDashboardPage()

pageLifecycle.onPageLoad(() => {
  try { bootDashboardPage() } catch (e) { console.error("[Meitheal][dashboard] Boot failed", e) }
})
