import type { DashboardSectionId } from "@lib/dashboard-registry"
import { DASHBOARD_LAYOUT_PREFIX, workspaceStorageKey } from "@lib/workspace-preferences"
import { initPageShellSectionTracking } from "@lib/page-shell-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import { fetchQuickAddUsers, quickAddPayload } from "@lib/quick-add"
import { getStatusLabel, isActiveStatus, isClosedStatus, isDoneStatus } from "@lib/status-config"
import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
import { taskCapturePlacement } from "@lib/task-capture-placement"
import { boardContextHref, readBoardNavigationContext } from "@lib/board-workspace"
import { taskApi } from "@lib/task-api-client"
import { hydrateTaskAssignees } from "@lib/task-assignee-display"
import { findKanbanDetailFocus } from "@lib/task-detail-handoff"
import { taskBackgroundUrl } from "@lib/task-page-url"
import { showToast } from "@lib/toast"
import { bindCardPreferencesSync } from "@lib/card-view-sync"
import {
  initUnifiedBarNewTaskButton,
  initUnifiedBarSearchLauncher,
  initUnifiedBarTabOverflow,
  initUnifiedBarTabsKeyboard,
  initUnifiedBarTitleSwitcher,
  syncUnifiedBarSectionState,
} from "@lib/unified-bar-controller"

const DASHBOARD_BAR_ID = "dashboard-bar"
function resolveDashboardSectionId(anchorId: string): DashboardSectionId | null {
  const section = document.getElementById(anchorId)?.closest("#dashboard-shell > [data-dashboard-section]")
  return section ? section.id as DashboardSectionId : null
}

