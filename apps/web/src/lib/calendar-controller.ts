import { createClientLogger } from "@lib/client-logger"
import { initPageShellNavigation } from "@lib/page-shell-controller"
import { pageLifecycle } from "@lib/page-lifecycle"
import { taskApi } from "@lib/task-api-client"
import { openTaskDetailHandoff } from "@lib/task-detail-handoff"
import { showToast } from "@lib/toast"
import { CALENDAR_SECTIONS } from "@lib/calendar-registry"

interface CalendarEventRecord {
  summary: string
  start: string
  end: string
  entity_id?: string
}

const log = createClientLogger("tasks", "calendar-shell")
let currentDrawerDate = ""

export function initCalendarPage(): void {
  initPageShellNavigation({
    barId: "calendar-bar",
    shellId: "calendar-shell",
    sectionSelector: "[data-calendar-section]",
    sectionIds: CALENDAR_SECTIONS.map((section) => section.id),
    defaultSectionId: "calendar-overview",
    flashClass: "calendar-shell__section--flash",
    sectionLinkSelectors: ["[data-calendar-section-link]"],
  })

  initCalendarCells()
  initDrawerControls()
  initSyncButton()
  void loadInlineEventPreviews()
}

function initCalendarCells(): void {
  document.querySelectorAll<HTMLElement>(".cal-cell[data-date]").forEach((cell) => {
    const openCell = () => {
      const date = cell.dataset.date
      if (date) {
        openDrawer(date)
      }
    }

    pageLifecycle.on(cell, "click", openCell)
    pageLifecycle.on(cell, "keydown", (event) => {
      const keyboardEvent = event as KeyboardEvent
      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") {
        return
      }

      keyboardEvent.preventDefault()
      openCell()
    })
  })
}

function initDrawerControls(): void {
  const drawer = document.getElementById("day-drawer")
  const closeButton = document.getElementById("day-drawer-close")
  const backdrop = document.getElementById("day-drawer-backdrop")
  const addEventButton = document.getElementById("day-drawer-add-event")
  const addTaskButton = document.getElementById("day-drawer-add-task")
  const drawerTasks = document.getElementById("day-drawer-tasks")

  if (!drawer || !closeButton || !backdrop || !addEventButton || !addTaskButton) {
    return
  }

  pageLifecycle.on(closeButton, "click", closeDrawer)
  pageLifecycle.on(backdrop, "click", closeDrawer)
  pageLifecycle.on(document, "keydown", (event) => {
    const keyboardEvent = event as KeyboardEvent
    if (keyboardEvent.key === "Escape" && drawer.getAttribute("aria-hidden") === "false") {
      closeDrawer()
    }
  })

  const openNewTaskForCurrentDate = () => {
    if (!currentDrawerDate) return
    window.__prefillTaskDate = currentDrawerDate

    if (typeof window.openNewTaskModal === "function") {
      window.openNewTaskModal()
      return
    }

    const fallback = document.getElementById("calendar-bar-new-task") as HTMLButtonElement | null
    fallback?.click()
  }

  pageLifecycle.on(addEventButton, "click", openNewTaskForCurrentDate)
  pageLifecycle.on(addTaskButton, "click", openNewTaskForCurrentDate)

  if (drawerTasks) {
    pageLifecycle.on(drawerTasks, "click", (event) => {
      const item = (event.target as HTMLElement).closest<HTMLElement>("[data-task-id]")
      const taskId = item?.dataset.taskId
      if (!taskId) return

      openTaskDetailHandoff(taskId)
    })
  }
}

