import type { APIRoute } from "astro"
import {
  getStats,
  getWeeklyData,
  getLevel,
  getProgressToNextLevel,
  getXpToNextLevel,
  getAllAchievements,
  getYearlyHeatmapData,
} from "@domains/gamification"
import { apiJson, apiError } from "../../lib/api-response"
import { isFeatureEnabled } from "../../lib/feature-flags"

/**
 * Gamification API
 * GET /api/gamification — Get stats, level, achievements, heatmap
 * POST /api/gamification — Retired; complete the task through its ordinary API
 *
 * Gated behind the `gamification` feature flag.
 */

const featureGuard = async () => {
  if (!(await isFeatureEnabled("gamification"))) {
    return apiError("Gamification is disabled in settings", 404)
  }
  return null
}

export const GET: APIRoute = async ({ url }) => {
  const guardResult = await featureGuard()
  if (guardResult) return guardResult
  try {
    const includeHeatmap = url.searchParams.get("heatmap") === "true"
    const [stats, weekly, achievementData] = await Promise.all([
      getStats(),
      getWeeklyData(),
      getAllAchievements(),
    ])

    const level = getLevel(stats.totalPoints)
    const progressToNext = getProgressToNextLevel(stats.totalPoints)
    const xpToNext = getXpToNextLevel(stats.totalPoints)

    const result: Record<string, unknown> = {
      stats,
      weekly,
      daily_goal: 5,
      confetti: await isFeatureEnabled("confetti"),
      level,
      progressToNext,
      xpToNext,
      achievements: achievementData,
    }

    if (includeHeatmap) {
      const year = url.searchParams.get("year")
        ? Number(url.searchParams.get("year"))
        : undefined
      result.heatmap = await getYearlyHeatmapData(year)
    }

    return apiJson(result)
  } catch (err) {
    return apiError("Failed to get gamification stats")
  }
}

/** Legacy client-side recording cannot prove a task transition and would double count. */
export const POST: APIRoute = async () => apiError("Complete a task through /api/tasks/{id}; completion statistics are recorded automatically", 410)
