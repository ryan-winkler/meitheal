import type { APIRoute } from "astro"
import { apiError } from "../../../lib/api-response"
import { parseCalendarDay } from "../../../lib/calendar-day"
import { calendarToday, isValidTimezone } from "../../../lib/date"
import { getTodayTaskCounts, readStoredHouseholdTimezone } from "../../../lib/task-queries"

export const GET: APIRoute = async ({ locals, url }) => {
  try {
    const timezone = locals.timezone && isValidTimezone(locals.timezone) ? locals.timezone : await readStoredHouseholdTimezone()
    const now = new Date()
    const expectedDay = url.searchParams.get("expected_day")
    if (expectedDay !== null) {
      if (!parseCalendarDay(expectedDay)) return apiError("expected_day must be a calendar date", 400)
      if (expectedDay !== calendarToday(timezone, now)) return apiError("Today has changed. Refresh the view.", 409)
    }
    return Response.json(await getTodayTaskCounts(now, timezone, url.searchParams.get("completed") === "1"), {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return apiError("Today counts are unavailable. Try again shortly.", 503)
  }
}