function initSyncButton(): void {
  const button = document.getElementById("sync-cal-btn") as HTMLButtonElement | null
  if (!button) return

  pageLifecycle.on(button, "click", async () => {
    const originalLabel = button.querySelector(".unified-bar__new-task-label")?.textContent || "Sync"
    button.disabled = true
    const label = button.querySelector(".unified-bar__new-task-label")
    if (label) label.textContent = "Syncing…"

    try {
      const response = await taskApi.raw("/api/integrations/calendar/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      })
      const data = (await response.json()) as { ok?: boolean }

      if (data.ok) {
        showToast("Calendar sync requested", "success")
        document.dispatchEvent(
          new CustomEvent("meitheal:navigation-changed", {
            detail: { action: "calendar-sync" },
          }),
        )
      } else {
        showToast("Calendar sync failed", "error")
      }
    } catch (error) {
      log.error("Calendar sync failed", error)
      showToast("Calendar sync failed", "error")
    } finally {
      if (label) label.textContent = originalLabel
      button.disabled = false
    }
  })
}

function openDrawer(dateStr: string): void {
  const drawer = document.getElementById("day-drawer")
  const drawerTitle = document.getElementById("day-drawer-title")
  const drawerEvents = document.getElementById("day-drawer-events")
  const drawerTasks = document.getElementById("day-drawer-tasks")
  if (!drawer || !drawerTitle || !drawerEvents || !drawerTasks) return

  currentDrawerDate = dateStr
  const date = new Date(`${dateStr}T00:00:00`)
  drawerTitle.textContent = date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
  drawer.setAttribute("aria-hidden", "false")
  drawerEvents.innerHTML = '<span class="day-drawer-empty">Loading...</span>'
  drawerTasks.innerHTML = '<span class="day-drawer-empty">Loading...</span>'
  document.body.style.overflow = "hidden"

  void loadDrawerData(dateStr)
}

function closeDrawer(): void {
  const drawer = document.getElementById("day-drawer")
  if (!drawer) return

  drawer.setAttribute("aria-hidden", "true")
  document.body.style.overflow = ""
  currentDrawerDate = ""
}

async function fetchCalendarEntities(): Promise<string[]> {
  try {
    const response = await fetch("/api/settings?key=calendar-entities")
    if (!response.ok) return []

    const data = await response.json()
    const rawValue = data?.value
    if (!rawValue) return []

    return typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue
  } catch (error) {
    log.warn("Could not load calendar entities", error)
    return []
  }
}

async function loadDrawerData(dateStr: string): Promise<void> {
  const drawerEvents = document.getElementById("day-drawer-events")
  const drawerTasks = document.getElementById("day-drawer-tasks")
  if (!drawerEvents || !drawerTasks) return

  try {
    const nextDay = new Date(`${dateStr}T00:00:00`)
    nextDay.setDate(nextDay.getDate() + 1)
    const endStr = nextDay.toISOString().split("T")[0] || dateStr
    const entities = await fetchCalendarEntities()
    const events: CalendarEventRecord[] = []

    for (const entityId of entities.slice(0, 5)) {
      try {
        const response = await fetch(
          `/api/ha/events?entity_id=${encodeURIComponent(entityId)}&start=${encodeURIComponent(dateStr)}&end=${encodeURIComponent(endStr)}`,
        )
        if (!response.ok) continue

        const data = await response.json()
        if (Array.isArray(data?.events)) {
          events.push(
            ...data.events.map((event: CalendarEventRecord) => ({
              ...event,
              entity_id: entityId,
            })),
          )
        }
      } catch (error) {
        log.warn("Skipping failing calendar entity", entityId, error)
      }
    }

    if (events.length === 0) {
      drawerEvents.innerHTML = '<span class="day-drawer-empty">No calendar events</span>'
    } else {
      drawerEvents.innerHTML = events.map((event) => {
        const time = event.start.includes("T")
          ? new Date(event.start).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })
          : "All day"
        return `<div class="day-drawer-item">
          <span class="day-drawer-item-icon">📅</span>
          <div class="day-drawer-item-content">
            <div class="day-drawer-item-title">${escapeHtml(event.summary)}</div>
            <div class="day-drawer-item-meta">${time}</div>
          </div>
        </div>`
      }).join("")
    }
  } catch (error) {
    log.error("Failed to load calendar drawer events", error)
    drawerEvents.innerHTML = '<span class="day-drawer-empty">Failed to load events</span>'
  }

  try {
    const response = await fetch(`/api/tasks?due_date=${encodeURIComponent(dateStr)}`)
    if (!response.ok) throw new Error(`Task query failed: ${response.status}`)

    const data = await response.json()
    const tasks = data?.tasks ?? data ?? []
    if (!Array.isArray(tasks) || tasks.length === 0) {
      drawerTasks.innerHTML = '<span class="day-drawer-empty">No tasks due</span>'
      return
    }

    drawerTasks.innerHTML = tasks.map((task: Record<string, unknown>) => {
      const status = String(task.status ?? "")
      const statusIcon =
        status === "done"
          ? "✅"
          : status === "in_progress"
            ? "🔵"
            : "⬜"
      return `<div class="day-drawer-item" data-task-id="${String(task.id)}" style="cursor:pointer">
        <span class="day-drawer-item-icon">${statusIcon}</span>
        <div class="day-drawer-item-content">
          <div class="day-drawer-item-title">${escapeHtml(String(task.title ?? "Untitled task"))}</div>
          <div class="day-drawer-item-meta">${escapeHtml(status)}${task.priority ? ` • P${String(task.priority)}` : ""}</div>
        </div>
      </div>`
    }).join("")
  } catch (error) {
    log.error("Failed to load calendar drawer tasks", error)
    drawerTasks.innerHTML = '<span class="day-drawer-empty">Failed to load tasks</span>'
  }
}

