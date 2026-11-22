import { currentTaskApiContext, taskApiHeaders, type TaskApiContext } from "./task-api"
import { sameTaskApiContext } from "./task-api-client"
import type { TaskKind } from "@meitheal/domain-tasks"
import { CALENDAR_AREA_APPLIED_EVENT, CALENDAR_AREA_REQUEST_EVENT, getRememberedAreaId } from "@lib/area-selector-controller"
import { CALENDAR_FILTER_STATE_EVENT, readCalendarTaskFilters } from "@lib/calendar-task-filter"
import { createClientLogger } from "@lib/client-logger"
import { calendarEventDay, calendarEventInterval, calendarIntervalOverlaps, calendarOccurrenceStartKey, compareCalendarStarts, formatCalendarEventTime, formatTimeInZone, normalizeCalendarEventSummary, shiftCalendarDay } from "@lib/date"
import { containTabFocus } from "@lib/focus-trap"
import { updateKanbanFilters, type KanbanFilters } from "@lib/kanban-query"
import { createTablerSvgElement, mapEntityEmojiToTabler, type TablerIconName } from "@lib/tabler-svg"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { replaceTaskBackgroundUrl, taskBackgroundUrl } from "@lib/task-page-url"
import { getStatusDef } from "@lib/status-config"

interface CalendarEventRecord {
  summary: string
  start: string
  entity: string
  end?: string
  uid?: string
}

interface LinkedCalendarEvent {
  id: string
  title: string
  start: string
  entity: string | null
  uid: string | null
  providerSummary: string | null
}

const log = createClientLogger("tasks", "calendar-shell")
const loading = "Loading…"
// Node's 16 KiB request-header limit also includes the request target and
// browser headers. Leave room for ingress headers and the refresh marker.
const monthTargetLimit = 14_000
const dayButton = ".cal-cell[role=button]"

