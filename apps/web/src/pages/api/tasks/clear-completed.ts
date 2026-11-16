/**
 * POST /api/tasks/clear-completed — Archive tasks completed today
 *
 * @domain tasks
 * @bounded-context tasks (persistence)
 *
 * Archives completed tasks from the same household day as the Today counter.
 * Used by the Today page's "Archive completed" button.
 *
 * @kcs The archived status retains the task in storage.
 */
import type { APIRoute } from "astro"
import { rejectBoardSelectionInJson } from "@domains/tasks/board-availability"
import {
  ensureSchema,
  getPersistenceClient,
} from "@domains/tasks/persistence/store"
import { parseCalendarDay } from "../../../lib/calendar-day"
import { apiError } from "../../../lib/api-response"
import { calendarToday, isValidTimezone } from "../../../lib/date"
import { readStoredHouseholdTimezone, todayCompletionFilter } from "../../../lib/task-queries"
import { apiLogger, logApiError } from "../../../lib/api-logger"

export const POST: APIRoute = async ({ request, url, locals }) => {
  try {
    const boardSelection = await rejectBoardSelectionInJson(request)
    if (boardSelection) return boardSelection
    await ensureSchema()
    const client = getPersistenceClient()
    const timezone = locals.timezone && isValidTimezone(locals.timezone) ? locals.timezone : await readStoredHouseholdTimezone()
    const today = calendarToday(timezone)
    const expectedDay = url.searchParams.get("expected_day")
    if (expectedDay !== null) {
      if (!parseCalendarDay(expectedDay)) return apiError("expected_day must be a calendar date", 400)
      if (expectedDay !== today) return apiError("Today has changed. Review the completed tasks before archiving.", 409)
    }
    const filter = todayCompletionFilter(today, timezone)
    const result = await client.execute({
      sql: `UPDATE tasks SET status = 'archived', updated_at = ? WHERE ${filter.sql}`,
      args: [Date.now(), ...filter.args],
    })
    const count = result.rowsAffected

    apiLogger.log("info", {
      event: "clear-completed.success",
      domain: "tasks",
      component: "clear-completed",
      request_id: "today-clear",
      message: `Archived ${count} completed tasks`,
    })

    return new Response(
      JSON.stringify({
        ok: true,
        cleared: count,
        ...(count === 0 ? { message: "No completed tasks to clear" } : {}),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  } catch (err: unknown) {
    logApiError("POST", "/api/tasks/clear-completed", err)
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { "content-type": "application/json" } },
    )
  }
}
