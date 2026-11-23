import type { DashboardSectionId } from "@lib/dashboard-registry"
import { DASHBOARD_LAYOUT_PREFIX, workspaceStorageKey } from "@lib/workspace-preferences"
import { initPageShellSectionTracking } from "@lib/page-shell-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import { quickAddPayload } from "@lib/quick-add"
import { getStatusLabel, isActiveStatus, isClosedStatus, isDoneStatus } from "@lib/status-config"
import { currentTaskApiContext } from "@lib/task-api"
import { taskCapturePlacement } from "@lib/task-capture-placement"
import { boardContextHref, readBoardNavigationContext } from "@lib/board-workspace"
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
function resolveDashboardSectionId(anchorId: string): DashboardSectionId | null {
  const section = document.getElementById(anchorId)?.closest("#dashboard-shell > [data-dashboard-section]")
  return section ? section.id as DashboardSectionId : null
}

function updateActiveSectionState(sectionId?: DashboardSectionId): void {
  document
    .querySelectorAll<HTMLElement>("[data-unified-bar-section]")
    .forEach((link) => {
      const active = !link.hidden && link.dataset.unifiedBarSection === sectionId
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
        "[data-unified-bar-tab]:not([hidden], [data-overflow-hidden])",
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

function initDashboardShell(shell: HTMLElement, reveal: ((id: DashboardSectionId) => void) | undefined): (revealAnchor?: boolean) => void {
  function firstVisible(): DashboardSectionId | undefined {
    return shell.querySelector("[data-dashboard-section]:not([hidden])")?.id as DashboardSectionId | undefined
  }

  const trackLinkedSection = initPageShellSectionTracking(
    document.querySelectorAll<HTMLElement>("[data-dashboard-section]"),
    resolveDashboardSectionId,
    updateActiveSectionState,
  )

  function scrollToDashboardAnchor(anchorId: string): void {
    const target = document.getElementById(anchorId)
    if (!target) return

    const sectionId = resolveDashboardSectionId(anchorId)
    if (sectionId) reveal?.(sectionId)
    trackLinkedSection(sectionId)
    target.scrollIntoView({ block: "start" })
    history.replaceState(history.state, "", `#${anchorId}`)

    if (sectionId) {
      updateActiveSectionState(sectionId)
    }
  }

  function syncDashboardSectionFromHash(reveal = false): void {
    const hash = window.location.hash.replace("#", "")
    const sectionId = hash ? resolveDashboardSectionId(hash) : null
    if (sectionId && reveal) {
      scrollToDashboardAnchor(hash)
      return
    }
    const target = sectionId ? document.getElementById(sectionId) : null
    const linked = target && !target.hidden ? sectionId : null
    const active = linked ?? firstVisible()
    updateActiveSectionState(active)
    trackLinkedSection(active ?? null, linked !== null)
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
      const first = firstVisible()
      trackLinkedSection(first ?? null)
      window.scrollTo({ top: 0 })
      updateActiveSectionState(first)
    })
  }

  initDashboardSectionLinks()
  initDashboardGoToTop()
  initDashboardTabsKeyboard()
  const closeSwitcher = initUnifiedBarTitleSwitcher({
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
  const recalcOverflow = initUnifiedBarTabOverflow(DASHBOARD_BAR_ID)

  pageLifecycle.on(window, "hashchange", () => {
    syncDashboardSectionFromHash(true)
  })

  syncDashboardSectionFromHash()

  const hash = window.location.hash.replace("#", "")
  if (hash) {
    const signal = pageLifecycle.signal
    const initialUrl = window.location.href
    requestAnimationFrame(() => {
      if (!signal.aborted && window.location.href === initialUrl) scrollToDashboardAnchor(hash)
    })
  }
  return (revealAnchor = false) => {
    closeSwitcher?.()
    recalcOverflow?.()
    syncDashboardSectionFromHash(revealAnchor)
  }
}

function initQuickAddForm(): void {
  const form = document.getElementById("quick-add-form") as HTMLFormElement | null
  const input = document.getElementById("quick-title") as HTMLInputElement | null
  const submitBtn = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null
  const taskList = document.getElementById("task-list")
  const openCount = document.getElementById("dashboard-stat-open-count")
  if (!form || !input) return

  pageLifecycle.on(form, "submit", async (event) => {
    event.preventDefault()

    const text = input.value.trim()
    if (!text || submitBtn?.disabled) return
    const { payload } = quickAddPayload(text)
    const captureContext = currentTaskApiContext()
    const placement = taskCapturePlacement()
    if (!captureContext) { showToast("Choose a Board before adding a task.", "error"); return }
    const title = payload.title

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
    taskList?.prepend(newCard)
    input.value = ""

    if (openCount) {
      openCount.textContent = String(Number(openCount.textContent ?? "0") + 1)
    }

    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.classList.add("btn-loading")
      submitBtn.setAttribute("aria-busy", "true")
    }

    try {
      await taskApi.createTask({
        ...payload,
        area_id: placement?.areaId ?? null,
        project_id: placement?.projectId ?? null,
      }, pageLifecycle.signal, captureContext)
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
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.classList.remove("btn-loading")
        submitBtn.setAttribute("aria-busy", "false")
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
      const context = currentTaskApiContext()
      const selected = readBoardNavigationContext(taskBackgroundUrl())
      const navigation = context ? { ...selected, boardId: context.boardId } : null
      const path = value === "all" ? "/tasks" : `/tasks?user=${encodeURIComponent(value)}`
      kanbanLink.href = (window.__ingress_path || "") + (navigation ? boardContextHref(navigation, path) : "/boards")
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

function initDashboardCustomization(shell: HTMLElement, syncShell: (revealAnchor?: boolean) => void) {
  const key = workspaceStorageKey(DASHBOARD_LAYOUT_PREFIX)
  const launcher = document.querySelector<HTMLButtonElement>("#dashboard-bar [data-dashboard-edit]")
  if (!key || !launcher) return

  const signal = pageLifecycle.signal
  let widgets: ReturnType<typeof import("@lib/dashboard-widget-controller").initDashboardWidgets> | undefined
  launcher.hidden = false
  const loadWidgets = () =>
    import("@lib/dashboard-widget-controller").then(({ initDashboardWidgets }) => {
      if (signal.aborted || workspaceStorageKey(DASHBOARD_LAYOUT_PREFIX) !== key) return
      if (!widgets) {
        widgets = initDashboardWidgets(shell, launcher, key, signal, syncShell)
        syncShell(true)
      }
      return widgets
    })

  pageLifecycle.on(document, "click", async event => {
    const control = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-dashboard-edit]") : null
    if (!control) return
    try {
      const customization = await loadWidgets()
      await customization?.openEditor(control)
    } catch {
      if (!signal.aborted) showToast("Dashboard editor couldn’t open. Try again.", "error")
    }
  })

  // Profiles using the default layout keep the server-rendered Dashboard.
  try {
    if (localStorage.getItem(key) !== null) void loadWidgets().catch(() => {
      if (!signal.aborted) showToast("Your saved Dashboard layout couldn’t load. Refresh to try again.", "error")
    })
  } catch {
    // The default layout is usable with storage disabled.
  }
  window.addEventListener("storage", event => {
    if (!widgets && (event.key === key || event.key === null) && event.storageArea === localStorage) {
      void loadWidgets().catch(() => {})
    }
  }, { signal })

  return (id: DashboardSectionId) => widgets?.reveal(id)
}

function bootDashboardPage(): void {
  const shell = document.getElementById("dashboard-shell")
  if (!shell || shell.dataset.dashboardBooted === "true") return

  shell.dataset.dashboardBooted = "true"

  let syncShell: (revealAnchor?: boolean) => void
  const reveal = initDashboardCustomization(shell, revealAnchor => syncShell(revealAnchor))
  syncShell = initDashboardShell(shell, reveal)
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