export function initCalendarPage(signal: AbortSignal): void {
  const byId = (id: string) => document.getElementById(id)
  const shell = byId("calendar-shell")
  if (!shell) return
  const initialMonth = shell.querySelector<HTMLElement>("[data-calendar-month]")
  const status = shell.querySelector<HTMLElement>("[data-calendar-status]")
  const retry = shell.querySelector<HTMLButtonElement>("[data-calendar-retry]")
  const ruleError = shell.querySelector<HTMLElement>("[data-calendar-rule-error]")
  const drawer = byId("day-drawer")
  const closeButton = byId("day-drawer-close")
  const panel = drawer?.querySelector<HTMLElement>('[role="dialog"]')
  const drawerTitle = byId("day-drawer-title")
  const drawerEvents = byId("day-drawer-event-items")
  const drawerTasks = byId("day-drawer-task-items")
  const drawerEventStatus = byId("day-drawer-event-status")
  const drawerTaskStatus = byId("day-drawer-task-status")
  const queryMoreTasks = byId("day-drawer-more-tasks") as HTMLButtonElement | null
  const eventsSection = drawer?.querySelector<HTMLElement>("[data-calendar-events-section]")
  if (!initialMonth || !status || !retry || !drawer || !panel || !closeButton || !drawerTitle ||
    !drawerEvents || !drawerTasks || !drawerEventStatus || !drawerTaskStatus ||
    !queryMoreTasks || !eventsSection || shell.dataset.calendarReady === "true") return
  const moreTasks = queryMoreTasks

  shell.dataset.calendarReady = "true"
  const calendarContext = currentTaskApiContext()
  let timezone = shell.dataset.timezone || "Europe/Dublin"
  let month = initialMonth
  let desired = taskBackgroundUrl()
  let applied = new URL(desired)
  let retryTarget = initialMonth.dataset.calendarAvailable === "false" ? new URL(applied) : undefined
  let refreshRequest: AbortController | undefined
  let previewsRequest: AbortController | undefined
  let drawerRequest: AbortController | undefined
  let drawerDate = ""
  let drawerFocusFrame = 0
  let loadMoreDueTasks: (() => void) | undefined
  let previousOverflow = ""
  let refreshCount = 0
  let rejectedFilterChange = ""
  let calendarSources: Promise<string[]> | undefined
  const readCalendarSources = () => calendarSources ??= fetchCalendarEntities(
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  ).finally(() => {
    calendarSources = undefined
  })

  function announce(message: string) {
    status!.hidden = !message
    status!.textContent = message
    retry!.hidden = !retryTarget
  }

  let dayViewRequest: AbortController | undefined

  function createSkeletonRows(count = 2): HTMLElement[] {
    return Array.from({ length: count }, (_, idx) => {
      const row = document.createElement("div")
      row.className = idx === count - 1 ? "cal-skeleton-row cal-skeleton-row--short" : "cal-skeleton-row"
      row.setAttribute("aria-hidden", "true")
      return row
    })
  }

  function createEmptyNotice(title: string, hint: string): HTMLElement {
    const box = document.createElement("div")
    box.className = "cal-empty-state"
    box.append(createTablerSvgElement("calendar", 22))
    const heading = document.createElement("span")
    heading.className = "cal-empty-state__title"
    heading.textContent = title
    const sub = document.createElement("span")
    sub.textContent = hint
    box.append(heading, sub)
    return box
  }

  function hydrateDayView() {
    dayViewRequest?.abort()
    const dayHost = month.querySelector<HTMLElement>("[data-cal-day-view]")
    const date = dayHost?.dataset.calDayView
    if (!dayHost || !date) return
    const context = currentTaskApiContext()
    if (!context || !calendarContext || context.boardId !== calendarContext.boardId || context.actorKey !== calendarContext.actorKey) return

    const tasksEl = dayHost.querySelector<HTMLElement>("#cal-day-view-tasks")
    const taskStatusEl = dayHost.querySelector<HTMLElement>("#cal-day-view-task-status")
    const eventsEl = dayHost.querySelector<HTMLElement>("#cal-day-view-events")
    const eventStatusEl = dayHost.querySelector<HTMLElement>("#cal-day-view-event-status")
    if (!tasksEl || !taskStatusEl) return

    const req = new AbortController()
    dayViewRequest = req
    const linked = AbortSignal.any([signal, req.signal, AbortSignal.timeout(10_000)])
    const filters = new URLSearchParams([...applied.searchParams].filter(([key]) => agendaFilterKeys.has(key))).toString()
    const showEvents = month.dataset.calendarEvents === "true" && Boolean(eventsEl && eventStatusEl)

    tasksEl.setAttribute("aria-busy", "true")
    tasksEl.replaceChildren(...createSkeletonRows(3))
    taskStatusEl.textContent = ""

    let liveEvents: Awaited<ReturnType<typeof loadCalendarRange>> | undefined
    let persistedEvents: LinkedCalendarEvent[] | null | undefined

    const renderDayEvents = () => {
      if (!showEvents || !eventsEl || !eventStatusEl) return
      if (liveEvents === undefined && persistedEvents === undefined) return
      const rows: Array<{ start: string; row: HTMLElement }> = (persistedEvents ?? []).map(event => ({
        start: event.start,
        row: agendaItem("calendar-event", event.title, formatCalendarEventTime(event.start, timezone) || "All day", event.id),
      }))
      for (const event of distinctLiveCalendarEvents(liveEvents?.events ?? [], persistedEvents ?? [], timezone)) {
        rows.push({
          start: event.start,
          row: agendaItem("calendar-event", event.summary, formatCalendarEventTime(event.start, timezone) || "All day"),
        })
      }
      rows.sort((a, b) => compareCalendarStarts(a.start, b.start, timezone))
      eventsEl.removeAttribute("aria-busy")
      if (rows.length) {
        eventsEl.replaceChildren(...rows.map(item => item.row))
        eventStatusEl.textContent = ""
      } else if (liveEvents && persistedEvents !== undefined) {
        eventsEl.replaceChildren(createEmptyNotice("No connected events", "Connected Home Assistant calendar events for this day appear here."))
        eventStatusEl.textContent = ""
      }
    }

    if (showEvents && eventsEl && eventStatusEl) {
      eventsEl.setAttribute("aria-busy", "true")
      eventsEl.replaceChildren(...createSkeletonRows(2))
      const ranges = dayHost.dataset.dayRanges
      void loadCalendarRange(date, shiftCalendarDay(date, 1), timezone, 5, readCalendarSources, linked,
        ranges ? JSON.parse(ranges) : undefined).then(result => {
        if (dayViewRequest !== req || linked.aborted) return
        liveEvents = result
        renderDayEvents()
      }).catch(() => {
        if (dayViewRequest !== req || linked.aborted) return
        liveEvents = { events: [], available: false, partial: false }
        renderDayEvents()
      })
    }

    void loadDrawerTasks({ date, filters, offset: 0, limit: 100 }, timezone, linked, context).then(({ rows, linkedEvents }) => {
      if (dayViewRequest !== req || linked.aborted) return
      persistedEvents = linkedEvents ?? []
      renderDayEvents()
      tasksEl.removeAttribute("aria-busy")
      if (rows?.length) {
        tasksEl.replaceChildren(...rows)
        taskStatusEl.textContent = ""
      } else {
        tasksEl.replaceChildren(createEmptyNotice("Your day is clear", "Add a task or event above to plan this day."))
        taskStatusEl.textContent = ""
      }
    }).catch(() => {
      if (dayViewRequest !== req || linked.aborted) return
      tasksEl.removeAttribute("aria-busy")
      tasksEl.replaceChildren()
      taskStatusEl.textContent = "Couldn’t load this day’s agenda."
    })
  }

  function previewEvents() {
    previewsRequest?.abort()
    hydrateDayView()
    if (month.dataset.calendarEvents !== "true") return
    previewsRequest = new AbortController()
    const lifetime = AbortSignal.any([signal, previewsRequest.signal])
    void loadInlineEventPreviews(month, timezone, readCalendarSources, lifetime)
  }

  function focusMonthDay(date?: string) {
    const cell = date && month.querySelector<HTMLElement>(`.cal-cell[data-date="${CSS.escape(date)}"]`)
    const target = cell || month.querySelector<HTMLElement>(".cal-today-btn")
    target?.focus()
  }

  function restoreFilterControls(url = applied, keepSearch = false) {
    document.dispatchEvent(new CustomEvent(CALENDAR_FILTER_STATE_EVENT, {
      detail: { ...readCalendarTaskFilters(url.searchParams), keepSearch, keepRulesDraft: ruleError?.hidden === false },
    }))
  }

  const unavailable = "Calendar data could not load."
  const refreshFailure = () => month.dataset.calendarAvailable === "false"
    ? unavailable : "Couldn’t apply calendar changes. The previous results are still shown."

  async function refresh(url: URL, background = false) {
    const preserveRetry = background && url.search === applied.search && retryTarget && retryTarget.search !== url.search
    refreshRequest?.abort()
    const request = new AbortController()
    refreshRequest = request
    desired = url
    month.setAttribute("aria-busy", "true")
    retry!.setAttribute("aria-disabled", "true")
    announce("Loading calendar…")

    try {
      const requestUrl = new URL(url, window.location.origin)
      if (requestUrl.origin !== window.location.origin) throw new Error("Calendar request origin mismatch")
      requestUrl.hash = ""
      requestUrl.searchParams.set("calendarRefresh", `${performance.timeOrigin}-${++refreshCount}`)
      const response = await fetch(requestUrl.pathname + requestUrl.search, { // nosemgrep
        signal: AbortSignal.any([signal, request.signal, AbortSignal.timeout(10_000)]),
        redirect: "error",
        cache: "no-store",
      })
      if (!response.ok) throw new Error("Calendar request failed")
      const html = new DOMParser().parseFromString(await response.text(), "text/html")
      const nextShell = html.querySelector<HTMLElement>("#calendar-shell")
      const nextMonth = nextShell?.querySelector<HTMLElement>('[data-calendar-month][data-calendar-available="true"]')
      if (request.signal.aborted || signal.aborted) return
      if (!nextMonth) throw new Error("Calendar response unavailable")
      timezone = nextShell?.dataset.timezone || timezone
      shell!.dataset.timezone = timezone
      const active = document.activeElement
      const activeDay = active?.closest<HTMLElement>(".cal-cell")?.dataset.date
      const activeNavigation = active?.closest<HTMLElement>("[data-calendar-nav]")?.dataset.calendarNav
      month.replaceWith(nextMonth)
      month = nextMonth

      replaceTaskBackgroundUrl(url)
      const previousArea = readCalendarTaskFilters(applied.searchParams).area
      applied = new URL(url)
      const area = readCalendarTaskFilters(applied.searchParams).area
      if (area !== undefined && area !== previousArea) {
        document.dispatchEvent(new CustomEvent(CALENDAR_AREA_APPLIED_EVENT, { detail: area }))
      }
      if (retryTarget && !preserveRetry) {
        retryTarget = undefined
        restoreFilterControls()
      }
      const hadRetryFocus = document.activeElement === retry
      announce(preserveRetry ? refreshFailure() : rejectedFilterChange)
      if (activeNavigation) month.querySelector<HTMLElement>(`[data-calendar-nav="${CSS.escape(activeNavigation)}"]`)?.focus()
      else if (activeDay || hadRetryFocus && retry!.hidden) focusMonthDay(activeDay)
      previewEvents()
      if (drawerDate) startDrawerRead(drawerDate)
    } catch {
      if (!request.signal.aborted && !signal.aborted) {
        if (!preserveRetry) retryTarget = new URL(url)
        desired = new URL(applied)
        restoreFilterControls()
        announce(refreshFailure())
      }
    } finally {
      if (request === refreshRequest) {
        refreshRequest = undefined
        retry!.removeAttribute("aria-disabled")
        month.removeAttribute("aria-busy")
      }
    }
  }

  function rejectFilters(message: string, editRules: boolean): false {
    const recovery = month.dataset.calendarAvailable === "false" ? unavailable : "The previous results are still shown."
    rejectedFilterChange = message
    if (editRules && ruleError?.closest(".filter-toolbar__advanced-panel:not(.hidden)")) {
      ruleError.hidden = false
      ruleError.textContent = message
    }
    restoreFilterControls(desired, true)
    const retryHint = retryTarget ? " Retry calendar repeats the earlier request." : ""
    announce(`${message} ${recovery}${retryHint}`)
    return false
  }

  function applyFilters(values: KanbanFilters, editRules = false): boolean {
    if (editRules && ruleError) ruleError.hidden = true
    const url = new URL(desired)
    const previous = readCalendarTaskFilters(url.searchParams)
    const next = { ...previous, ...values }
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      if (rejectedFilterChange) {
        rejectedFilterChange = ""
        announce(retryTarget ? refreshFailure() : "")
      }
      return true
    }
    const sameRules = JSON.stringify(previous.advancedFilter) === JSON.stringify(next.advancedFilter)
    const savedRules = url.searchParams.getAll("advancedFilter")
    writeCalendarTaskFilters(url, next, sameRules && savedRules.length === 1 ? savedRules[0]! : null)
    const accepted = readCalendarTaskFilters(url.searchParams)
    if (next.advancedFilter?.conditions.length && !accepted.advancedFilter) {
      return rejectFilters("Shorten the Calendar rules or remove a condition.", editRules)
    }
    if (url.pathname.length + url.search.length > monthTargetLimit ||
      (next.labels?.length ?? 0) !== (accepted.labels?.length ?? 0)) {
      return rejectFilters("Remove a Calendar filter or shorten its values.", editRules)
    }
    rejectedFilterChange = ""
    void refresh(url)
    return true
  }

  function startDrawerRead(date: string) {
    const context = currentTaskApiContext()
    if (!context || !calendarContext || context.boardId !== calendarContext.boardId || context.actorKey !== calendarContext.actorKey) return
    drawerRequest?.abort()
    const currentRequest = new AbortController()
    drawerRequest = currentRequest
    const linked = AbortSignal.any([signal, currentRequest.signal, AbortSignal.timeout(10_000)])
    const focused = document.activeElement as HTMLElement | null
    const focusedTask = drawerTasks!.contains(focused) ? focused?.dataset.taskId : undefined
    const focusedEvent = drawerEvents!.contains(focused) ? focused?.dataset.occurrenceKey : undefined
    const restoreMore = focused === moreTasks
    if (focused && (restoreMore || drawerTasks!.contains(focused) || drawerEvents!.contains(focused))) closeButton?.focus()
    const showEvents = month.dataset.calendarEvents === "true"
    eventsSection!.hidden = !showEvents
    let live: Awaited<ReturnType<typeof loadCalendarRange>> | undefined
    let persisted: LinkedCalendarEvent[] | null | undefined
    let savedUnavailable = false
    function renderConnectedEvents() {
      if (!showEvents || persisted === undefined && live === undefined) return
      const activeId = drawerEvents!.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.occurrenceKey : undefined
      const eventLabel = (start: string) => {
        const time = formatCalendarEventTime(start, timezone)
        if (!time) return "All day"
        const day = calendarEventDay(start, timezone)
        if (!day || day === date) return time
        const startDate = new Date(day + "T00:00:00Z").toLocaleDateString("en-US", {
          month: "short", day: "numeric", timeZone: "UTC",
        })
        return `Continues · Started ${startDate}, ${time}`
      }
      const items = (persisted ?? []).map(event => {
        const row = agendaItem("calendar-event", event.title, eventLabel(event.start), event.id)
        row.dataset.occurrenceKey = event.id + "/" + calendarOccurrenceStartKey(event.start, timezone)
        return { start: event.start, row }
      })
      for (const event of distinctLiveCalendarEvents(live?.events ?? [], persisted ?? [], timezone)) {
        items.push({ start: event.start, row: agendaItem("calendar-event", event.summary, eventLabel(event.start)) })
      }
      items.sort((a, b) => compareCalendarStarts(a.start, b.start, timezone))
      drawerEvents!.replaceChildren(...items.map(item => item.row))
      const notes: string[] = []
      if (!live || persisted === undefined) notes.push(loading)
      else if (!live.available || live.partial) notes.push(
        (live.available ? "Some live" : "Live") + " Home Assistant calendars couldn’t refresh. Reopen the day to retry.",
      )
      else if (!savedUnavailable && !items.length) notes.push("No calendar events")
      if (savedUnavailable) notes.push("Saved calendar links couldn’t load. Reopen the day to retry.")
      const feedback = notes.join("\n")
      if (drawerEventStatus!.textContent !== feedback) drawerEventStatus!.textContent = feedback
      const restoreId = activeId ?? focusedEvent
      if (restoreId && (activeId || document.activeElement === closeButton)) {
        const restore = items.find(item => item.row.dataset.occurrenceKey === restoreId)?.row ?? closeButton
        restore?.focus()
      }
    }
    if (showEvents) {
      drawerEvents!.replaceChildren(...createSkeletonRows(2))
      drawerEventStatus!.textContent = ""
      const ranges = month.querySelector<HTMLElement>(`.cal-cell[data-date="${CSS.escape(date)}"]`)?.dataset.dayRanges
      void loadCalendarRange(date, shiftCalendarDay(date, 1), timezone, 5, readCalendarSources, linked,
        ranges ? JSON.parse(ranges) : undefined).then(result => {
        if (drawerRequest !== currentRequest || currentRequest.signal.aborted || signal.aborted) return
        live = result
        renderConnectedEvents()
      }).catch(() => {
        if (drawerRequest === currentRequest && !currentRequest.signal.aborted && !signal.aborted) {
          live = { events: [], available: false, partial: false }
          renderConnectedEvents()
        }
      })
    }

    drawerTasks!.replaceChildren(...createSkeletonRows(2))
    const filters = new URLSearchParams([...applied.searchParams].filter(([key]) => agendaFilterKeys.has(key))).toString()
    moreTasks.hidden = true
    moreTasks.removeAttribute("aria-disabled")
    let offset = 0
    let busy = false
    const seen = new Set<string>()
    const limit = 100
    const loadDueTasks = async () => {
      if (busy || drawerRequest !== currentRequest || currentRequest.signal.aborted) return
      busy = true
      moreTasks.setAttribute("aria-disabled", "true")
      drawerTaskStatus!.textContent = loading
      const taskSignal = AbortSignal.any([signal, currentRequest.signal, AbortSignal.timeout(10_000)])
      let received = false
      try {
        const { rows, total, linkedEvents } = await loadDrawerTasks({ date, filters, offset, limit }, timezone, taskSignal, context)
        if (taskSignal.aborted) return
        received = true
        if (!offset) {
          drawerTasks!.replaceChildren()
          savedUnavailable = linkedEvents === null
          persisted = linkedEvents ?? persisted ?? null
          renderConnectedEvents()
        }
        if (!rows) throw new Error("Scheduled work unavailable")
        const fresh = rows.filter(row => {
          const id = row.dataset.taskId ?? ""
          if (seen.has(id)) return false
          seen.add(id)
          return true
        })
        drawerTasks!.append(...fresh)
        offset += rows.length
        const canLoadMore = rows.length > 0 && total > offset
        if (document.activeElement === moreTasks && (fresh.length || !canLoadMore)) {
          (fresh[0] ?? drawerTasks!.querySelector<HTMLElement>("[data-task-id]") ??
            closeButton)?.focus()
        }
        moreTasks.hidden = !canLoadMore
        moreTasks.textContent = canLoadMore ? `Load more items (${total - offset} remaining)` : "Load more items"
        if (offset === rows.length && document.activeElement === closeButton) {
          const restore = restoreMore && canLoadMore ? moreTasks : fresh.find(row => row.dataset.taskId === focusedTask)
          restore?.focus()
        }
        drawerTaskStatus!.textContent = !offset ? "No matching tasks or local events"
          : offset > rows.length && fresh.length ? `${fresh.length} more item${fresh.length === 1 ? '' : 's'} loaded` : ""
      } catch (error) {
        if (drawerRequest !== currentRequest || currentRequest.signal.aborted || signal.aborted) return
        log.warn("Could not load due tasks", error)
        if (!offset) {
          drawerTaskStatus!.textContent = "Couldn’t load this day’s agenda."
          if (!received) {
            savedUnavailable = true
            persisted ??= null
          }
          renderConnectedEvents()
        } else drawerTaskStatus!.textContent = "Couldn’t load more items."
        moreTasks.hidden = false
        moreTasks.textContent = "Retry agenda"
      } finally {
        if (drawerRequest === currentRequest) moreTasks.removeAttribute("aria-disabled")
        busy = false
      }
    }
    loadMoreDueTasks = () => void loadDueTasks()
    loadMoreDueTasks()
  }

  function openCell(target: EventTarget | null) {
    const cell = (target as Element | null)?.closest<HTMLElement>(dayButton)
    const date = cell?.dataset.date
    if (!date || drawerDate) return
    drawerDate = date
    drawerTitle!.textContent = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
    })
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    drawer!.setAttribute("aria-hidden", "false")
    function focusClose(remaining: number) {
      if (drawerDate !== date || panel!.contains(document.activeElement)) return
      closeButton!.focus({ preventScroll: true })
      if (remaining && document.activeElement !== closeButton) {
        drawerFocusFrame = requestAnimationFrame(() => focusClose(remaining - 1))
      }
    }
    focusClose(2)
    startDrawerRead(date)
  }

  function closeDrawer(restoreFocus = true) {
    if (!drawerDate) return
    const closedDay = drawerDate
    drawerDate = ""
    cancelAnimationFrame(drawerFocusFrame)
    drawerRequest?.abort()
    loadMoreDueTasks = undefined
    drawer!.setAttribute("aria-hidden", "true")
    document.body.style.overflow = previousOverflow
    if (restoreFocus) focusMonthDay(closedDay)
  }

  shell.addEventListener("click", event => {
    if (event.defaultPrevented) return
    const target = event.target as Element
    const navLink = target.closest<HTMLAnchorElement>("[data-calendar-nav]")
    if (navLink) {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      const destination = new URL(navLink.href)
      const next = new URL(desired)
      for (const key of ["calView", "year", "month", "date"]) {
        const value = destination.searchParams.get(key)
        if (value === null) next.searchParams.delete(key)
        else next.searchParams.set(key, value)
      }
      next.hash = destination.hash || next.hash
      void refresh(next)
      return
    }
    const dayAdd = target.closest<HTMLButtonElement>("[data-day-view-add]")
    if (dayAdd) {
      const date = dayAdd.dataset.date
      if (date) window.__prefillTaskDate = date
      const kind: TaskKind = dayAdd.dataset.dayViewAdd === "event" ? "calendar_event" : "standard_action"
      if (window.openNewTaskModal) window.openNewTaskModal(kind)
      else byId("kanban-bar-new-task")?.click()
      return
    }
    const dayTaskId = target.closest<HTMLElement>("#cal-day-view-tasks [data-task-id], #cal-day-view-events [data-task-id]")?.dataset.taskId
    if (dayTaskId) {
      openTaskDetailHandoff(dayTaskId)
      return
    }
    if (target.closest("#day-drawer-close, #day-drawer-backdrop")) {
      closeDrawer()
      return
    }
    const action = target.closest("#day-drawer-add-event, #day-drawer-add-task")
    if (action && drawerDate) {
      const kind: TaskKind = action.id === "day-drawer-add-event" ? "calendar_event" : "standard_action"
      window.__prefillTaskDate = drawerDate
      closeDrawer()
      if (window.openNewTaskModal) window.openNewTaskModal(kind)
      else byId("kanban-bar-new-task")?.click()
      return
    }
    const taskId = target.closest<HTMLElement>("#day-drawer-tasks [data-task-id], #day-drawer-events [data-task-id]")?.dataset.taskId
    if (taskId) {
      closeDrawer()
      openTaskDetailHandoff(taskId)
      return
    }
    openCell(target)
  }, { signal })

  window.addEventListener("keydown", event => {
    const target = event.target
    if (event.defaultPrevented || !(target instanceof Element)) return
    if (drawerDate) {
      if (event.key === "Escape") {
        event.preventDefault()
        closeDrawer()
      } else {
        containTabFocus(panel, event)
      }
      return
    }
    if ((event.key === "Enter" || event.key === " ") && target.matches(dayButton)) {
      event.preventDefault()
      openCell(target)
      return
    }
    // Single-key calendar range shortcuts (D / W / M / Y / T) when not editing text
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (target.matches("input, textarea, select, [contenteditable='true']") || target.closest("[role='dialog']")) return
    const key = event.key.toLowerCase()
    if (key === "d" || key === "w" || key === "m" || key === "y") {
      const shortcutLink = month.querySelector<HTMLAnchorElement>(`[data-calendar-shortcut="${key}"]`)
      if (shortcutLink) {
        event.preventDefault()
        event.stopImmediatePropagation()
        shortcutLink.click()
      }
    } else if (key === "t") {
      const todayLink = month.querySelector<HTMLAnchorElement>('[data-calendar-nav="today"]')
      if (todayLink) {
        event.preventDefault()
        event.stopImmediatePropagation()
        todayLink.click()
      }
    }
  }, { capture: true, signal })

  moreTasks.addEventListener("click", () => loadMoreDueTasks?.(), { signal })
  retry.addEventListener("click", () => {
    if (!refreshRequest && retryTarget) void refresh(new URL(retryTarget))
  }, { signal })
  document.addEventListener("meitheal:filter-change", event => {
    const detail = (event as CustomEvent<{ view: string; clear?: boolean; editRules?: boolean } & KanbanFilters>).detail
    if (detail?.view !== "calendar") return
    const { search, status, priority, rice, user, task_type, types, labels, promoted, advancedFilter } = detail
    const area = detail.clear ? { area: "" } : {}
    if (!applyFilters({ ...area, search, status, priority, rice, user, task_type, types, labels, promoted, advancedFilter } as KanbanFilters, detail.clear || detail.editRules)) {
      event.preventDefault()
    }
  }, { signal })
  document.addEventListener(CALENDAR_AREA_REQUEST_EVENT, event => {
    const area = (event as CustomEvent<{ areaId: string }>).detail.areaId
    applyFilters({ area })
  }, { signal })
  const refreshTasks = () => void refresh(new URL(desired), true)
  document.addEventListener("meitheal:tasks-changed", refreshTasks, { signal })
  document.addEventListener("meitheal:task-status-saved", refreshTasks, { signal })
  signal.addEventListener("abort", () => {
    dayViewRequest?.abort()
    delete shell.dataset.calendarReady
    closeDrawer(false)
  }, { once: true })

  const rememberedArea = readCalendarTaskFilters(desired.searchParams).area === undefined ? getRememberedAreaId() : ""
  previewEvents()
  if (rememberedArea) applyFilters({ area: rememberedArea })
}

