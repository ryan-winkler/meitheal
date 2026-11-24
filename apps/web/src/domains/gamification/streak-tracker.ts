import { BoardOperationError, canReadBoardAggregate, scopePermits, type BoardScope } from "@domains/tasks"
import { calendarToday, shiftCalendarDay } from "../../lib/date"
import { gamificationClient, gamificationRead } from "./scoped-gamification"
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
 * - date: UTC date string (YYYY-MM-DD)
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
} from "@domains/tasks"

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

type DailyProgress = { currentStreak: number; points: number }
export function statsDayKey(now: Date, offset = 0, timezone = "UTC"): string {
  if (!timezone || timezone === "UTC") {
    if (offset === 0) return now.toISOString().slice(0, 10)
    const day = new Date(now)
    day.setUTCDate(day.getUTCDate() + offset)
    return day.toISOString().slice(0, 10)
  }
  return shiftCalendarDay(calendarToday(timezone, now), offset)
}

/** Today and the sidebar read the same two indexed days for the current request. */
export function getDailyProgress(scope: BoardScope, now = new Date(), timezone = "UTC"): Promise<DailyProgress> {
  return readDailyProgress(scope, now, timezone)
}

async function readDailyProgress(scope: BoardScope, now: Date, timezone = "UTC"): Promise<DailyProgress> {
  await ensureGamificationSchema()
  const today = statsDayKey(now, 0, timezone)
  const yesterday = statsDayKey(now, -1, timezone)
  const result = await (await gamificationClient(scope)).execute(gamificationRead(scope, {
    sql: "SELECT date, streak_count, points FROM board_stats WHERE date IN (?, ?)",
    args: [today, yesterday],
  }))
  const current = result.rows.find(row => row.date === today)
  const prior = result.rows.find(row => row.date === yesterday)
  return {
    currentStreak: Number(current?.streak_count ?? prior?.streak_count ?? 0),
    points: Number(current?.points ?? 0),
  }
}

export async function ensureGamificationSchema(): Promise<void> { await ensureSchema() }

export function statsQuery(scope: BoardScope, today: string, yesterday: string) {
  return gamificationRead(scope, {
    sql: `SELECT
            COALESCE(MAX(CASE WHEN date = ? THEN completed_count END), 0) AS today_completed,
            MAX(CASE WHEN date = ? THEN streak_count END) AS today_streak,
            MAX(CASE WHEN date = ? THEN streak_count END) AS yesterday_streak,
            COALESCE(MAX(streak_count), 0) AS max_streak,
            COALESCE(SUM(completed_count), 0) AS total_completed,
            COALESCE(SUM(points), 0) AS total_points
          FROM board_stats`,
    args: [today, today, yesterday],
  })
}

export function parseStatsRows(rows: ReadonlyArray<Record<string, unknown>>): GamificationStats {
  const row = rows[0] ?? {}
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

export async function readStatsFromRunner(
  runner: Pick<import("@libsql/client").Client, "execute">,
  scope: BoardScope,
  now = new Date(),
  timezone = "UTC",
): Promise<GamificationStats> {
  const today = statsDayKey(now, 0, timezone)
  const yesterday = statsDayKey(now, -1, timezone)
  const agg = await runner.execute(statsQuery(scope, today, yesterday))
  return parseStatsRows(agg.rows as ReadonlyArray<Record<string, unknown>>)
}

export async function prepareCompletionStatsWrite(
  scope: BoardScope,
  points = 0,
  now = new Date(),
  timezone = "UTC",
) {
  await ensureGamificationSchema()
  const base = getPersistenceClient()
  const client = await gamificationClient(scope, true)
  const today = statsDayKey(now, 0, timezone)
  const yesterday = statsDayKey(now, -1, timezone)
  const insertStatement = {
    sql: `INSERT INTO gamification_stats(board_id, date, completed_count, streak_count, points)
          VALUES(?, ?, 1, 1 + MAX(0, COALESCE((SELECT streak_count FROM gamification_stats
            WHERE board_id = ? AND date = ?), 0)), ?)
          ON CONFLICT(board_id,date) DO UPDATE SET
            completed_count = completed_count + 1,
            points = points + excluded.points`,
    args: [scope.boardId, today, scope.boardId, yesterday, points],
  }
  if (!scopePermits(scope, { resource: "task", action: "read" })) {
    await client.execute(insertStatement)
    return null
  }
  if (!await canReadBoardAggregate(base, scope)) {
    await client.execute(insertStatement)
    throw new BoardOperationError("unavailable")
  }
  return { base, client, today, yesterday, insertStatement }
}

/**
 * Record a task completion. Increments today's count and updates streak.
 * @param points - XP points to award (default: 0, Phase 5 adds weighted points)
 */
export async function recordTaskCompletion(
  scope: BoardScope,
  points = 0,
  now = new Date(),
  timezone = "UTC",
): Promise<GamificationStats | null> {
  const prepared = await prepareCompletionStatsWrite(scope, points, now, timezone)
  if (!prepared) return null
  const [, agg] = await prepared.client.batch(
    [prepared.insertStatement, statsQuery(scope, prepared.today, prepared.yesterday)],
    "write",
  )
  if (!await canReadBoardAggregate(prepared.base, scope)) throw new BoardOperationError("unavailable")
  return parseStatsRows((agg?.rows ?? []) as ReadonlyArray<Record<string, unknown>>)
}

/**
 * Get current gamification stats via a single aggregate query.
 */
export async function getStats(scope: BoardScope, now = new Date(), timezone = "UTC"): Promise<GamificationStats> {
  await ensureGamificationSchema()
  const client = await gamificationClient(scope)
  const today = statsDayKey(now, 0, timezone)
  const yesterday = statsDayKey(now, -1, timezone)

  const agg = await client.execute(statsQuery(scope, today, yesterday))
  return parseStatsRows(agg.rows as ReadonlyArray<Record<string, unknown>>)
}

/**
 * Get weekly data for the last 7 days via a single GROUP BY date query.
 */
export async function getWeeklyData(scope: BoardScope, now = new Date(), timezone = "UTC"): Promise<DailyRecord[]> {
  await ensureGamificationSchema()
  const client = await gamificationClient(scope)

  const dateKeys: string[] = []
  for (let i = 6; i >= 0; i--) {
    dateKeys.push(statsDayKey(now, -i, timezone))
  }

  const startStr = dateKeys[0]!
  const endStr = dateKeys[dateKeys.length - 1]!
  const result = await client.execute(gamificationRead(scope, {
    sql: `SELECT date,
                 COALESCE(SUM(completed_count), 0) AS completed_count,
                 COALESCE(MAX(streak_count), 0) AS streak_count,
                 COALESCE(SUM(points), 0) AS points
          FROM board_stats
          WHERE date >= ? AND date <= ?
          GROUP BY date`,
    args: [startStr, endStr],
  }))

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
  // No shared schema or audience cache remains.
}
