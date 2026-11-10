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
import { escapeHtml } from "../safe-html"

export async function setupCalendarEvents(lm: ListenerManager): Promise<void> {
  const section = document.getElementById("section-calendar-events")
  const list = document.getElementById("calendar-events-list")
  const countEl = document.getElementById("calendar-events-count")
  if (!section || !list || !countEl) return

  const todayStr = new Date().toISOString().split("T")[0]!
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split("T")[0]!

  try {
    // Discover calendars
    const calRes = await fetch("/api/ha/calendars", { signal: lm.signal })
    if (!calRes.ok) return // HA not connected
    const calData = await calRes.json() as { calendars?: Array<{ entity_id: string; name: string }> }
    const calendars = calData.calendars ?? []
    if (calendars.length === 0) return

    // Fetch events from all calendars
    interface CalEvent { summary: string; start: string; end: string; description?: string }
    const allEvents: Array<CalEvent & { source: string }> = []

    await Promise.all(calendars.map(async (cal) => {
      try {
        const res = await fetch(`/api/ha/events?entity_id=${encodeURIComponent(cal.entity_id)}&start=${todayStr}&end=${tomorrowStr}`, { signal: lm.signal })
        if (!res.ok) return
        const data = await res.json() as { ok: boolean; events?: CalEvent[] }
        if (data.ok && data.events) {
          for (const evt of data.events) {
            allEvents.push({ ...evt, source: cal.name })
          }
        }
      } catch { /* individual calendar fail OK */ }
    }))

    if (allEvents.length === 0) return

    // Sort by start time
    allEvents.sort((a, b) => a.start.localeCompare(b.start))

    // Render
    countEl.textContent = `(${allEvents.length})`
    section.style.display = ""
    list.innerHTML = allEvents.map(evt => {
      const startDate = new Date(evt.start)
      const endDate = new Date(evt.end)
      const isAllDay = !evt.start.includes("T")
      const timeStr = isAllDay
        ? "All day"
        : `${startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${endDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`

      return `
        <div class="calendar-event-card card" title="${escapeHtml(evt.description ?? "")}">
          <div class="calendar-event-card__time">${timeStr}</div>
          <div class="calendar-event-card__title">${escapeHtml(evt.summary)}</div>
          <div class="calendar-event-card__source">${escapeHtml(evt.source)}</div>
        </div>
      `
    }).join("")
  } catch {
    /* HA not available — fail silently */
  }
}
