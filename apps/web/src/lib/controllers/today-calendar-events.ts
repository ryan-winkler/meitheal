/**
 * Today Calendar Events — G28
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Fetches today's HA calendar events and renders them
 * in the calendar events section of the Today page.
 */

import type { ListenerManager } from "../managed-listeners"
import { calendarEventDay, compareCalendarStarts, resolveTimezone, shiftCalendarDay } from "../date"
import { householdToday } from "../quick-add"

export async function setupCalendarEvents(lm: ListenerManager): Promise<void> {
  const section = document.getElementById("section-calendar-events")
  const list = document.getElementById("calendar-events-list")
  const countEl = document.getElementById("calendar-events-count")
  if (!section || !list || !countEl) return

  const timeZone = resolveTimezone(typeof window !== "undefined" ? window.mSettings?.timezone : undefined)
  const todayStr = householdToday()
  const startParam = `${shiftCalendarDay(todayStr, -1)}T00:00:00Z`
  const endParam = `${shiftCalendarDay(todayStr, 2)}T00:00:00Z`

  try {
    // Discover configured calendars for this board
    const calRes = await fetch("/api/ha/calendars?configured=1", { signal: lm.signal })
    if (!calRes.ok) return // HA not connected
    const calData = await calRes.json() as {
      entities?: string[]
      calendars?: Array<{ entity_id: string; friendly_name?: string; name?: string }>
    }
    const sources: Array<{ entity_id: string; name: string }> = Array.isArray(calData.entities)
      ? calData.entities.map(entity_id => ({
          entity_id,
          name: entity_id.replace(/^calendar\./, "").replace(/_/g, " "),
        }))
      : (calData.calendars ?? []).map(cal => ({
          entity_id: cal.entity_id,
          name: cal.friendly_name || cal.name || cal.entity_id,
        }))
    if (sources.length === 0) return

    // Fetch events from configured calendars
    interface CalEvent { summary: string; start: string; end: string; description?: string }
    const allEvents: Array<CalEvent & { source: string }> = []

    await Promise.all(sources.map(async (cal) => {
      try {
        const res = await fetch(
          `/api/ha/events?entity_id=${encodeURIComponent(cal.entity_id)}&start=${encodeURIComponent(startParam)}&end=${encodeURIComponent(endParam)}`,
          { signal: lm.signal },
        )
        if (!res.ok) return
        const data = await res.json() as { events?: CalEvent[] }
        if (Array.isArray(data.events)) {
          for (const evt of data.events) {
            if (!evt || typeof evt.start !== "string" || typeof evt.summary !== "string") continue
            const startDay = calendarEventDay(evt.start, timeZone)
            const endDay = typeof evt.end === "string" ? calendarEventDay(evt.end, timeZone, "exclusive-end") : startDay
            if (startDay && endDay && startDay <= todayStr && endDay >= todayStr) {
              allEvents.push({ ...evt, source: cal.name })
            } else if (startDay === todayStr) {
              allEvents.push({ ...evt, source: cal.name })
            }
          }
        }
      } catch { /* individual calendar fail OK */ }
    }))

    if (allEvents.length === 0) return

    // Sort by start instant in household timezone
    allEvents.sort((a, b) => compareCalendarStarts(a.start, b.start, timeZone))

    // Render
    countEl.textContent = `(${allEvents.length})`
    section.style.display = ""
    list.replaceChildren(
      ...allEvents.map(evt => {
        const startDate = new Date(evt.start)
        const endDate = new Date(evt.end)
        const isAllDay = !evt.start.includes("T")
        const timeStr = isAllDay
          ? "All day"
          : `${startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone })} – ${endDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone })}`

        const card = document.createElement("div")
        card.className = "calendar-event-card card"
        card.title = evt.description ?? ""

        const timeDiv = document.createElement("div")
        timeDiv.className = "calendar-event-card__time"
        timeDiv.textContent = timeStr

        const titleDiv = document.createElement("div")
        titleDiv.className = "calendar-event-card__title"
        titleDiv.textContent = evt.summary

        const sourceDiv = document.createElement("div")
        sourceDiv.className = "calendar-event-card__source"
        sourceDiv.textContent = evt.source

        card.append(timeDiv, titleDiv, sourceDiv)
        return card
      }),
    )
  } catch {
    /* HA not available — fail silently */
  }
}
