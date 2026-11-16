import type { TaskKind } from "@meitheal/domain-tasks"
import { getRememberedAreaId } from "@lib/area-selector-controller"
import { hasCalendarTaskFilters, readCalendarTaskFilters } from "@lib/calendar-task-filter"
import { createClientLogger } from "@lib/client-logger"
import { calendarDayFromInput, formatTimeInZone, shiftCalendarDay } from "@lib/date"
import { createFocusTrap } from "@lib/focus-trap"
import { updateKanbanFilters, type KanbanFilters } from "@lib/kanban-query"
import { createTablerSvgElement, mapEntityEmojiToTabler, type TablerIconName } from "@lib/tabler-svg"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { taskBackgroundUrl, ticketIdFromPath } from "@lib/task-page-url"
import { getStatusDef } from "@lib/status-config"

interface CalendarEventRecord {
  summary: string
  start: string
  end: string
}

const log = createClientLogger("tasks", "calendar-shell")
const loading = "Loading…"

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
  const timezone = shell.dataset.timezone || "Europe/Dublin"
  let month = initialMonth
  let desired = taskBackgroundUrl(new URL(location.href))
  let applied = new URL(desired)
  let refreshRequest: AbortController | undefined
  let previewsRequest: AbortController | undefined
  let drawerRequest: AbortController | undefined
  let drawerDate = ""
  let loadMoreDueTasks: (() => void) | undefined
  let previousOverflow = ""
  let refreshCount = 0
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
    const linked = AbortSignal.any([signal, previewsRequest.signal, AbortSignal.timeout(10_000)])
    void loadInlineEventPreviews(month, timezone, readCalendarSources, linked)
  }

  async function refresh(url: URL) {
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
      const nextMonth = html.querySelector<HTMLElement>('[data-calendar-month][data-calendar-available="true"]')
      if (request.signal.aborted || signal.aborted) return
      if (!nextMonth) throw new Error("Calendar response unavailable")
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
      announce("")
      if (activeDay) month.querySelector<HTMLElement>(`.cal-cell[data-date="${CSS.escape(activeDay)}"]`)?.focus()
      else if (activeRetry) month.querySelector<HTMLElement>(".cal-today-btn")?.focus()
      previewEvents()
      if (drawerDate) startDrawerRead(drawerDate)
    } catch {
      if (!request.signal.aborted && !signal.aborted) announce("Couldn’t apply calendar changes. The previous results are still shown.", true)
    } finally {
      if (request === refreshRequest) {
        refreshRequest = undefined
        month.removeAttribute("aria-busy")
      }
    }
  }

  function applyFilters(values: KanbanFilters) {
    const url = new URL(desired)
    const previous = readCalendarTaskFilters(url.searchParams)
    const next = { ...previous, ...values }
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    writeCalendarTaskFilters(url, next)
    void refresh(url)
  }

  function startDrawerRead(date: string) {
    drawerRequest?.abort()
    const currentRequest = new AbortController()
    drawerRequest = currentRequest
    const linked = AbortSignal.any([signal, currentRequest.signal, AbortSignal.timeout(10_000)])
    const showEvents = month.dataset.calendarEvents === "true"
    eventsSection!.hidden = !showEvents
    if (showEvents) {
      renderMessage(drawerEvents!, loading)
      void loadCalendarRange(date, shiftCalendarDay(date, 1), 5, readCalendarSources, linked).then(({ events, partial, available }) => {
        if (drawerRequest !== currentRequest || currentRequest.signal.aborted || signal.aborted) return
        if (!available) {
          renderMessage(drawerEvents!, "Connected calendar events couldn’t load.")
          return
        }
        const items = events.map(event => agendaItem("calendar-event", event.summary, formatTimeInZone(event.start, timezone) ?? "All day"))
        drawerEvents!.replaceChildren(...items)
        if (partial) drawerEvents!.append(agendaMessage("Some connected calendar events couldn’t load."))
        else if (!items.length) renderMessage(drawerEvents!, "No calendar events")
      }).catch(() => {
        if (drawerRequest === currentRequest && !currentRequest.signal.aborted && !signal.aborted) {
          renderMessage(drawerEvents!, "Connected calendar events couldn’t load.")
        }
      })
    }

    renderMessage(drawerTasks!, loading)
    const params = new URLSearchParams({ due_date: date })
    const filters = readCalendarTaskFilters(applied.searchParams)
    const query = new URL(applied)
    query.search = ""
    if (hasCalendarTaskFilters(filters)) {
      writeCalendarTaskFilters(query, filters)
      const rules = applied.searchParams.get("advancedFilter")
      // The month has already applied this representation within the filter readers' size bounds.
      if (filters.advancedFilter && rules) query.searchParams.set("advancedFilter", rules)
    }
    params.set("calendar_filters", query.searchParams.toString())
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
      params.set("offset", String(offset))
      params.set("limit", String(limit))
      const taskSignal = AbortSignal.any([signal, currentRequest.signal, AbortSignal.timeout(10_000)])
      try {
        const { rows, total } = await loadDrawerTasks(params, taskSignal)
        if (taskSignal.aborted) return
        if (!offset) drawerTasks!.replaceChildren()
        const fresh = rows.filter(row => {
          const id = row.dataset.taskId ?? ""
          if (seen.has(id)) return false
          seen.add(id)
          return true
        })
        drawerTasks!.append(...fresh)
        offset += rows.length
        if (!offset) renderMessage(drawerTasks!, "No tasks due")
        const canLoadMore = rows.length > 0 && total > offset
        if (!canLoadMore && document.activeElement === moreTasks) {
          (fresh[0] ?? drawerTasks!.querySelector<HTMLElement>("[data-task-id]") ??
            drawer!.querySelector<HTMLElement>("#day-drawer-close"))?.focus()
        }
        moreTasks.hidden = !canLoadMore
        moreTasks.textContent = canLoadMore ? `Load more tasks (${total - offset} remaining)` : "Load more tasks"
        drawerTaskStatus!.textContent = ""
      } catch (error) {
        if (drawerRequest !== currentRequest || currentRequest.signal.aborted || signal.aborted) return
        log.warn("Could not load due tasks", error)
        if (!offset) renderMessage(drawerTasks!, "Couldn’t load tasks for this day.")
        else drawerTaskStatus!.textContent = "Couldn’t load more tasks."
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
    drawerDate = ""
    drawerRequest?.abort()
    loadMoreDueTasks = undefined
    drawer!.setAttribute("aria-hidden", "true")
    document.body.style.overflow = previousOverflow
    trap.deactivate(restoreFocus)
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
    const taskId = target.closest<HTMLElement>("#day-drawer-tasks [data-task-id]")?.dataset.taskId
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
  retry.addEventListener("click", () => void refresh(new URL(desired)), { signal })
  document.addEventListener("meitheal:filter-change", event => {
    const detail = (event as CustomEvent<{ view: string } & KanbanFilters>).detail
    if (detail?.view !== "calendar") return
    const { area, search, status, priority, rice, user, task_type, types, labels, promoted, advancedFilter } = detail
    applyFilters({ area, search, status, priority, rice, user, task_type, types, labels, promoted, advancedFilter } as KanbanFilters)
  }, { signal })
  document.addEventListener("meitheal:area-changed", event => {
    const area = (event as CustomEvent<{ areaId: string }>).detail.areaId
    applyFilters({ area })
  }, { signal })
  document.addEventListener("meitheal:tasks-changed", () => void refresh(new URL(desired)), { signal })
  signal.addEventListener("abort", () => {
    delete shell.dataset.calendarReady
    closeDrawer(false)
  }, { once: true })

  const rememberedArea = readCalendarTaskFilters(desired.searchParams).area === undefined ? getRememberedAreaId() : ""
  if (rememberedArea) applyFilters({ area: rememberedArea })
  else previewEvents()
}

function writeCalendarTaskFilters(url: URL, filters: KanbanFilters) {
  updateKanbanFilters(url, filters)
  if (filters.advancedFilter?.conditions.length) {
    url.searchParams.set("advancedFilter", JSON.stringify(filters.advancedFilter))
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
  start: string, end: string, limit: number, readSources: () => Promise<string[]>, signal: AbortSignal,
) {
  const entities = await readSources()
  signal.throwIfAborted()
  const results = await Promise.allSettled(entities.slice(0, limit).map(async entity => {
    const params = new URLSearchParams({ entity_id: entity, start, end })
    const response = await fetch(`/api/ha/events?${params}`, { signal })
    if (!response.ok) throw new Error("Calendar feed unavailable")
    const data = await response.json() as { events?: CalendarEventRecord[] }
    if (!Array.isArray(data.events)) throw new Error("Invalid calendar feed")
    return data.events.filter(event => event && typeof event.start === "string" && typeof event.summary === "string")
  }))
  const events = results.flatMap(result => result.status === "fulfilled" ? result.value : [])
  events.sort((a, b) => a.start.localeCompare(b.start))
  return {
    events,
    partial: results.some(result => result.status === "rejected"),
    available: results.length === 0 || results.some(result => result.status === "fulfilled"),
  }
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

async function loadDrawerTasks(params: URLSearchParams, signal: AbortSignal) {
  const response = await fetch(`/api/tasks?${params}`, { signal })
  if (!response.ok) throw new Error(`Task query failed: ${response.status}`)
  const data = await response.json() as { tasks?: Record<string, unknown>[]; total?: number }
  if (!Array.isArray(data.tasks)) throw new Error("Invalid task list")

  const rows = data.tasks.map(task => {
    const status = String(task.status ?? "")
    const definition = getStatusDef(status)
    const deferred = task.deferred_at != null ? ` · ${window.mI18n?.get("deferral.title") ?? "Deferred"}` : ""
    const priority = task.priority ? ` · P${String(task.priority)}` : ""
    return agendaItem(definition ? mapEntityEmojiToTabler(definition.icon) ?? "checkbox" : "checkbox",
      String(task.title ?? "Untitled task"), `${definition?.label ?? status}${priority}${deferred}`, String(task.id))
  })
  return { rows, total: data.total ?? rows.length }
}

async function loadInlineEventPreviews(
  month: HTMLElement, timezone: string, readSources: () => Promise<string[]>, signal: AbortSignal,
): Promise<void> {
  const cells = Array.from(month.querySelectorAll<HTMLElement>("[data-inline-date]"))
  const start = cells[0]?.dataset.inlineDate
  const lastDay = cells.at(-1)?.dataset.inlineDate
  if (!start || !lastDay) return

  try {
    const { events } = await loadCalendarRange(start, shiftCalendarDay(lastDay, 1), 3, readSources, signal)
    if (signal.aborted) return

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
    if (!signal.aborted) log.warn("Could not load calendar previews", error)
  }
}