const agendaFilterKeys = new Set(["project", "project_id", "area", "area_id", "board", "search", "user", "status", "priority",
  "rice", "types", "task_type", "label", "labels", "promoted", "advancedFilter"])

function writeCalendarTaskFilters(url: URL, filters: KanbanFilters, rawRules: string | null) {
  updateKanbanFilters(url, filters)
  if (filters.advancedFilter?.conditions.length) {
    url.searchParams.set("advancedFilter", rawRules ?? JSON.stringify(filters.advancedFilter))
  }
  url.searchParams.delete("area_id")
  if (filters.task_type) url.searchParams.set("task_type", filters.task_type)
  else url.searchParams.delete("task_type")
}

async function fetchCalendarEntities(signal: AbortSignal): Promise<string[]> {
  const response = await fetch("/api/ha/calendars?configured=1", { signal })
  if (!response.ok) throw new Error("Calendar source configuration unavailable")
  const { entities } = await response.json() as { entities?: string[] }
  if (!Array.isArray(entities)) throw new Error("Invalid calendar source configuration")
  return entities
}

async function loadCalendarRange(
  start: string, end: string, timezone: string, limit: number, readSources: () => Promise<string[]>, signal: AbortSignal,
  dayRanges?: [number, number][],
) {
  const entities = await readSources()
  signal.throwIfAborted()
  // Use explicit UTC bounds with room for the Core and household time zones.
  const from = shiftCalendarDay(start, -1) + "T00:00:00Z"
  const through = shiftCalendarDay(end, 1) + "T00:00:00Z"
  const results = await Promise.allSettled(entities.slice(0, limit).map(async entity => {
    const feed = new URL("/api/ha/events", location.origin)
    feed.search = new URLSearchParams({ entity_id: entity, start: from, end: through }).toString()
    const response = await fetch(new Request(feed), { signal, mode: "same-origin", redirect: "error" })
    if (!response.ok) throw new Error("Calendar feed unavailable")
    const data = await response.json() as { events?: Array<Omit<CalendarEventRecord, "entity">> }
    if (!Array.isArray(data.events)) throw new Error("Invalid calendar feed")
    return data.events.filter(event => {
      if (!event || typeof event.start !== "string" || typeof event.summary !== "string") return false
      if (dayRanges && typeof event.end === "string") {
        const interval = calendarEventInterval(event.start, event.end, timezone)
        if (interval) return calendarIntervalOverlaps(interval, dayRanges)
      }
      const firstDay = calendarEventDay(event.start, timezone)
      if (!firstDay || firstDay >= end) return false
      if (firstDay >= start) return true
      const lastDay = typeof event.end === "string" ? calendarEventDay(event.end, timezone, "exclusive-end") : null
      return lastDay !== null && lastDay >= start
    }).map(event => ({ ...event, entity }))
  }))
  const events = results.flatMap(result => result.status === "fulfilled" ? result.value : [])
  events.sort((a, b) => compareCalendarStarts(a.start, b.start, timezone))
  return {
    events,
    partial: results.some(result => result.status === "rejected"),
    available: results.length === 0 || results.some(result => result.status === "fulfilled"),
  }
}

