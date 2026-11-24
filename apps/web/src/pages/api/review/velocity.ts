import { withBoardScope } from "@lib/board-http"
/**
 * GET /api/review/velocity — Velocity sparkline data
 *
 * @domain tasks
 * @bounded-context tasks (analytics)
 *
 * Returns task completion velocity over a configurable period (default 30 days).
 * Designed for dashboard sparkline widgets and HA Lovelace history graphs.
 *
 * Query params:
 *   ?days=30  — Number of days to look back (max 90)
 *
 * @kcs HA sensor config:
 * ```yaml
 * sensor:
 *   - platform: rest
 *     name: Meitheal Velocity
 *     resource: http://localhost:3000/api/review/velocity?days=14
 *     json_attributes:
 *       - dataPoints
 *       - average
 *       - trend
 *     value_template: "{{ value_json.average }}"
 *     scan_interval: 3600
 * ```
 */
import type { APIRoute } from "astro"
import { getTasksForView } from "../../../lib/task-queries"
import { calendarDayFromInput, calendarToday, resolveTimezone, shiftCalendarDay } from "../../../lib/date"
import { apiLogger, logApiError } from "../../../lib/api-logger"

export const GET: APIRoute = withBoardScope({ resource: "task", action: "read" }, async ({ url, locals }, scope) => {
  try {
    const daysParam = url.searchParams.get("days")
    const days = Math.min(Math.max(Math.trunc(Number(daysParam) || 30), 1), 90)
    const timezone = resolveTimezone(locals.timezone)
    const { tasks } = await getTasksForView({ timezone }, scope)
    const todayStr = calendarToday(timezone)
    const startStr = shiftCalendarDay(todayStr, 1 - days)

    const dailyCounts = new Map<string, number>()
    for (let i = days - 1; i >= 0; i--) {
      dailyCounts.set(shiftCalendarDay(todayStr, -i), 0)
    }

    for (const task of tasks) {
      if (!task.is_done) continue
      const completedDay = calendarDayFromInput(task.updated_at, timezone)
      if (completedDay !== null && dailyCounts.has(completedDay)) {
        dailyCounts.set(completedDay, dailyCounts.get(completedDay)! + 1)
      }
    }

    // Convert to array
    const dataPoints = Array.from(dailyCounts.entries()).map(([date, count]) => ({
      date,
      count,
    }))

    // Calculate average and trend
    const total = dataPoints.reduce((sum, dp) => sum + dp.count, 0)
    const average = Math.round((total / days) * 10) / 10

    // Simple trend: compare first half vs second half
    const mid = Math.floor(dataPoints.length / 2)
    const firstHalf = dataPoints.slice(0, mid)
    const secondHalf = dataPoints.slice(mid)
    const firstAvg = firstHalf.reduce((s, d) => s + d.count, 0) / (firstHalf.length || 1)
    const secondAvg = secondHalf.reduce((s, d) => s + d.count, 0) / (secondHalf.length || 1)

    let trend: "up" | "down" | "stable" = "stable"
    if (secondAvg > firstAvg * 1.15) trend = "up"
    else if (secondAvg < firstAvg * 0.85) trend = "down"

    // Peak day
    const peak = dataPoints.reduce(
      (best, dp) => (dp.count > best.count ? dp : best),
      dataPoints[0] ?? { date: todayStr, count: 0 },
    )

    const result = {
      period: { start: startStr, end: todayStr, days },
      dataPoints,
      total,
      average,
      trend,
      peak: { date: peak.date, count: peak.count },
    }

    apiLogger.log("info", {
      event: "review.velocity",
      domain: "tasks",
      component: "api/review/velocity",
      request_id: "system",
      message: `Velocity: ${total} tasks in ${days} days (avg ${average}/day, trend: ${trend})`,
    })

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=600",
      },
    })
  } catch (err) {
    logApiError("review/velocity", "Failed to generate velocity data", err)
    return new Response(JSON.stringify({ error: "Failed to generate velocity data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})
