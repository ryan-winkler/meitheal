import type { TaskKind } from "@meitheal/domain-tasks"
import { CALENDAR_AREA_APPLIED_EVENT, CALENDAR_AREA_REQUEST_EVENT, getRememberedAreaId } from "@lib/area-selector-controller"
import { CALENDAR_FILTER_STATE_EVENT, readCalendarTaskFilters } from "@lib/calendar-task-filter"
import { createClientLogger } from "@lib/client-logger"
import { calendarDayFromInput, calendarEventLastDay, calendarOccurrenceStartKey, formatTimeInZone, normalizeCalendarEventSummary, shiftCalendarDay } from "@lib/date"
import { createFocusTrap } from "@lib/focus-trap"
import { updateKanbanFilters, type KanbanFilters } from "@lib/kanban-query"
import { createTablerSvgElement, mapEntityEmojiToTabler, type TablerIconName } from "@lib/tabler-svg"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { TASK_VIEW_LOCATION_EVENT, taskBackgroundUrl, ticketIdFromPath } from "@lib/task-page-url"
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

export function initCalendarPage(signal: AbortSignal): void {
  const shell = document.getElementById("calendar-shell")
  const initialMonth = shell?.querySelector<HTMLElement>("[data-calendar-month]")
  const status = shell?.querySelector<HTMLElement>("[data-calendar-status]")
  const retry = shell?.querySelector<HTMLButtonElement>("[data-calendar-retry]")
  const drawer = document.getElementById("day-drawer")
  const panel = drawer?.querySelector<HTMLElement>('[role="dialog"]')
  const drawerTitle = document.getElementById("day-drawer-title")
  const drawerEvents = document.getElementById("day-drawer-events")
  const drawerTasks = document.getElementById("day-drawer-tasks")
  const drawerTaskStatus = document.getElementById("day-drawer-task-status")
  const queryMoreTasks = document.querySelector<HTMLButtonElement>("#day-drawer-more-tasks")
  const eventsSection = drawer?.querySelector<HTMLElement>("[data-calendar-events-section]")
  if (!shell || !initialMonth || !status || !retry || !drawer || !panel || !drawerTitle ||
    !drawerEvents || !drawerTasks || !drawerTaskStatus || !queryMoreTasks || !eventsSection || shell.dataset.calendarReady === "true") return
  const moreTasks = queryMoreTasks

  shell.dataset.calendarReady = "true"
  const trap = createFocusTrap(panel)
  let timezone = shell.dataset.timezone || "Europe/Dublin"
  let month = initialMonth
  let desired = taskBackgroundUrl(new URL(location.href))
  let applied = new URL(desired)
  let retryTarget: URL | undefined
  let refreshRequest: AbortController | undefined
  let previewsRequest: AbortController | undefined
  let drawerRequest: AbortController | undefined
  let drawerDate = ""
  let loadMoreDueTasks: (() => void) | undefined
  let previousOverflow = ""
  let refreshCount = 0
  let rejectedFilterChange = ""
  let calendarSources: Promise<string[]> | undefined
  const readCalendarSources = () => calendarSources ??= fetchCalendarEntities(
    AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  ).catch(error => {
    calendarSources = undefined
    throw error
  })

  function announce(message: string, failed = false) {
    status!.hidden = !message
    status!.textContent = message
    retry!.hidden = !failed
  }

  function previewEvents() {
    previewsRequest?.abort()
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
      detail: { ...readCalendarTaskFilters(url.searchParams), keepSearch },
    }))
  }

  const refreshFailure = "Couldn’t apply calendar changes. The previous results are still shown."

  async function refresh(url: URL, background = false) {
    const preserveRetry = background && retryTarget && retryTarget.search !== url.search
    refreshRequest?.abort()
    const request = new AbortController()
    refreshRequest = request
    desired = url
    month.setAttribute("aria-busy", "true")
    const activeRetry = document.activeElement === retry
    announce("Loading calendar…")

    try {
      const requestUrl = new URL(url)
      requestUrl.hash = ""
      requestUrl.searchParams.set("calendarRefresh", `${performance.timeOrigin}-${++refreshCount}`)
      const response = await fetch(requestUrl, {
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
      const activeDay = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".cal-cell")?.dataset.date
      month.replaceWith(nextMonth)
      month = nextMonth

      const current = new URL(location.href)
      if (ticketIdFromPath(current.pathname, window.__ingress_path) !== null) {
        history.replaceState({ ...history.state, ticketDrawer: { ...history.state?.ticketDrawer, returnTo: url.href } }, "")
      } else {
        for (const key of ["open", "comment"]) {
          const value = current.searchParams.get(key)
          if (value === null) url.searchParams.delete(key)
          else url.searchParams.set(key, value)
        }
        history.replaceState(history.state, "", url)
      }
      applied = new URL(url)
      const area = readCalendarTaskFilters(applied.searchParams).area
      if (area !== undefined) document.dispatchEvent(new CustomEvent(CALENDAR_AREA_APPLIED_EVENT, { detail: area }))
      if (retryTarget && !preserveRetry) {
        retryTarget = undefined
        restoreFilterControls()
      }
      document.dispatchEvent(new Event(TASK_VIEW_LOCATION_EVENT))
      if (preserveRetry) announce(refreshFailure, true)
      else announce(rejectedFilterChange)
      if (activeDay || activeRetry) focusMonthDay(activeDay)
      previewEvents()
      if (drawerDate) startDrawerRead(drawerDate)
    } catch {
      if (!request.signal.aborted && !signal.aborted) {
        if (!preserveRetry) retryTarget = new URL(url)
        desired = new URL(applied)
        restoreFilterControls()
        announce(refreshFailure, true)
      }
    } finally {
      if (request === refreshRequest) {
        refreshRequest = undefined
        month.removeAttribute("aria-busy")
      }
    }
  }

  function rejectFilters(message: string): false {
    rejectedFilterChange = `${message} The previous results are still shown.`
    restoreFilterControls(desired, true)
    announce(rejectedFilterChange)
    return false
  }

  function applyFilters(values: KanbanFilters): boolean {
    const url = new URL(desired)
    const previous = readCalendarTaskFilters(url.searchParams)
    const next = { ...previous, ...values }
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      if (rejectedFilterChange) {
        rejectedFilterChange = ""
        announce("")
      }
      return true
    }
    const sameRules = JSON.stringify(previous.advancedFilter) === JSON.stringify(next.advancedFilter)
    writeCalendarTaskFilters(url, next, sameRules ? url.searchParams.get("advancedFilter") : null)
    const accepted = readCalendarTaskFilters(url.searchParams)
    if (next.advancedFilter?.conditions.length && !accepted.advancedFilter) {
      return rejectFilters("Shorten the Calendar rules or remove a condition.")
    }
    if (url.pathname.length + url.search.length > monthTargetLimit ||
      (next.labels?.length ?? 0) !== (accepted.labels?.length ?? 0)) {
      return rejectFilters("Remove a Calendar filter or shorten its values.")
    }
    rejectedFilterChange = ""
    void refresh(url)
    return true
  }

  function startDrawerRead(date: string) {
    drawerRequest?.abort()
    const currentRequest = new AbortController()
    drawerRequest = currentRequest
    const linked = AbortSignal.any([signal, currentRequest.signal, AbortSignal.timeout(10_000)])
    const closeButton = drawer!.querySelector<HTMLElement>("#day-drawer-close")
    const focused = document.activeElement as HTMLElement | null
    const focusedTask = drawerTasks!.contains(focused) ? focused?.dataset.taskId : undefined
    const focusedEvent = drawerEvents!.contains(focused) ? focused?.dataset.occurrenceKey : undefined
    const restoreMore = focused === moreTasks
    if (focused && (restoreMore || drawerTasks!.contains(focused) || drawerEvents!.contains(focused))) closeButton?.focus()
    const showEvents = month.dataset.calendarEvents === "true"
    eventsSection!.hidden = !showEvents
    let live: Awaited<ReturnType<typeof loadCalendarRange>> | undefined
    let persisted: LinkedCalendarEvent[] | null | undefined
    function renderConnectedEvents() {
      if (!showEvents || persisted === undefined && live === undefined) return
      const activeId = drawerEvents!.contains(document.activeElement)
        ? (document.activeElement as HTMLElement).dataset.occurrenceKey : undefined
      const items = (persisted ?? []).map(event => {
        const row = agendaItem("calendar-event", event.title, formatTimeInZone(event.start, timezone) ?? "All day", event.id)
        row.dataset.occurrenceKey = event.id + "/" + calendarOccurrenceStartKey(event.start)
        return { start: event.start, row }
      })
      for (const event of distinctLiveCalendarEvents(live?.events ?? [], persisted ?? [])) {
        items.push({ start: event.start, row: agendaItem("calendar-event", event.summary, formatTimeInZone(event.start, timezone) ?? "All day") })
      }
      items.sort((a, b) => a.start.localeCompare(b.start))
      drawerEvents!.replaceChildren(...items.map(item => item.row))
      if (!live || persisted === undefined) drawerEvents!.append(agendaMessage(loading))
      else if (!live.available) drawerEvents!.append(agendaMessage("Connected calendar events couldn’t load."))
      else if (live.partial) drawerEvents!.append(agendaMessage("Some connected calendar events couldn’t load."))
      else if (persisted && !items.length) drawerEvents!.append(agendaMessage("No calendar events"))
      if (persisted === null) drawerEvents!.append(agendaMessage("Saved calendar links couldn’t load."))
      const restoreId = activeId ?? focusedEvent
      if (restoreId && (activeId || document.activeElement === closeButton)) {
        const restore = items.find(item => item.row.dataset.occurrenceKey === restoreId)?.row ?? closeButton
        restore?.focus()
      }
    }
    if (showEvents) {
      renderMessage(drawerEvents!, loading)
      void loadCalendarRange(date, shiftCalendarDay(date, 1), timezone, 5, readCalendarSources, linked).then(result => {
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

    renderMessage(drawerTasks!, loading)
    const filters = new URLSearchParams([...applied.searchParams].filter(([key]) => agendaFilterKeys.has(key))).toString()
    moreTasks.hidden = true
    moreTasks.removeAttribute("aria-disabled")
    drawerTaskStatus!.textContent = ""
    let offset = 0
    let busy = false
    const seen = new Set<string>()
    const limit = 100
    const loadDueTasks = async () => {
      if (busy || drawerRequest !== currentRequest || currentRequest.signal.aborted) return
      busy = true
      moreTasks.setAttribute("aria-disabled", "true")
      drawerTaskStatus!.textContent = offset ? loading : ""
      const taskSignal = AbortSignal.any([signal, currentRequest.signal, AbortSignal.timeout(10_000)])
      try {
        const { rows, total, linkedEvents } = await loadDrawerTasks({ date, filters, offset, limit }, timezone, taskSignal)
        if (taskSignal.aborted) return
        if (!offset) {
          drawerTasks!.replaceChildren()
          persisted = linkedEvents
          renderConnectedEvents()
        }
        const fresh = rows.filter(row => {
          const id = row.dataset.taskId ?? ""
          if (seen.has(id)) return false
          seen.add(id)
          return true
        })
        drawerTasks!.append(...fresh)
        offset += rows.length
        if (!offset) renderMessage(drawerTasks!, "No tasks or events scheduled")
        const canLoadMore = rows.length > 0 && total > offset
        if (!canLoadMore && document.activeElement === moreTasks) {
          (fresh[0] ?? drawerTasks!.querySelector<HTMLElement>("[data-task-id]") ??
            closeButton)?.focus()
        }
        moreTasks.hidden = !canLoadMore
        moreTasks.textContent = canLoadMore ? `Load more tasks (${total - offset} remaining)` : "Load more tasks"
        if (offset === rows.length && document.activeElement === closeButton) {
          const restore = restoreMore && canLoadMore ? moreTasks : fresh.find(row => row.dataset.taskId === focusedTask)
          restore?.focus()
        }
        drawerTaskStatus!.textContent = ""
      } catch (error) {
        if (drawerRequest !== currentRequest || currentRequest.signal.aborted || signal.aborted) return
        log.warn("Could not load due tasks", error)
        if (!offset) {
          renderMessage(drawerTasks!, "Couldn’t load tasks for this day.")
          persisted = null
          renderConnectedEvents()
        } else drawerTaskStatus!.textContent = "Couldn’t load more tasks."
        moreTasks.hidden = false
        moreTasks.textContent = "Retry tasks"
      } finally {
        if (drawerRequest === currentRequest) moreTasks.removeAttribute("aria-disabled")
        busy = false
      }
    }
    loadMoreDueTasks = () => void loadDueTasks()
    loadMoreDueTasks()
  }

  function openCell(target: EventTarget | null) {
    const cell = (target as Element | null)?.closest<HTMLElement>(".cal-cell[role='button']")
    const date = cell?.dataset.date
    if (!date) return
    drawerDate = date
    drawerTitle!.textContent = new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    })
    previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    drawer!.setAttribute("aria-hidden", "false")
    trap.activate()
    startDrawerRead(date)
  }

  function closeDrawer(restoreFocus = true) {
    if (!drawerDate) return
    const closedDay = drawerDate
    drawerDate = ""
    drawerRequest?.abort()
    loadMoreDueTasks = undefined
    drawer!.setAttribute("aria-hidden", "true")
    document.body.style.overflow = previousOverflow
    trap.deactivate(false)
    if (restoreFocus) focusMonthDay(closedDay)
  }

  shell.addEventListener("click", event => {
    if (event.defaultPrevented) return
    const target = event.target as Element
    const monthLink = target.closest<HTMLAnchorElement>("[data-calendar-nav]")
    if (monthLink && desired.search !== applied.search) {
      const destination = new URL(monthLink.href)
      const next = new URL(desired)
      for (const key of ["year", "month"]) {
        const value = destination.searchParams.get(key)
        if (value === null) next.searchParams.delete(key)
        else next.searchParams.set(key, value)
      }
      next.hash = destination.hash
      monthLink.href = next.href
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
      else (document.getElementById("kanban-bar-new-task") as HTMLButtonElement | null)?.click()
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

  shell.addEventListener("keydown", event => {
    if (event.defaultPrevented) return
    if (event.key === "Escape" && drawerDate && drawer.contains(event.target as Node)) {
      event.preventDefault()
      closeDrawer()
    } else if ((event.key === "Enter" || event.key === " ") && (event.target as Element).matches(".cal-cell[role='button']")) {
      event.preventDefault()
      openCell(event.target)
    }
  }, { signal })

  moreTasks.addEventListener("click", () => loadMoreDueTasks?.(), { signal })
  retry.addEventListener("click", () => void refresh(new URL(retryTarget ?? desired)), { signal })
  document.addEventListener("meitheal:filter-change", event => {
    const detail = (event as CustomEvent<{ view: string; clear?: boolean } & KanbanFilters>).detail
    if (detail?.view !== "calendar") return
    const { search, status, priority, rice, user, task_type, types, labels, promoted, advancedFilter } = detail
    const area = detail.clear ? { area: "" } : {}
    if (!applyFilters({ ...area, search, status, priority, rice, user, task_type, types, labels, promoted, advancedFilter } as KanbanFilters)) {
      event.preventDefault()
    }
  }, { signal })
  document.addEventListener(CALENDAR_AREA_REQUEST_EVENT, event => {
    const area = (event as CustomEvent<{ areaId: string }>).detail.areaId
    applyFilters({ area })
  }, { signal })
  document.addEventListener("meitheal:tasks-changed", () => void refresh(new URL(desired), true), { signal })
  signal.addEventListener("abort", () => {
    delete shell.dataset.calendarReady
    closeDrawer(false)
  }, { once: true })

  const rememberedArea = readCalendarTaskFilters(desired.searchParams).area === undefined ? getRememberedAreaId() : ""
  previewEvents()
  if (rememberedArea) applyFilters({ area: rememberedArea })
}

const agendaFilterKeys = new Set(["area", "area_id", "board", "search", "user", "status", "priority",
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
      const firstDay = calendarDayFromInput(event.start, timezone)
      if (!firstDay || firstDay >= end) return false
      if (firstDay >= start) return true
      const lastDay = typeof event.end === "string" ? calendarEventLastDay(event.end, timezone) : null
      return lastDay !== null && lastDay >= start
    }).map(event => ({ ...event, entity }))
  }))
  const events = results.flatMap(result => result.status === "fulfilled" ? result.value : [])
  events.sort((a, b) => a.start.localeCompare(b.start))
  return {
    events,
    partial: results.some(result => result.status === "rejected"),
    available: results.length === 0 || results.some(result => result.status === "fulfilled"),
  }
}