function distinctLiveCalendarEvents(events: CalendarEventRecord[], linked: LinkedCalendarEvent[], timezone: string): CalendarEventRecord[] {
  if (!linked.length) return events
  const key = (entity: string, start: string, identifier: string) =>
    JSON.stringify([entity, calendarOccurrenceStartKey(start, timezone), identifier])
  const byUid = new Set<string>()
  const savedCounts = new Map<string, number>()
  const liveCounts = new Map<string, number>()
  for (const row of linked) {
    if (!row.entity) continue
    const uid = row.uid?.trim()
    if (uid) byUid.add(key(row.entity, row.start, uid))
    const summary = normalizeCalendarEventSummary(row.providerSummary ?? "")
    if (summary) {
      const match = key(row.entity, row.start, summary)
      savedCounts.set(match, (savedCounts.get(match) ?? 0) + 1)
    }
  }
  for (const event of events) {
    const match = key(event.entity, event.start, normalizeCalendarEventSummary(event.summary))
    liveCounts.set(match, (liveCounts.get(match) ?? 0) + 1)
  }
  return events.filter(event => {
    const uid = typeof event.uid === "string" ? event.uid.trim() : ""
    if (uid) return !byUid.has(key(event.entity, event.start, uid))
    const match = key(event.entity, event.start, normalizeCalendarEventSummary(event.summary))
    return savedCounts.get(match) !== 1 || liveCounts.get(match) !== 1
  })
}