async function loadInlineEventPreviews(): Promise<void> {
  const entities = await fetchCalendarEntities()
  if (entities.length === 0) return

  const cells = document.querySelectorAll<HTMLElement>(".cal-cell[data-date]")
  const dates = Array.from(cells)
    .map((cell) => cell.dataset.date)
    .filter((date): date is string => Boolean(date))
  if (dates.length === 0) return

  const start = dates[0]
  const lastDate = new Date(`${dates[dates.length - 1]}T00:00:00`)
  lastDate.setDate(lastDate.getDate() + 1)
  const end = lastDate.toISOString().split("T")[0]
  if (!start || !end) return

  const allEvents: CalendarEventRecord[] = []
  for (const entityId of entities.slice(0, 3)) {
    try {
      const response = await fetch(
        `/api/ha/events?entity_id=${encodeURIComponent(entityId)}&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`,
      )
      if (!response.ok) continue

      const data = await response.json()
      if (Array.isArray(data?.events)) {
        allEvents.push(...data.events)
      }
    } catch (error) {
      log.warn("Skipping inline preview entity", entityId, error)
    }
  }

  const byDate = new Map<string, CalendarEventRecord[]>()
  for (const event of allEvents) {
    const dateKey = event.start.includes("T") ? event.start.split("T")[0] : event.start
    if (!dateKey) continue

    if (!byDate.has(dateKey)) {
      byDate.set(dateKey, [])
    }
    byDate.get(dateKey)?.push(event)
  }

  for (const [dateKey, events] of byDate) {
    const container = document.querySelector<HTMLElement>(`[data-inline-date="${dateKey}"]`)
    if (!container) continue

    const shown = events.slice(0, 2)
    container.innerHTML = shown.map((event) => {
      const time = event.start.includes("T")
        ? new Date(event.start).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })
        : "☀"
      return `<div class="cal-inline-event cal-inline-ha" title="${escapeHtml(event.summary)}">${time} ${escapeHtml(event.summary)}</div>`
    }).join("")

    if (events.length > shown.length) {
      container.innerHTML += `<span class="cal-inline-more">+${events.length - shown.length} more</span>`
    }
  }
}

function escapeHtml(value: string): string {
  const element = document.createElement("span")
  element.textContent = value
  return element.innerHTML
}
