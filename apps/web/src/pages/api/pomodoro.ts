import { boardScopeErrorResponse } from "@lib/board-http"
import { withBoardScope } from "@lib/board-http"
import type { APIRoute } from "astro"
import {
  PomodoroTaskUnavailableError,
  getTimerState,
  startFocus,
  skipToBreak,
  skipBreak,
  cancelSession,
  getSessionHistory,
  getTodayStats,
} from "@domains/pomodoro"
import { apiJson, apiError } from "../../lib/api-response"

/**
 * Pomodoro API
 *
 * GET  /api/pomodoro — Get current timer state + today's stats
 * POST /api/pomodoro — Timer actions: start, skip, cancel
 *
 * @domain pomodoro
 * @bounded-context pomodoro
 */

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async ({ url }, scope) => {
  try {
    const includeHistory = url.searchParams.get("history") === "true"
    const state = await getTimerState(scope)
    const today = await getTodayStats(scope)

    const result: Record<string, unknown> = { state, today }

    if (includeHistory) {
      result.history = await getSessionHistory(scope)
    }

    return apiJson(result)
  } catch (err) {
    const scopeFailure = boardScopeErrorResponse(err)
    if (scopeFailure) return scopeFailure
    return apiError("Failed to get pomodoro state")
  }
})

export const POST: APIRoute = withBoardScope({ resource: "task", action: "edit" }, async ({ request }, scope) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || "")

    let state

    switch (action) {
      case "start":
        state = await startFocus(scope, body.taskId ? String(body.taskId) : null)
        break
      case "skip_to_break":
        state = await skipToBreak(scope)
        break
      case "skip_break":
        state = await skipBreak(scope)
        break
      case "cancel":
        state = await cancelSession(scope)
        break
      default:
        return apiError("Invalid action. Use: start, skip_to_break, skip_break, cancel", 400)
    }

    return apiJson({ state })
  } catch (err) {
    const scopeFailure = boardScopeErrorResponse(err)
    if (scopeFailure) return scopeFailure
    if (err instanceof PomodoroTaskUnavailableError) return apiError("Task unavailable", 404)
    return apiError("Failed to execute pomodoro action")
  }
})
