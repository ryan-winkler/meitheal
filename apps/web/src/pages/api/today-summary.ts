/**
 * GET /api/today-summary — Today summary for HA dashboard widget
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Returns a JSON summary of today's task counts, streak, and XP
 * designed for consumption by a Home Assistant custom dashboard card
 * or REST sensor.
 *
 * @kcs This endpoint enables HA integration via REST sensor:
 * ```yaml
 * sensor:
 *   - platform: rest
 *     name: Meitheal Today
 *     resource: http://localhost:3000/api/today-summary
 *     json_attributes:
 *       - dueToday
 *       - completedToday
 *       - carriedForward
 *       - remaining
 *       - streak
 *       - todayXP
 *     value_template: "{{ value_json.remaining }}"
 * ```
 */
import type { APIRoute } from "astro"
import { getTasksForView } from "../../lib/task-queries"
import { apiLogger, logApiError } from "../../lib/api-logger"

export const GET: APIRoute = async () => {
  try {
    const { tasks } = await getTasksForView()

    const todayStr = new Date().toISOString().split("T")[0] ?? ""
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    let dueToday = 0
    let completedToday = 0
    let carriedForward = 0

    for (const task of tasks) {
      if (task.is_done && task.updated_at?.startsWith(todayStr)) {
        completedToday++
        continue
      }
      if (task.is_done) continue

      if (task.due_date === todayStr) {
        dueToday++
      } else if (task.due_date) {
        const d = new Date(task.due_date)
        d.setHours(0, 0, 0, 0)
        if (d < today) carriedForward++
      }
    }

    const remaining = dueToday + carriedForward

    // Focus Stack — top 3 actionable tasks ranked by urgency for ADHD decision support
    // Ranking: overdue first → highest priority → nearest due date → most recently updated
    const actionable = tasks
      .filter(t => !t.is_done && (t.due_date === todayStr || (t.due_date && new Date(t.due_date) < today)))
      .sort((a, b) => {
        // Overdue tasks first
        const aOverdue = a.due_date && a.due_date < todayStr ? 1 : 0
        const bOverdue = b.due_date && b.due_date < todayStr ? 1 : 0
        if (aOverdue !== bOverdue) return bOverdue - aOverdue
        // Higher priority (lower number = higher priority)
        const aPri = Number(a.priority ?? 3)
        const bPri = Number(b.priority ?? 3)
        if (aPri !== bPri) return aPri - bPri
        // Nearest due date
        if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date)
        return 0
      })
      .slice(0, 3)
      .map(t => ({
        id: String(t.id),
        title: String(t.title ?? ""),
        priority: Number(t.priority ?? 3),
        due_date: t.due_date ? String(t.due_date) : null,
        is_overdue: Boolean(t.due_date && t.due_date < todayStr),
        area_id: t.area_id ? String(t.area_id) : null,
      }))

    // Gamification stats
    let streak = 0
    let todayXP = 0
    try {
      const { getStats, getWeeklyData } = await import("@domains/gamification")
      const stats = await getStats()
      streak = stats.currentStreak ?? 0
      const weekly = await getWeeklyData()
      const todayRecord = weekly[weekly.length - 1]
      todayXP = todayRecord?.points ?? 0
    } catch { /* gamification may not be available */ }

    const summary = {
      dueToday,
      completedToday,
      carriedForward,
      remaining,
      /** Top 3 actionable tasks ranked by urgency — ADHD Focus Stack */
      focusStack: actionable,
      streak,
      todayXP,
      timestamp: new Date().toISOString(),
    }

    apiLogger.log("info", {
      event: "today-summary.fetched",
      domain: "tasks",
      component: "today-summary",
      request_id: "ha-widget",
      message: `Today: ${dueToday} due, ${completedToday} done, ${carriedForward} carried, streak=${streak}`,
    })

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-cache, max-age=0",
      },
    })
  } catch (err: unknown) {
    logApiError("GET", "/api/today-summary", err)
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    })
  }
}
