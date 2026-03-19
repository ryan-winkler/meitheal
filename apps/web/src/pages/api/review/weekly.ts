/**
 * GET /api/review/weekly — Weekly Review aggregation endpoint
 *
 * @domain tasks
 * @bounded-context tasks (analytics)
 *
 * Returns a GTD-style weekly review summary with:
 * - Completion velocity (tasks completed per day for past 7 days)
 * - Carried-forward count (open tasks that were due before this week)
 * - Priority distribution (P1-P5 breakdown of completed tasks)
 * - Label breakdown (which categories got attention)
 * - Streak info (current completion streak)
 * - Overdue summary (tasks still overdue)
 *
 * Designed for:
 * 1. Weekly Review page in Meitheal UI
 * 2. HA REST sensor for dashboard automation
 * 3. LLM daily briefing context
 *
 * @kcs HA sensor config:
 * ```yaml
 * sensor:
 *   - platform: rest
 *     name: Meitheal Weekly Review
 *     resource: http://localhost:3000/api/review/weekly
 *     json_attributes:
 *       - totalCompleted
 *       - totalCreated
 *       - carriedForward
 *       - overdue
 *       - velocity
 *       - priorityBreakdown
 *     value_template: "{{ value_json.totalCompleted }}"
 *     scan_interval: 3600
 * ```
 */
import type { APIRoute } from "astro"
import { getTasksForView } from "../../../lib/task-queries"
import { apiLogger, logApiError } from "../../../lib/api-logger"

/** Shape of each day's velocity data point */
interface DayVelocity {
  date: string
  completed: number
  created: number
}

/** Priority breakdown for the week */
interface PriorityBreakdown {
  p1_urgent: number
  p2_high: number
  p3_medium: number
  p4_low: number
  p5_lowest: number
}

export const GET: APIRoute = async () => {
  try {
    const { tasks } = await getTasksForView()

    const now = new Date()
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const todayStr = today.toISOString().split("T")[0] ?? ""

    // Calculate 7-day window
    const weekAgo = new Date(today)
    weekAgo.setDate(weekAgo.getDate() - 7)
    const weekAgoStr = weekAgo.toISOString().split("T")[0] ?? ""

    // Initialize daily velocity map (last 7 days)
    const velocityMap = new Map<string, DayVelocity>()
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split("T")[0] ?? ""
      velocityMap.set(ds, { date: ds, completed: 0, created: 0 })
    }

    let totalCompleted = 0
    let totalCreated = 0
    let carriedForward = 0
    let overdue = 0
    const priorityBreakdown: PriorityBreakdown = {
      p1_urgent: 0,
      p2_high: 0,
      p3_medium: 0,
      p4_low: 0,
      p5_lowest: 0,
    }
    const labelCounts = new Map<string, number>()
    const areaCounts = new Map<string, number>()

    for (const task of tasks) {
      const updatedDay = task.updated_at?.split("T")[0] ?? ""
      const createdDay = task.created_at?.split("T")[0] ?? ""

      // Count completed this week
      if (task.is_done && updatedDay >= weekAgoStr && updatedDay <= todayStr) {
        totalCompleted++

        // Daily velocity
        const dayEntry = velocityMap.get(updatedDay)
        if (dayEntry) dayEntry.completed++

        // Priority breakdown
        const pri = Number(task.priority ?? 3)
        if (pri === 1) priorityBreakdown.p1_urgent++
        else if (pri === 2) priorityBreakdown.p2_high++
        else if (pri === 3) priorityBreakdown.p3_medium++
        else if (pri === 4) priorityBreakdown.p4_low++
        else priorityBreakdown.p5_lowest++

        // Label breakdown
        if (task.labels) {
          const labelStr = String(task.labels)
          try {
            const parsed = JSON.parse(labelStr)
            const labels = Array.isArray(parsed) ? parsed as string[] : []
            for (const label of labels) {
              labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
            }
          } catch {
            /* labels might be comma-separated string */
            const labels = labelStr.split(",").map((l: string) => l.trim()).filter(Boolean)
            for (const label of labels) {
              labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
            }
          }
        }

        // Area breakdown
        if (task.area_id) {
          areaCounts.set(
            String(task.area_id),
            (areaCounts.get(String(task.area_id)) ?? 0) + 1,
          )
        }
      }

      // Count created this week
      if (createdDay >= weekAgoStr && createdDay <= todayStr) {
        totalCreated++
        const dayEntry = velocityMap.get(createdDay)
        if (dayEntry) dayEntry.created++
      }

      // Carried forward (not done, due before this week)
      if (!task.is_done && task.due_date && task.due_date < weekAgoStr) {
        carriedForward++
      }

      // Currently overdue (not done, due before today)
      if (!task.is_done && task.due_date && task.due_date < todayStr) {
        overdue++
      }
    }

    // Convert maps to sorted arrays
    const velocity = Array.from(velocityMap.values())
    const topLabels = Array.from(labelCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([label, count]) => ({ label, count }))
    const areaActivity = Array.from(areaCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([areaId, count]) => ({ areaId, count }))

    // Compute averages
    const avgPerDay = totalCompleted / 7
    const completionRate = totalCreated > 0
      ? Math.round((totalCompleted / totalCreated) * 100)
      : 0

    // Net flow: positive = completing more than creating
    const netFlow = totalCompleted - totalCreated

    const summary = {
      period: {
        start: weekAgoStr,
        end: todayStr,
        days: 7,
      },
      totalCompleted,
      totalCreated,
      carriedForward,
      overdue,
      avgPerDay: Math.round(avgPerDay * 10) / 10,
      completionRate,
      netFlow,
      velocity,
      priorityBreakdown,
      topLabels,
      areaActivity,
    }

    apiLogger.log("info", {
      event: "review.weekly",
      domain: "tasks",
      component: "api/review/weekly",
      request_id: "system",
      message: `Weekly review: ${totalCompleted} done, ${totalCreated} created, ${overdue} overdue`,
    })

    return new Response(JSON.stringify(summary), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
    })
  } catch (err) {
    logApiError("review/weekly", "Failed to generate weekly review", err)
    return new Response(JSON.stringify({ error: "Failed to generate weekly review" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
