import { getRememberedAreaId, getSelectedAreaId } from "@lib/area-selector-controller"
import { replaceTaskBackgroundUrl, taskBackgroundUrl } from "@lib/task-page-url"
import { TASK_REFRESH_FRAGMENT_HEADER } from "@lib/task-view-route"
import { findKanbanDetailFocus } from "@lib/task-detail-handoff"
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
  afterSave?: "status" | "lane-move" | "epic" | "board-group"
}

export function findGroupFocus(board: HTMLElement, group: HTMLElement) {
  const laneId = group.closest<HTMLElement>(".kanban-column")?.dataset.laneId
  const key = group.dataset.swimlaneType
  const lane = laneId && board.querySelector(`.kanban-column[data-lane-id="${CSS.escape(laneId)}"]`)
  const target = lane && [...lane.querySelectorAll<HTMLElement>(".swimlane-group")]
    .find(candidate => key !== undefined && candidate.dataset.swimlaneType === key)
  return (target && target.querySelector<HTMLElement>(".swimlane-header")) ||
    (lane || board).querySelector<HTMLElement>(".kanban-column-header")
}

function carryCardBlockSizes(current: HTMLElement, replacement: HTMLElement): void {
  const cards = current.querySelectorAll<HTMLElement>(".kanban-card[data-id]")
  const first = cards[0]
  if (!first || getComputedStyle(first).contentVisibility !== "auto") return

  const sizes = new Map<string, number>()
  for (const card of cards) {
    const height = card.offsetHeight
    if (!height || !card.dataset.id) continue
    const style = getComputedStyle(card)
    const blockSize = height - parseFloat(style.paddingBlockStart) - parseFloat(style.paddingBlockEnd)
      - parseFloat(style.borderBlockStartWidth) - parseFloat(style.borderBlockEndWidth)
    if (blockSize > 0) sizes.set(card.dataset.id, blockSize)
  }
  for (const card of replacement.querySelectorAll<HTMLElement>(".kanban-card[data-id]")) {
    const blockSize = sizes.get(card.dataset.id ?? "")
    if (blockSize !== undefined) card.style.setProperty("--kanban-card-block-size", `${blockSize}px`)
  }
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
  if (initialArea && !desired.searchParams.has("area") &&
      document.querySelector<HTMLElement>("#area-selector-dropdown")?.dataset.areaCatalogReady === "false") {
    // Do not display the unfiltered SSR page while a remembered scope cannot be verified.
    board.style.visibility = "hidden"
    const total = shell.querySelector("[data-kanban-visible-count]")
    if (total) total.textContent = "…"
  }

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

  function queueMoveRefresh(focus?: KanbanRefreshFocus) {
    if (signal.aborted || (!focus && queuedBackgroundRead?.focus?.taskId)) return
    queueBackgroundRead({ ...focus, afterSave: "lane-move" })
  }

  async function load(url: URL, focus?: KanbanRefreshFocus, reset = false, dataOnly = false): Promise<void> {
    pending?.abort()
    const request = new AbortController()
    pending = request
    desired = url
    lastFocus = focus
    resetScroll = reset
    const origin = location.href
    const requestedFocus = document.activeElement
    let focusMoved = false
    const focusLifetime = new AbortController()
    const markFocusMoved = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest("[data-board-verification]")) return
      if (target !== requestedFocus && target !== document.body) focusMoved = true
    }
    document.addEventListener("focusin", markFocusMoved, { signal: focusLifetime.signal })
    document.addEventListener("pointerdown", markFocusMoved, { signal: focusLifetime.signal })
    const statusSaved = focus?.afterSave === "status" || focus?.afterSave === "lane-move"
    board.setAttribute("aria-busy", "true")
    if (!dataOnly) renderStatus(window.mI18n?.get("kanban.board_loading") ?? "Loading board…")

    try {
      const requestUrl = new URL(url)
      requestUrl.hash = ""
      // Older installed service workers can serve cached HTML to fetch(), even with no-store.
      requestUrl.searchParams.set("boardRefresh", `${performance.timeOrigin}-${++requestNumber}`)
      const response = await fetch(requestUrl, { // nosemgrep
        headers: { [TASK_REFRESH_FRAGMENT_HEADER]: "1" },
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

      const nowFocused = document.activeElement
      const active = !focusMoved && (nowFocused === document.body || (nowFocused instanceof Element && nowFocused.closest("[data-board-verification]"))) ? requestedFocus : nowFocused
      const grouping = board.dataset.groupBy
      const activeGroup = (grouping === "assigned" || grouping === "status" || grouping === "project") && board.contains(active) &&
        active?.matches("button.swimlane-header") ? active.closest<HTMLElement>(".swimlane-group") : null
      const activeInBoard = active instanceof HTMLElement && board.contains(active)
      const laneMove = focus?.afterSave === "lane-move"
      const focusMovedCard = laneMove && focus.taskId &&
        (active === document.body || (activeInBoard && active.closest<HTMLElement>(".kanban-card")?.dataset.id === focus.taskId))
      const shouldFocus = active === retry || (laneMove
        ? focusMovedCard
        : activeInBoard || (focus && (!focus.afterSave || statusSaved) && active === document.body))
      const previousControl = activeInBoard && !focusMovedCard && (focus?.afterSave || grouping === "project") ? active : null
      const scroll = new Map(Array.from(board.querySelectorAll<HTMLElement>(".kanban-column"), lane =>
        [lane.dataset.status, lane.querySelector(".kanban-cards")?.scrollTop ?? 0] as const))
      const horizontal = board.scrollLeft
      for (const cssClass of board.classList) {
        if (cssClass.startsWith("density-") || cssClass.startsWith("hide-field-")) replacement.classList.add(cssClass)
      }

      if (!reset && (window.scrollY > 0 || [...scroll.values()].some(top => top > 0))) {
        // A replacement loses each card's remembered intrinsic height. Seed matching cards
        // with the current size so they keep their place when results refresh while scrolled.
        carryCardBlockSizes(board, replacement)
      }
      boardLifetime.abort()
      board.replaceWith(replacement)
      board = replacement
      boardLifetime = new AbortController()
      initKanbanArea(boardLifetime.signal, refresh, queueMoveRefresh)
      void hydrateTaskAssignees(board, boardLifetime.signal)
      initKanbanReactionCounts(board, boardLifetime.signal)
      initKanbanInactivity(board, boardLifetime.signal)
      bindBoardScrollTrack(board, boardLifetime.signal)

      const total = shell?.querySelector("[data-kanban-visible-count]")
      const label = shell?.querySelector("[data-kanban-visible-label]")
      if (total) total.textContent = html.querySelector("[data-kanban-visible-count]")?.textContent ?? ""
      if (label) label.textContent = html.querySelector("[data-kanban-visible-label]")?.textContent ?? ""
      const projectNotice = shell?.querySelector<HTMLElement>("[data-project-catalog-unavailable]")
      if (projectNotice) {
        projectNotice.hidden = html.querySelector("[data-project-catalog-unavailable]")?.hasAttribute("hidden") !== false
      }
      const promotedNote = shell?.querySelector<HTMLElement>("[data-kanban-promoted-note]")
      if (promotedNote) promotedNote.hidden = html.querySelector("[data-kanban-promoted-note]")?.hasAttribute("hidden") !== false
      for (const lane of board.querySelectorAll<HTMLElement>(".kanban-column")) {
        if (lane.dataset.status) setKanbanPage(url, lane.dataset.status, Number(lane.dataset.page))
        const list = lane.querySelector(".kanban-cards")
        const revealDestination = lane.dataset.status === focus?.lane && (!laneMove || focusMovedCard)
        if (list && !reset && !revealDestination) list.scrollTop = scroll.get(lane.dataset.status) ?? 0
      }
      // A view or task-detail navigation can change the hash while a board request is in flight.
      url.hash = taskBackgroundUrl().hash
      if (!dataOnly) replaceTaskBackgroundUrl(url)
      board.scrollLeft = horizontal
      renderStatus("")

      const retainedControl = previousControl && findKanbanDetailFocus(board, previousControl)
      if (activeGroup && board.dataset.groupBy === grouping) {
        findGroupFocus(board, activeGroup)?.focus({ preventScroll: true })
      } else if ((shouldFocus || (laneMove && retainedControl)) &&
        (retainedControl || (!dataOnly && (focus || active === retry)))) {
        const lane = focus?.lane ? board.querySelector<HTMLElement>(`.kanban-column[data-status="${CSS.escape(focus.lane)}"]`) : null
        const card = focus?.taskId ? (lane || board).querySelector<HTMLElement>(
          `.kanban-card[data-id="${CSS.escape(focus.taskId)}"] .card-more-btn`,
        ) : null
        const target = retainedControl || card
        const collapsedGroup = target?.closest(".swimlane-cards[hidden]")?.closest(".swimlane-group")
        const control = collapsedGroup ? collapsedGroup.querySelector<HTMLButtonElement>(".swimlane-header") : target
        const range = lane && (lane.querySelector<HTMLElement>("[data-kanban-range]") ??
          lane.querySelector<HTMLElement>(".kanban-column-header"))
        const destination = control || range || board.querySelector<HTMLElement>(".kanban-column-header")
        destination?.focus({ preventScroll: Boolean(laneMove && retainedControl) })
      }
    } catch {
      if (!request.signal.aborted && !signal.aborted) {
        const message = window.mI18n?.get("kanban.board_load_failed") ?? "Couldn’t load the board."
        renderStatus(statusSaved ? `Status saved. ${message}` : message, true)
      }
    } finally {
      focusLifetime.abort()
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
    const resetPage = updateKanbanFilters(url, next, true)
    if (url.search !== before) void load(url, undefined, resetPage)
  }

  const scrollWrap = shell.querySelector<HTMLElement>("[data-kanban-scroll-wrap]")
  const scrollLeftBtn = scrollWrap?.querySelector<HTMLButtonElement>('[data-kanban-scroll="left"]')
  const scrollRightBtn = scrollWrap?.querySelector<HTMLButtonElement>('[data-kanban-scroll="right"]')

  function syncHorizontalScrollState() {
    if (!scrollWrap) return
    const maxScroll = Math.max(0, board.scrollWidth - board.clientWidth)
    const canLeft = maxScroll > 6 && board.scrollLeft > 4
    const canRight = maxScroll > 6 && board.scrollLeft < maxScroll - 4
    scrollWrap.dataset.scrollLeft = String(canLeft)
    scrollWrap.dataset.scrollRight = String(canRight)
    if (scrollLeftBtn) scrollLeftBtn.hidden = !canLeft
    if (scrollRightBtn) scrollRightBtn.hidden = !canRight
  }

  function bindBoardScrollTrack(target: HTMLElement, boardSignal: AbortSignal) {
    target.addEventListener("scroll", syncHorizontalScrollState, { passive: true, signal: boardSignal })
    target.addEventListener("wheel", event => {
      if (!event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      if (target.scrollWidth <= target.clientWidth) return
      event.preventDefault()
      target.scrollLeft += event.deltaY
    }, { passive: false, signal: boardSignal })
    requestAnimationFrame(syncHorizontalScrollState)
  }

  const scrollStep = (dir: -1 | 1) => {
    const col = board.querySelector<HTMLElement>(".kanban-column")
    const step = (col?.offsetWidth ?? 304) + 16
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    board.scrollBy({ left: dir * step, behavior: reduced ? "auto" : "smooth" })
  }
  scrollLeftBtn?.addEventListener("click", () => scrollStep(-1), { signal })
  scrollRightBtn?.addEventListener("click", () => scrollStep(1), { signal })
  window.addEventListener("resize", syncHorizontalScrollState, { passive: true, signal })
  const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncHorizontalScrollState) : null
  if (scrollWrap) resizeObserver?.observe(scrollWrap)

  const toolsToggle = document.getElementById("kanban-tools-toggle")
  toolsToggle?.addEventListener("click", () => {
    toolsToggle.setAttribute("aria-expanded", String(toolsToggle.getAttribute("aria-expanded") !== "true"))
  }, { signal })
  initLaneManagementPanel()
  initKanbanArea(boardLifetime.signal, refresh, queueMoveRefresh)
  void hydrateTaskAssignees(board, boardLifetime.signal)
  initKanbanReactionCounts(board, boardLifetime.signal)
  bindBoardScrollTrack(board, boardLifetime.signal)

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
  document.addEventListener("kanban:detail-changed", () => {
    queueBackgroundRead({ afterSave: "board-group" })
  }, { signal })
  document.addEventListener("meitheal:home-assistant-area-saved", () => {
    if (new URLSearchParams(location.search).has("home_assistant_area_id")) void refresh()
  }, { signal })
  document.addEventListener("meitheal:area-catalog-ready", () => {
    if (board.style.visibility !== "hidden" && board.dataset.available === "true") return
    const current = taskBackgroundUrl().searchParams
    if (current.has("area") || current.has("project")) { void refresh(); return }
    const url = new URL(desired)
    const area = getRememberedAreaId()
    const reset = updateKanbanFilters(url, { ...readKanbanFilters(url.searchParams), area }, true)
    syncAreaLinks(area)
    void load(url, undefined, reset)
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
    resizeObserver?.disconnect()
  }, { once: true })
  if (board.dataset.available !== "true") {
    renderStatus(window.mI18n?.get("kanban.board_load_failed") ?? "Couldn’t load the board.", true)
  } else {
    filter(desired.searchParams.has("groupBy") ? {} : { groupBy: storedKanbanGroup() }, initialArea)
    if (!pending) initKanbanInactivity(board, boardLifetime.signal)
  }
}