function agendaItem(icon: TablerIconName, title: string, meta: string, taskId?: string) {
  const item = document.createElement(taskId ? "button" : "div")
  item.className = "day-drawer-item"
  if (taskId) {
    item.dataset.taskId = taskId
    item.setAttribute("type", "button")
  }
  const content = document.createElement("span")
  content.className = "day-drawer-item-content"
  const heading = document.createElement("span")
  heading.className = "day-drawer-item-title"
  heading.textContent = title
  const caption = document.createElement("span")
  caption.className = "day-drawer-item-meta"
  caption.textContent = meta
  content.append(heading, caption)
  item.append(createTablerSvgElement(icon, 16, "day-drawer-item-icon"), content)
  return item
}

async function loadDrawerTasks(
  query: { date: string; filters: string; offset: number; limit: number },
  timezone: string,
  signal: AbortSignal,
  context: TaskApiContext,
) {
  if (!sameTaskApiContext(context, currentTaskApiContext())) throw new Error("Calendar context changed")
  const response = await fetch("/api/calendar/agenda", {
    method: "POST",
    mode: "same-origin",
    redirect: "error",
    headers: taskApiHeaders(context, { "content-type": "application/json" }),
    body: JSON.stringify(query),
    signal,
  })
  if (!response.ok || signal.aborted || !sameTaskApiContext(context, currentTaskApiContext())) throw new Error(`Task query failed: ${response.status}`)
  const data = await response.json() as {
    tasks?: Record<string, unknown>[] | null; total?: number | null; linkedEvents?: LinkedCalendarEvent[] | null
  }
  if (signal.aborted || !sameTaskApiContext(context, currentTaskApiContext())) throw new Error("Calendar context changed")
  if (data.tasks !== null && !Array.isArray(data.tasks)) throw new Error("Invalid task list")

  const rows = data.tasks?.map(task => {
    const status = String(task.status ?? "")
    const definition = getStatusDef(status)
    const deferred = task.deferred_at != null ? ` · ${window.mI18n?.get("deferral.title") ?? "Deferred"}` : ""
    const priority = task.priority ? ` · P${String(task.priority)}` : ""
    const isEvent = task.task_kind === "calendar_event"
    const eventTime = isEvent && typeof task.start_date === "string" && formatTimeInZone(task.start_date, timezone)
    const meta = isEvent && task.start_date ? `${eventTime || "All day"} · ${definition?.label ?? status}` : definition?.label ?? status
    const icon = isEvent ? "calendar-event" : definition ? mapEntityEmojiToTabler(definition.icon) ?? "checkbox" : "checkbox"
    return agendaItem(icon, String(task.title ?? "Untitled task"), `${meta}${priority}${deferred}`, String(task.id))
  })
  return { rows, total: data.total ?? rows?.length ?? 0, linkedEvents: data.linkedEvents === undefined ? [] : data.linkedEvents }
}

