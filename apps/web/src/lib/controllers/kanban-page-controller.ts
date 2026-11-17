import { getRememberedAreaId, getSelectedAreaId } from "@lib/area-selector-controller"
import { replaceTaskBackgroundUrl, taskBackgroundUrl } from "@lib/task-page-url"
import { DEFERRAL_RECONCILED, type DeferralReconciliation } from "@lib/deferral-client"
import { initKanbanArea } from "@lib/kanban-controller"
import { hydrateTaskAssignees } from "@lib/task-assignee-display"
import { KANBAN_GROUP_KEY, readKanbanFilters, setKanbanPage, storedKanbanGroup, updateKanbanFilters, type KanbanFilters } from "@lib/kanban-query"
import { initKanbanInactivity } from "./kanban-inactivity"
import { initLaneManagementPanel } from "./kanban-lanes"
import { initKanbanReactionCounts } from "./kanban-reaction-counts"

export interface KanbanRefreshFocus {
  lane?: string | undefined
  taskId?: string | undefined
  firstPage?: boolean
  afterSave?: "status" | "epic"
}

function matchBoardFocus(active: HTMLElement, replacement: HTMLElement) {
  const cardId = active.closest<HTMLElement>(".kanban-card")?.dataset.id
  const laneId = active.closest<HTMLElement>(".kanban-column")?.dataset.status
  const card = cardId && replacement.querySelector<HTMLElement>(`.kanban-card[data-id="${CSS.escape(cardId)}"]`)
  const lane = laneId && replacement.querySelector<HTMLElement>(`.kanban-column[data-status="${CSS.escape(laneId)}"]`)
  const scope = card || lane
  if (!scope) return null
  const matches = Array.from(scope.querySelectorAll<HTMLElement>(active.localName))
    .filter(element => element.className === active.className && element.matches("a[href], button, [tabindex]"))
  return (matches.length === 1 ? matches[0] : null) ||
    (card ? card.querySelector<HTMLElement>(".card-open-btn") : scope.querySelector<HTMLElement>(".kanban-column-header"))
}

