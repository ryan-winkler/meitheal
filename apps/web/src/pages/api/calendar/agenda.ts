import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient, TaskRepository } from "@domains/tasks"
import { logApiError } from "../../../lib/api-logger"
import { apiError } from "../../../lib/api-response"
import { readWithinLimit } from "../../../lib/bounded-body"
import { parseCalendarDay } from "../../../lib/calendar-day"
import { createCalendarTaskFilter } from "../../../lib/calendar-task-filter"
import { isValidTimezone } from "../../../lib/date"
import { db503Response, isDbUnavailable } from "../../../lib/db-fallback"
import { readStoredHouseholdTimezone } from "../../../lib/task-queries"

const filtersLimit = 20_000

export const POST: APIRoute = async ({ request, locals }) => {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return apiError("Send the Calendar query as JSON", 415)
  }

  // The month filters have already been URL-encoded. Put them in the body once
  // so encoded labels and rules do not expand past ingress request-line limits.
  const deadline = AbortSignal.timeout(5_000)
  let input: unknown
  try {
    const bytes = await readWithinLimit(request.body, filtersLimit + 128, AbortSignal.any([request.signal, deadline]))
    if (bytes === null) return apiError("Calendar query exceeds the supported size", 413)
    input = JSON.parse(bytes.toString("utf8"))
  } catch {
    return deadline.aborted ? apiError("Calendar query timed out", 408) : apiError("Invalid Calendar query", 400)
  }
  if (!input || typeof input !== "object") return apiError("Invalid Calendar query", 400)
  const { date, filters, limit, offset } = input as Record<string, unknown>
  if (typeof date !== "string" || !parseCalendarDay(date) || typeof filters !== "string" ||
      filters.length > filtersLimit || typeof limit !== "number" || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 100 || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    return apiError("Provide a Calendar day, supported filters, and a valid page", 400)
  }

  try {
    await ensureSchema()
    const configuredTimezone = locals.timezone?.trim() ?? ""
    const timezone = isValidTimezone(configuredTimezone) ? configuredTimezone : await readStoredHouseholdTimezone()
    const filter = createCalendarTaskFilter(new URLSearchParams(filters), timezone)
    const repo = new TaskRepository(getPersistenceClient())
    const { tasks, total } = await repo.findAll({ calendarDay: date, timezone, matchDueTask: filter.matchesAgenda, limit, offset })
    return Response.json({
      tasks: tasks.map(({ id, title, status, priority, task_kind, start_date, deferred_at }) => ({
        id, title, status, priority: Number(priority ?? 3), task_kind, start_date, deferred_at,
      })),
      total,
    }, { headers: { "cache-control": "no-store" } })
  } catch (error) {
    if (isDbUnavailable(error)) return db503Response("calendar-agenda", error)
    logApiError("calendar-agenda", "Could not load scheduled work", error)
    return apiError("Could not load scheduled work")
  }
}