function updateActiveSectionState(sectionId?: DashboardSectionId): void {
  syncUnifiedBarSectionState(DASHBOARD_BAR_ID, sectionId, { checkHidden: true })
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
          const href = link.getAttribute("href")
          const targetId = link instanceof HTMLAnchorElement
            ? (link.pathname === location.pathname ? link.hash.slice(1) : "")
            : (href?.startsWith("#") ? href.slice(1) : "")
          if (!targetId) return
          event.preventDefault()
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
  initUnifiedBarTabsKeyboard(DASHBOARD_BAR_ID)
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
    const users = await fetchQuickAddUsers(pageLifecycle.signal)
    const { payload } = quickAddPayload(text, null, { users })
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
    .listUserDirectory()
    .then((dir) => {
      ;(dir?.users ?? []).forEach((user) => {
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
        const taskList = document.getElementById("task-list")
        const refreshedTasks = html.querySelector('#task-list[data-available="true"]')
        if (taskList && refreshedTasks) {
          const active = document.activeElement
          const previousControl = active && taskList.contains(active) ? active : null
          taskList.replaceChildren(...refreshedTasks.childNodes)
          if (previousControl) findKanbanDetailFocus(taskList, previousControl)?.focus({ preventScroll: true })
          void hydrateTaskAssignees(taskList, signal)
          taskList.dispatchEvent(new Event("meitheal:dashboard-cards-updated"))
        }
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

function initTaskDetailLaunchers(onTasksChanged?: () => void): void {
  const signal = pageLifecycle.signal
  const taskList = document.getElementById("task-list")
  const buildTaskApiUrl = (taskId: string | number | null, suffix = "") =>
    taskId === null ? "/api/tasks" : `/api/tasks/${encodeURIComponent(String(taskId))}${suffix}`
  const refreshDashboardCards = async () => { onTasksChanged?.() }

  if (taskList) {
    void hydrateTaskAssignees(taskList, signal)
    void Promise.all([
      import("@lib/controllers/kanban-quick-actions"),
      import("@lib/controllers/kanban-context-menu"),
      import("@lib/controllers/kanban-reaction-counts"),
    ]).then(([quickMod, menuMod, reactionMod]) => {
      if (signal.aborted) return
      let actions = new AbortController()
      const bindCardActions = () => {
        actions.abort()
        actions = new AbortController()
        const cardSignal = AbortSignal.any([signal, actions.signal])
        quickMod.initQuickActions(buildTaskApiUrl, cardSignal, refreshDashboardCards, taskList)
        reactionMod.initKanbanReactionCounts(taskList, cardSignal)
      }
      taskList.addEventListener("meitheal:dashboard-cards-updated", bindCardActions, { signal })
      bindCardActions()
      menuMod.initContextMenu(taskList, buildTaskApiUrl, async () => {}, refreshDashboardCards, signal)
    }).catch(() => {})
  }

  pageLifecycle.on(document, "click", async (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return

    const promoteButton = target.closest<HTMLButtonElement>(".kanban-promote-star, .bento-promote-btn")
    if (promoteButton) {
      event.stopPropagation()
      const taskId = promoteButton.dataset.id
      if (!taskId || promoteButton.disabled) return
      const card = promoteButton.closest<HTMLElement>(".kanban-card, .bento-card")
      const wasPromoted = promoteButton.getAttribute("aria-pressed") === "true"
      const nextPromoted = !wasPromoted
      const applyPromotedState = (promoted: boolean) => {
        promoteButton.setAttribute("aria-pressed", String(promoted))
        const label = promoted ? "Remove promotion" : "Promote to top"
        promoteButton.title = label
        promoteButton.setAttribute("aria-label", label)
        if (card) card.dataset.promoted = String(promoted)
      }
      applyPromotedState(nextPromoted)
      promoteButton.disabled = true
      try {
        await taskApi.updateTask(taskId, { is_promoted: nextPromoted })
        showToast(nextPromoted ? "common.promoted" : "common.demoted")
        onTasksChanged?.()
      } catch {
        applyPromotedState(wasPromoted)
        showToast("common.failed", "error")
      } finally {
        promoteButton.disabled = false
      }
      return
    }

    const aiBtn = target.closest<HTMLButtonElement>(".card-ai-btn")
    if (aiBtn) {
      event.stopPropagation()
      const id = aiBtn.dataset.id ?? aiBtn.closest<HTMLElement>(".kanban-card, .bento-card")?.dataset.id
      if (!id || aiBtn.getAttribute("aria-busy") === "true" || signal.aborted) return
      aiBtn.setAttribute("aria-busy", "true")
      aiBtn.disabled = true
      try {
        const [{ askAIForTask }, { confirmDialog }] = await Promise.all([
          import("@domains/ai/ai-context-service"),
          import("@lib/confirm-dialog"),
        ])
        const result = await askAIForTask(id, signal)
        if (signal.aborted) return
        if (result.source === "ha-assist") {
          await confirmDialog({
            title: "AI Assistant",
            message: result.response,
            confirmText: "Done",
            cancelText: "Close",
            copyPrompt: {
              text: result.response,
              label: "Copy response",
              success: "Copied",
              failure: "Copy failed",
            },
            signal,
          })
        }
      } catch {
        if (!signal.aborted) showToast("settings.ai_handoff_context_failed", "error")
      } finally {
        aiBtn.removeAttribute("aria-busy")
        aiBtn.disabled = false
      }
      return
    }

    const dupBtn = target.closest<HTMLButtonElement>(".card-dup-btn")
    if (dupBtn) {
      event.stopPropagation()
      const id = dupBtn.dataset.id
      if (!id || dupBtn.disabled || signal.aborted) return
      dupBtn.disabled = true
      dupBtn.classList.add("btn-loading")
      try {
        const ctx = currentTaskApiContext()
        const dupRes = await fetch(`/api/tasks/${encodeURIComponent(id)}/duplicate`, {
          method: "POST",
          ...(ctx ? { headers: taskApiHeaders(ctx) } : {}),
          signal,
        })
        if (signal.aborted) return
        if (!dupRes.ok) {
          showToast("Failed to duplicate", "error")
          return
        }
        const dupData = await dupRes.json().catch(() => null) as { id?: string; title?: string } | null
        showToast(dupData?.title ? `Duplicated → ${dupData.title}` : "Task duplicated", "success")
        onTasksChanged?.()
      } catch {
        if (!signal.aborted) showToast("Failed to duplicate", "error")
      } finally {
        dupBtn.disabled = false
        dupBtn.classList.remove("btn-loading")
      }
      return
    }

    const openOrEdit = target.closest<HTMLElement>(".card-open-btn, .card-edit-btn")
    if (openOrEdit) {
      if (event.defaultPrevented || openOrEdit instanceof HTMLAnchorElement) return
      event.stopPropagation()
      const taskId = openOrEdit.dataset.id
      if (taskId && typeof window.openTaskDetail === "function") {
        window.openTaskDetail(taskId)
      }
      return
    }

    const taskCard = target.closest<HTMLElement>(".task-item[data-id], .bento-card[data-id], .kanban-card[data-id]")
    if (!taskCard || target.closest(".kanban-card-actions, input, button, a")) return

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
  bindCardPreferencesSync(shell, pageLifecycle.signal)

  let syncShell: (revealAnchor?: boolean) => void
  const reveal = initDashboardCustomization(shell, revealAnchor => syncShell(revealAnchor))
  syncShell = initDashboardShell(shell, reveal)
  initQuickAddForm()
  const updateOpenQueue = initOpenTaskFilter()
  initTaskDetailLaunchers(updateOpenQueue)
  pageLifecycle.on(document, "meitheal:tasks-changed", () => {
    updateOpenQueue?.()
  })
  pageLifecycle.on(document, "meitheal:task-status-saved", event => {
    const { id, status, deferred } = (event as CustomEvent<{ id: string; status: string; deferred?: boolean }>).detail
    if (typeof status !== "string") return
    const done = isDoneStatus(status)
    for (const card of shell.querySelectorAll<HTMLElement>(`:is(.task-item, .bento-card, .kanban-card)[data-id="${CSS.escape(id)}"]`)) {
      card.toggleAttribute("data-work-active", isActiveStatus(status))
      card.dataset.status = status
      card.querySelector(".kanban-card-title, .bento-card-title")?.classList.toggle("done", done)
      const badge = card.querySelector(".kanban-work-status .status-badge, .task-badge")
      if (!badge) continue
      if (badge.classList.contains("task-badge")) {
        badge.className = "task-badge badge-" + (done ? "complete" : status)
      } else {
        badge.className = "status-badge badge-" + (done ? "complete" : status)
      }
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
