import { readBoardPagePlacement } from "@lib/board-page-placement"
import { withBoardScope, boardScopeResponse } from "@lib/board-http"
import type { APIRoute } from "astro"
import { apiError } from "../../../lib/api-response"
import { calendarToday, isValidTimezone } from "../../../lib/date"
import { getTodayTaskCounts, readStoredHouseholdTimezone, todayScopeProblem } from "../../../lib/task-queries"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async ({ locals, url }, scope) => {
  try {
    const timezone = locals.timezone && isValidTimezone(locals.timezone) ? locals.timezone : await readStoredHouseholdTimezone()
    const now = new Date()
    const problem = todayScopeProblem(url.searchParams, timezone, calendarToday(timezone, now))
    if (problem) return apiError(problem.error, problem.status)
    const selected = await readBoardPagePlacement(scope, url)
    if (!selected.ok) return boardScopeResponse(selected.errorCode)
    return Response.json(await getTodayTaskCounts(now, timezone, url.searchParams.get("completed") === "1", scope, selected.placement), {
      headers: { "cache-control": "private, no-store" },
    })
  } catch {
    return apiError("Today counts are unavailable. Try again shortly.", 503)
  }
})