export function initKanbanPage(signal: AbortSignal): void {
  const shell = document.getElementById("kanban-shell")
  const initialBoard = shell?.querySelector<HTMLElement>("#kanban-board")
  const status = shell?.querySelector<HTMLElement>("[data-kanban-loading]")
  const retry = shell?.querySelector<HTMLButtonElement>("[data-kanban-retry]")
  if (!shell || !initialBoard || !status || !retry || shell.dataset.kanbanBooted === "true") return
  shell.dataset.kanbanBooted = "true"

  let board = initialBoard
  let boardLifetime = new AbortController()
  let pending: AbortController | undefined
  let desired = taskBackgroundUrl()
  let lastFocus: KanbanRefreshFocus | undefined
  let resetScroll = false
  let requestNumber = 0
  const areaLinks = document.querySelectorAll<HTMLAnchorElement>("[data-deferred-link], [data-inactivity-link]")
  const syncAreaLinks = (area: string) => {
    for (const link of areaLinks) {
      const url = new URL(link.href)
      if (area) url.searchParams.set("area", area)
      else url.searchParams.delete("area")
      link.href = url.href
    }
  }
  const initialArea = desired.searchParams.get("area") ?? (getSelectedAreaId() || getRememberedAreaId())
  syncAreaLinks(initialArea)

  const renderStatus = (message: string, failed = false) => {
    status.hidden = !message
    status.textContent = message
    retry.hidden = !failed
  }

  let queuedBackgroundRead: { focus: KanbanRefreshFocus | undefined; dataOnly: boolean } | undefined

  function boardInteractionActive() {
    return board.querySelector('.kanban-inline-add, [contenteditable="true"], .kanban-card.dragging, .kanban-card[aria-busy="true"], [data-title-saving]') ||
      document.querySelector("#kanban-card-menu:not([hidden]), .quick-action-popover:not([inert])")
  }

  const interactionObserver = new MutationObserver(resumeBackgroundRead)
  function resumeBackgroundRead() {
    if (signal.aborted || !queuedBackgroundRead || pending || boardInteractionActive()) return
    const { focus, dataOnly } = queuedBackgroundRead
    queuedBackgroundRead = undefined
    interactionObserver.disconnect()
    void load(new URL(desired), focus, false, dataOnly)
  }

  function queueBackgroundRead(focus?: KanbanRefreshFocus, dataOnly = false) {
    if (!queuedBackgroundRead || !dataOnly) queuedBackgroundRead = { focus, dataOnly }
    interactionObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["hidden", "inert", "class", "aria-busy", "contenteditable", "data-title-saving"],
    })
    queueMicrotask(resumeBackgroundRead)
  }

  async function load(url: URL, focus?: KanbanRefreshFocus, reset = false, dataOnly = false): Promise<void> {
    pending?.abort()
    const request = new AbortController()
    pending = request
    desired = url
    lastFocus = focus
    resetScroll = reset
    const origin = location.href
    board.setAttribute("aria-busy", "true")
    renderStatus(window.mI18n?.get("kanban.board_loading") ?? "Loading board…")

    try {
      const requestUrl = new URL(url)
      requestUrl.hash = ""
      // Older installed service workers can serve cached HTML to fetch(), even with no-store.
      requestUrl.searchParams.set("boardRefresh", `${performance.timeOrigin}-${++requestNumber}`)
      const response = await fetch(requestUrl, { // nosemgrep
        signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
        cache: "no-store",
      })
      if (!response.ok) throw new Error("Board request failed")
      const html = new DOMParser().parseFromString(await response.text(), "text/html")
      const replacement = html.querySelector<HTMLElement>('#kanban-board[data-available="true"]')
      if (request.signal.aborted || signal.aborted) return
      if (dataOnly && location.href !== origin) {
        renderStatus("")
        return
      }
      if (!replacement) throw new Error("Board response unavailable")
      if ((focus?.afterSave || dataOnly) && (queuedBackgroundRead || boardInteractionActive())) {
        if (!queuedBackgroundRead) queueBackgroundRead(focus, dataOnly)
        renderStatus("")
        return
      }

      const active = document.activeElement
      const shouldFocus = active === retry || board.contains(active) || (focus && focus.afterSave !== "epic" && active === document.body)
      const retainedControl = focus?.afterSave && active instanceof HTMLElement && board.contains(active)
        ? matchBoardFocus(active, replacement) : null
      const scroll = new Map(Array.from(board.querySelectorAll<HTMLElement>(".kanban-column"), lane =>
        [lane.dataset.status, lane.querySelector(".kanban-cards")?.scrollTop ?? 0] as const))
      const horizontal = board.scrollLeft
      for (const cssClass of board.classList) {
        if (cssClass.startsWith("density-") || cssClass.startsWith("hide-field-")) replacement.classList.add(cssClass)
      }

      boardLifetime.abort()
      board.replaceWith(replacement)
      board = replacement
      boardLifetime = new AbortController()
      initKanbanArea(boardLifetime.signal, refresh)
      void hydrateTaskAssignees(board, boardLifetime.signal)
      initKanbanReactionCounts(board, boardLifetime.signal)
      initKanbanInactivity(board, boardLifetime.signal)

      const total = shell?.querySelector("[data-kanban-visible-count]")
      const label = shell?.querySelector("[data-kanban-visible-label]")
      if (total) total.textContent = html.querySelector("[data-kanban-visible-count]")?.textContent ?? ""
      if (label) label.textContent = html.querySelector("[data-kanban-visible-label]")?.textContent ?? ""
      const promotedNote = shell?.querySelector<HTMLElement>("[data-kanban-promoted-note]")
      if (promotedNote) promotedNote.hidden = html.querySelector("[data-kanban-promoted-note]")?.hasAttribute("hidden") !== false
      for (const lane of board.querySelectorAll<HTMLElement>(".kanban-column")) {
        if (lane.dataset.status) setKanbanPage(url, lane.dataset.status, Number(lane.dataset.page))
        const list = lane.querySelector(".kanban-cards")
        if (list && !reset && lane.dataset.status !== focus?.lane) list.scrollTop = scroll.get(lane.dataset.status) ?? 0
      }
      // A view or task-detail navigation can change the hash while a board request is in flight.
      url.hash = taskBackgroundUrl().hash
      if (!dataOnly) replaceTaskBackgroundUrl(url)
      board.scrollLeft = horizontal
      renderStatus("")

      if (!dataOnly && shouldFocus && (focus || active === retry)) {
        const card = focus?.taskId ? board.querySelector<HTMLElement>(`.kanban-card[data-id="${CSS.escape(focus.taskId)}"] .card-more-btn`) : null
        const target = retainedControl || card
        const collapsedGroup = target?.closest(".swimlane-cards[hidden]")?.closest(".swimlane-group")
        const control = collapsedGroup ? collapsedGroup.querySelector<HTMLButtonElement>(".swimlane-header") : target
        const lane = focus?.lane ? board.querySelector<HTMLElement>(`.kanban-column[data-status="${CSS.escape(focus.lane)}"]`) : null
        const range = lane && (lane.querySelector<HTMLElement>("[data-kanban-range]") ??
          lane.querySelector<HTMLElement>(".kanban-column-header"))
        ;(control || range || board.querySelector<HTMLElement>(".kanban-column-header"))?.focus()
      }
    } catch {
      if (!request.signal.aborted && !signal.aborted) {
        const message = window.mI18n?.get("kanban.board_load_failed") ?? "Couldn’t load the board."
        renderStatus(focus?.afterSave === "status" ? `Status saved. ${message}` : message, true)
      }
    } finally {
      if (pending === request) {
        pending = undefined
        board.removeAttribute("aria-busy")
        resumeBackgroundRead()
      }
    }
  }

  function refresh(focus?: KanbanRefreshFocus) {
    const url = new URL(desired)
    if (focus?.lane && focus.firstPage) setKanbanPage(url, focus.lane, 1)
    return load(url, focus)
  }

  function filter(values: KanbanFilters, area = getSelectedAreaId()) {
    const url = new URL(desired)
    const before = url.search
    const previous = readKanbanFilters(url.searchParams)
    const next = { ...previous, ...values, area }
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    updateKanbanFilters(url, next)
    if (url.search !== before) void load(url, undefined, true)
  }

  const toolsToggle = document.getElementById("kanban-tools-toggle")
  toolsToggle?.addEventListener("click", () => {
    toolsToggle.setAttribute("aria-expanded", String(toolsToggle.getAttribute("aria-expanded") !== "true"))
  }, { signal })
  initLaneManagementPanel()
  initKanbanArea(boardLifetime.signal, refresh)
  void hydrateTaskAssignees(board, boardLifetime.signal)
  initKanbanReactionCounts(board, boardLifetime.signal)

  shell.addEventListener("click", event => {
    if (!(event instanceof MouseEvent) || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[data-kanban-page-lane]")
    const lane = link?.dataset.kanbanPageLane
    if (!link || !lane) return
    event.preventDefault()
    void load(new URL(link.href), { lane })
  }, { signal })
  retry.addEventListener("click", () => void load(new URL(desired), lastFocus, resetScroll), { signal })
  shell.addEventListener("kanban:deferral-retry", event => {
    lastFocus = (event as CustomEvent<KanbanRefreshFocus>).detail
    resetScroll = false
    renderStatus(window.mI18n?.get("deferral.verify") ?? "Reload to check the task before trying again.", true)
    retry.focus()
  }, { signal })
  window.addEventListener(DEFERRAL_RECONCILED, event => {
    const { taskId, changedIds, dataOnly } = (event as CustomEvent<DeferralReconciliation>).detail ?? {}
    if (dataOnly) {
      queueBackgroundRead(undefined, true)
      return
    }
    const origin = taskId ? board.querySelector<HTMLElement>(`.kanban-card[data-id="${CSS.escape(taskId)}"]`) : null
    const lane = origin?.closest<HTMLElement>(".kanban-column")?.dataset.status
    const sibling = (origin?.nextElementSibling ?? origin?.previousElementSibling) as HTMLElement | null
    void refresh({ lane, taskId: taskId && !changedIds?.includes(taskId) ? taskId : sibling?.dataset.id })
  }, { signal })
  window.addEventListener("online", () => {
    if (board.dataset.inactivityEnabled === "true") void refresh()
  }, { signal })
  window.addEventListener("pageshow", event => {
    if (event.persisted) void refresh()
  }, { signal })
  document.addEventListener("meitheal:task-hierarchy-changed", () => {
    if (desired.searchParams.get("groupBy") === "epic") queueBackgroundRead({ afterSave: "epic" })
  }, { signal })
  document.addEventListener("meitheal:task-status-saved", event => {
    const { id, status } = (event as CustomEvent<{ id: string; status: string }>).detail
    if (typeof status === "string") queueBackgroundRead({ taskId: id, lane: status, afterSave: "status" })
  }, { signal })
  document.addEventListener("meitheal:area-changed", () => {
    syncAreaLinks(getSelectedAreaId())
    filter({})
  }, { signal })
  document.addEventListener("meitheal:filter-change", event => {
    const { view, ...values } = (event as CustomEvent).detail ?? {}
    if (view !== "kanban") return
    if (typeof values.groupBy === "string") {
      try { localStorage.setItem(KANBAN_GROUP_KEY, values.groupBy) } catch { /* storage unavailable */ }
    }
    filter(values)
  }, { signal })
  signal.addEventListener("abort", () => {
    boardLifetime.abort()
    interactionObserver.disconnect()
  }, { once: true })
  if (board.dataset.available !== "true") {
    renderStatus(window.mI18n?.get("kanban.board_load_failed") ?? "Couldn’t load the board.", true)
  } else {
    filter(desired.searchParams.has("groupBy") ? {} : { groupBy: storedKanbanGroup() }, initialArea)
    if (!pending) initKanbanInactivity(board, boardLifetime.signal)
  }
}
