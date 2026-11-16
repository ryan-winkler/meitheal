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

  // Atomic increments avoid losing simultaneous completions from different callers.
  await client.execute({
    sql: `INSERT INTO gamification_stats(date, completed_count, streak_count, points)
          VALUES(?, 1, ?, ?)
          ON CONFLICT(date) DO UPDATE SET
            completed_count = completed_count + 1,
            points = points + excluded.points`,
    args: [today, prevStreak > 0 ? prevStreak + 1 : 1, points],
  })

  return getStats()
}

/**
 * Get current gamification stats via a single aggregate query.
 */
export async function getStats(): Promise<GamificationStats> {
  await ensureGamificationSchema()
  const client = getPersistenceClient()
  const today = new Date().toISOString().split("T")[0]!
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = yesterday.toISOString().split("T")[0]!

  const agg = await client.execute({
    sql: `SELECT
            COALESCE(MAX(CASE WHEN date = ? THEN completed_count END), 0) AS today_completed,
            MAX(CASE WHEN date = ? THEN streak_count END) AS today_streak,
            MAX(CASE WHEN date = ? THEN streak_count END) AS yesterday_streak,
            COALESCE(MAX(streak_count), 0) AS max_streak,
            COALESCE(SUM(completed_count), 0) AS total_completed,
            COALESCE(SUM(points), 0) AS total_points
          FROM gamification_stats`,
    args: [today, today, yesterdayStr],
  })

  const row = (agg.rows[0] ?? {}) as Record<string, unknown>
  const todayCompleted = row.today_streak != null ? Number(row.today_completed ?? 0) : 0
  const currentStreak = row.today_streak != null
    ? Number(row.today_streak)
    : row.yesterday_streak != null
      ? Number(row.yesterday_streak)
      : 0
  const longestStreak = Number(row.max_streak ?? 0)

  return {
    currentStreak: Math.max(currentStreak, longestStreak === 0 ? 0 : currentStreak),
    longestStreak,
    todayCompleted,
    totalCompleted: Number(row.total_completed ?? 0),
    totalPoints: Number(row.total_points ?? 0),
  }
}

/**
 * Get weekly data for the last 7 days via a single GROUP BY date query.
 */
export async function getWeeklyData(): Promise<DailyRecord[]> {
  await ensureGamificationSchema()
  const client = getPersistenceClient()

  const dateKeys: string[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    dateKeys.push(d.toISOString().split("T")[0]!)
  }

  const startStr = dateKeys[0]!
  const endStr = dateKeys[dateKeys.length - 1]!
  const result = await client.execute({
    sql: `SELECT date,
                 COALESCE(SUM(completed_count), 0) AS completed_count,
                 COALESCE(MAX(streak_count), 0) AS streak_count,
                 COALESCE(SUM(points), 0) AS points
          FROM gamification_stats
          WHERE date >= ? AND date <= ?
          GROUP BY date`,
    args: [startStr, endStr],
  })

  const byDate = new Map<string, DailyRecord>()
  for (const raw of result.rows) {
    const r = raw as Record<string, unknown>
    const d = String(r.date)
    byDate.set(d, {
      date: d,
      completedCount: Number(r.completed_count ?? 0),
      streakCount: Number(r.streak_count ?? 0),
      points: Number(r.points ?? 0),
    })
  }

  return dateKeys.map(dateStr => byDate.get(dateStr) ?? {
    date: dateStr,
    completedCount: 0,
    streakCount: 0,
    points: 0,
  })
}

/** Reset for tests */
export function resetGamificationForTests(): void {
  schemaEnsured = false
}
