/**
 * Gamification Domain — Streak Tracker
 *
 * @domain gamification
 * @bounded-context gamification
 *
 * Tracks daily task completion counts and maintains streak data.
 * Streak resets on a missed day (no grace period in v1).
 *
 * @kcs The gamification_stats table stores one row per day with:
 * - date: ISO date string (YYYY-MM-DD)
 * - completed_count: tasks completed that day
 * - streak_count: consecutive days streak as of that date
 * - points: XP earned that day (Phase 5)
 *
 * @kcs Priority-to-XP mapping (GAM-05):
 * P1 (Critical) = 50 XP, P2 (High) = 40 XP, P3 (Medium) = 30 XP,
 * P4 (Low) = 20 XP, P5 (Minimal) = 10 XP
 */

import {
  ensureSchema,
  getPersistenceClient,
} from "@domains/tasks/persistence/store"

/**
 * XP points awarded per priority level.
 * Higher priority = more reward for completing it.
 */
const PRIORITY_XP: Record<number, number> = {
  1: 50,
  2: 40,
  3: 30,
  4: 20,
  5: 10,
}

/**
 * Resolve XP points from a priority value.
 * Falls back to 30 XP (medium) for unknown priorities.
 */
export function getXpForPriority(priority: number): number {
  return PRIORITY_XP[priority] ?? 30
}

export interface GamificationStats {
  currentStreak: number
  longestStreak: number
  todayCompleted: number
  totalCompleted: number
  totalPoints: number
}

export interface DailyRecord {
  date: string
  completedCount: number
  streakCount: number
  points: number
}

let schemaEnsured = false

/**
 * Ensure gamification schema exists.
 * Creates the gamification_stats table if it doesn't exist.
 */
export async function ensureGamificationSchema(): Promise<void> {
  if (schemaEnsured) return
  await ensureSchema()
  const client = getPersistenceClient()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS gamification_stats (
      date TEXT PRIMARY KEY,
      completed_count INTEGER NOT NULL DEFAULT 0,
      streak_count INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0
    )
  `)

  schemaEnsured = true
}

/**
 * Record a task completion. Increments today's count and updates streak.
 * @param points - XP points to award (default: 0, Phase 5 adds weighted points)
 */
export async function recordTaskCompletion(points = 0): Promise<GamificationStats> {
  await ensureGamificationSchema()
  const client = getPersistenceClient()
  const today = new Date().toISOString().split("T")[0]!

  // Get yesterday's streak
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split("T")[0]!

  const prevResult = await client.execute({
    sql: "SELECT streak_count FROM gamification_stats WHERE date = ? LIMIT 1",
    args: [yesterdayStr],
  })
  const prevStreak = prevResult.rows.length > 0
    ? Number((prevResult.rows[0] as Record<string, unknown>).streak_count)
    : 0

  // Check if today already has a record
  const todayResult = await client.execute({
    sql: "SELECT completed_count, streak_count, points FROM gamification_stats WHERE date = ? LIMIT 1",
    args: [today],
  })

  if (todayResult.rows.length > 0) {
    // Update existing record
    const row = todayResult.rows[0] as Record<string, unknown>
    const newCount = Number(row.completed_count) + 1
    const newPoints = Number(row.points) + points
    await client.execute({
      sql: "UPDATE gamification_stats SET completed_count = ?, points = ? WHERE date = ?",
      args: [newCount, newPoints, today],
    })
  } else {
    // New day — streak continues if yesterday had completions
    const newStreak = prevStreak > 0 ? prevStreak + 1 : 1
    await client.execute({
      sql: "INSERT INTO gamification_stats(date, completed_count, streak_count, points) VALUES(?, 1, ?, ?)",
      args: [today, newStreak, points],
    })
  }

  return getStats()
}

/**
 * Get current gamification stats.
 */
export async function getStats(): Promise<GamificationStats> {
  await ensureGamificationSchema()
  const client = getPersistenceClient()
  const today = new Date().toISOString().split("T")[0]!

  // Today's record
  const todayResult = await client.execute({
    sql: "SELECT completed_count, streak_count, points FROM gamification_stats WHERE date = ? LIMIT 1",
    args: [today],
  })

  let currentStreak = 0
  let todayCompleted = 0

  if (todayResult.rows.length > 0) {
    const row = todayResult.rows[0] as Record<string, unknown>
    todayCompleted = Number(row.completed_count)
    currentStreak = Number(row.streak_count)
  } else {
    // No record today — check if yesterday had a streak (not yet broken until midnight)
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yesterdayStr = yesterday.toISOString().split("T")[0]!
    const prevResult = await client.execute({
      sql: "SELECT streak_count FROM gamification_stats WHERE date = ? LIMIT 1",
      args: [yesterdayStr],
    })
    if (prevResult.rows.length > 0) {
      currentStreak = Number((prevResult.rows[0] as Record<string, unknown>).streak_count)
    }
  }

  // Longest streak
  const maxResult = await client.execute(
    "SELECT MAX(streak_count) as max_streak FROM gamification_stats",
  )
  const longestStreak = maxResult.rows.length > 0
    ? Number((maxResult.rows[0] as Record<string, unknown>).max_streak ?? 0)
    : 0

  // Totals
  const totals = await client.execute(
    "SELECT COALESCE(SUM(completed_count), 0) as total_completed, COALESCE(SUM(points), 0) as total_points FROM gamification_stats",
  )
  const totRow = totals.rows[0] as Record<string, unknown>

  return {
    currentStreak: Math.max(currentStreak, longestStreak === 0 ? 0 : currentStreak),
    longestStreak,
    todayCompleted,
    totalCompleted: Number(totRow.total_completed),
    totalPoints: Number(totRow.total_points),
  }
}

/**
 * Get weekly data for the last 7 days.
 */
export async function getWeeklyData(): Promise<DailyRecord[]> {
  await ensureGamificationSchema()
  const client = getPersistenceClient()

  const days: DailyRecord[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().split("T")[0]!

    const result = await client.execute({
      sql: "SELECT completed_count, streak_count, points FROM gamification_stats WHERE date = ? LIMIT 1",
      args: [dateStr],
    })

    if (result.rows.length > 0) {
      const row = result.rows[0] as Record<string, unknown>
      days.push({
        date: dateStr,
        completedCount: Number(row.completed_count),
        streakCount: Number(row.streak_count),
        points: Number(row.points),
      })
    } else {
      days.push({ date: dateStr, completedCount: 0, streakCount: 0, points: 0 })
    }
  }

  return days
}

/** Reset for tests */
export function resetGamificationForTests(): void {
  schemaEnsured = false
}