function distinctLiveCalendarEvents(events: CalendarEventRecord[], linked: LinkedCalendarEvent[]): CalendarEventRecord[] {
  if (!linked.length) return events
  const key = (entity: string, start: string, identifier: string) =>
    JSON.stringify([entity, calendarOccurrenceStartKey(start), identifier])
  const byUid = new Set<string>()
  const savedCounts = new Map<string, number>()
  const liveCounts = new Map<string, number>()
  for (const row of linked) {
    if (!row.entity) continue
    if (row.uid) byUid.add(key(row.entity, row.start, row.uid))
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
    if (event.uid) return !byUid.has(key(event.entity, event.start, event.uid))
    const match = key(event.entity, event.start, normalizeCalendarEventSummary(event.summary))
    return savedCounts.get(match) !== 1 || liveCounts.get(match) !== 1
  })
}

function agendaMessage(text: string) {
  const span = document.createElement("span")
  span.className = "day-drawer-empty"
  span.textContent = text
  return span
}

function renderMessage(container: HTMLElement, text: string) {
  container.replaceChildren(agendaMessage(text))
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
) {
  const response = await fetch("/api/calendar/agenda", {
    method: "POST",
    mode: "same-origin",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(query),
    signal,
  })
  if (!response.ok) throw new Error(`Task query failed: ${response.status}`)
  const data = await response.json() as { tasks?: Record<string, unknown>[]; total?: number; linkedEvents?: LinkedCalendarEvent[] }
  if (!Array.isArray(data.tasks)) throw new Error("Invalid task list")

  const rows = data.tasks.map(task => {
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
  return { rows, total: data.total ?? rows.length, linkedEvents: data.linkedEvents ?? [] }
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
      const date = calendarDayFromInput(event.start, timezone)
      if (!date) continue
      const group = byDate.get(date) ?? []
      group.push(event)
      byDate.set(date, group)
    }

    for (const container of cells) {
      const events = byDate.get(container.dataset.inlineDate ?? "") ?? []
      const items = events.slice(0, 2).map(event => {
        const time = formatTimeInZone(event.start, timezone)
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