async function loadInlineEventPreviews(
  month: HTMLElement, timezone: string, readSources: () => Promise<string[]>, lifetime: AbortSignal,
): Promise<void> {
  const cells = Array.from(month.querySelectorAll<HTMLElement>("[data-inline-date]"))
  const start = cells[0]?.dataset.inlineDate
  const lastDay = cells.at(-1)?.dataset.inlineDate
  if (!start || !lastDay) return

  try {
    const deadline = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)])
    const { events } = await loadCalendarRange(start, shiftCalendarDay(lastDay, 1), timezone, 3, readSources, deadline)
    if (lifetime.aborted) return

    const byDate = new Map<string, CalendarEventRecord[]>()
    for (const event of events) {
      const date = calendarEventDay(event.start, timezone)
      if (!date) continue
      const group = byDate.get(date) ?? []
      group.push(event)
      byDate.set(date, group)
    }

    for (const container of cells) {
      const events = byDate.get(container.dataset.inlineDate ?? "") ?? []
      const items = events.slice(0, 2).map(event => {
        const time = formatCalendarEventTime(event.start, timezone)
        const row = document.createElement("div")
        row.className = "cal-inline-event cal-inline-ha"
        row.title = event.summary
        row.textContent = time ? `${time} ${event.summary}` : event.summary
        return row
      })
      container.replaceChildren(...items)
      if (events.length > items.length) {
        const more = document.createElement("span")
        more.className = "cal-inline-more"
        more.textContent = `+${events.length - items.length} more`
        container.append(more)
      }
    }
  } catch (error) {
    if (!lifetime.aborted) log.warn("Could not load calendar previews", error)
  }
}
