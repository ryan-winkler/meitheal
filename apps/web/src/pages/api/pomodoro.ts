import type { APIRoute } from "astro"
import {
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

export const GET: APIRoute = async ({ url }) => {
  try {
    const includeHistory = url.searchParams.get("history") === "true"
    const state = getTimerState()
    const today = await getTodayStats()

    const result: Record<string, unknown> = { state, today }

    if (includeHistory) {
      result.history = await getSessionHistory()
    }

    return apiJson(result)
  } catch (err) {
    return apiError("Failed to get pomodoro state")
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = String(body.action || "")

    let state

    switch (action) {
      case "start":
        state = await startFocus(body.taskId ? String(body.taskId) : null)
        break
      case "skip_to_break":
        state = await skipToBreak()
        break
      case "skip_break":
        state = await skipBreak()
        break
      case "cancel":
        state = await cancelSession()
        break
      default:
        return apiError("Invalid action. Use: start, skip_to_break, skip_break, cancel", 400)
    }

    return apiJson({ state })
  } catch (err) {
    return apiError("Failed to execute pomodoro action")
  }
}
