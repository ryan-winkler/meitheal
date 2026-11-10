/**
 * Achievement Engine — Gamification Domain
 *
 * @domain gamification
 * @bounded-context gamification
 *
 * Manages achievement definitions, unlock detection, and persistence.
 * Achievements are awarded automatically when conditions are met
 * during task completion events.
 *
 * @kcs Achievement conditions are evaluated against GamificationStats.
 * The `gamification_achievements` table stores unlock timestamps.
 * Each achievement ID is unique — re-checking an already-unlocked
 * achievement is a no-op (idempotent).
 *
 * @kcs Uses relative imports (not aliases) due to esbuild limitations
 * with path aliases inside `domains/` subdirectories.
 */

import {
  ensureSchema,
  getPersistenceClient,
} from "../../domains/tasks/persistence/store"

import type { GamificationStats } from "./streak-tracker"

// ── Types ───────────────────────────────────────────────────────

export interface Achievement {
  id: string
  name: string
  description: string
  icon: string
  /** Category for grouping in the gallery */
  category: "milestone" | "streak" | "xp" | "special"
}

export interface UnlockedAchievement extends Achievement {
  unlockedAt: string
}

export interface AchievementCheckResult {
  newlyUnlocked: UnlockedAchievement[]
  total: number
  unlocked: number
}

// ── Level System ────────────────────────────────────────────────

/**
 * Calculate level from total XP.
 * Formula: Level = floor(sqrt(totalPoints / 100)) + 1
 *
 * Level thresholds: L1=0, L2=100, L3=400, L4=900, L5=1600, L6=2500...
 *
 * @kcs This gives a smooth curve where early levels come quickly
 * (motivating new users) and later levels require more sustained effort.
 */
export function getLevel(totalPoints: number): number {
  if (totalPoints <= 0) return 1
  return Math.floor(Math.sqrt(totalPoints / 100)) + 1
}

/**
 * Calculate XP required to reach a given level.
 * Inverse of getLevel: XP = (level - 1)^2 * 100
 */
export function getXpForLevel(level: number): number {
  if (level <= 1) return 0
  return (level - 1) ** 2 * 100
}

/**
 * Calculate progress percentage towards the next level.
 * Returns a value between 0 and 1.
 */
export function getProgressToNextLevel(totalPoints: number): number {
  const currentLevel = getLevel(totalPoints)
  const currentThreshold = getXpForLevel(currentLevel)
  const nextThreshold = getXpForLevel(currentLevel + 1)
  const range = nextThreshold - currentThreshold
  if (range <= 0) return 0
  return Math.min((totalPoints - currentThreshold) / range, 1)
}

/**
 * Get XP remaining until next level.
 */
export function getXpToNextLevel(totalPoints: number): number {
  const currentLevel = getLevel(totalPoints)
  const nextThreshold = getXpForLevel(currentLevel + 1)
  return Math.max(nextThreshold - totalPoints, 0)
}

// ── Achievement Definitions ─────────────────────────────────────

/**
 * Built-in achievement catalog.
 *
 * @kcs Each achievement has a static ID that maps to a condition function.
 * Conditions are checked against GamificationStats after each task completion.
 * Adding new achievements only requires adding to this array.
 */
export const ACHIEVEMENTS: Achievement[] = [
  // Milestone achievements
  { id: "first_task", name: "First Steps", description: "Complete your first task", icon: "🎯", category: "milestone" },
  { id: "tasks_10", name: "Getting Going", description: "Complete 10 tasks", icon: "🚀", category: "milestone" },
  { id: "tasks_25", name: "Quarter Century", description: "Complete 25 tasks", icon: "🎲", category: "milestone" },
  { id: "tasks_50", name: "Half Century", description: "Complete 50 tasks", icon: "⚡", category: "milestone" },
  { id: "tasks_100", name: "Centurion", description: "Complete 100 tasks", icon: "💯", category: "milestone" },
  { id: "tasks_250", name: "Unstoppable", description: "Complete 250 tasks", icon: "🏆", category: "milestone" },
  { id: "tasks_500", name: "Legend", description: "Complete 500 tasks", icon: "👑", category: "milestone" },

  // Streak achievements
  { id: "streak_3", name: "Consistent", description: "Achieve a 3-day streak", icon: "🔥", category: "streak" },
  { id: "streak_7", name: "Week Warrior", description: "Achieve a 7-day streak", icon: "📅", category: "streak" },
  { id: "streak_14", name: "Fortnight Force", description: "Achieve a 14-day streak", icon: "⚔️", category: "streak" },
  { id: "streak_30", name: "Monthly Master", description: "Achieve a 30-day streak", icon: "🌟", category: "streak" },
  { id: "streak_60", name: "Discipline", description: "Achieve a 60-day streak", icon: "💎", category: "streak" },
  { id: "streak_100", name: "Iron Will", description: "Achieve a 100-day streak", icon: "🛡️", category: "streak" },

  // XP achievements
  { id: "xp_100", name: "XP Beginner", description: "Earn 100 XP", icon: "✨", category: "xp" },
  { id: "xp_500", name: "XP Apprentice", description: "Earn 500 XP", icon: "⭐", category: "xp" },
  { id: "xp_1000", name: "XP Adept", description: "Earn 1,000 XP", icon: "🌟", category: "xp" },
  { id: "xp_2500", name: "XP Expert", description: "Earn 2,500 XP", icon: "💫", category: "xp" },
  { id: "xp_5000", name: "XP Master", description: "Earn 5,000 XP", icon: "🔮", category: "xp" },
  { id: "xp_10000", name: "XP Legend", description: "Earn 10,000 XP", icon: "🏅", category: "xp" },

  // Special achievements
  { id: "daily_goal", name: "Goal Crusher", description: "Hit your daily goal for the first time", icon: "🎯", category: "special" },
  { id: "five_in_day", name: "Power Hour", description: "Complete 5 tasks in one day", icon: "⚡", category: "special" },
  { id: "ten_in_day", name: "Productivity Machine", description: "Complete 10 tasks in one day", icon: "🤖", category: "special" },
  { id: "level_5", name: "Rising Star", description: "Reach Level 5", icon: "🌠", category: "special" },
  { id: "level_10", name: "Veteran", description: "Reach Level 10", icon: "🎖️", category: "special" },
  { id: "level_20", name: "Elite", description: "Reach Level 20", icon: "👑", category: "special" },
]

/**
 * Condition functions: each returns true if the achievement should be unlocked.
 *
 * @kcs Uses a Map for O(1) lookup instead of a switch/if chain.
 * The `daily_goal` default is 5 — matches GamificationWidget.astro.
 */
const CONDITIONS: Record<string, (stats: GamificationStats) => boolean> = {
  // Milestone conditions
  first_task: (s) => s.totalCompleted >= 1,
  tasks_10: (s) => s.totalCompleted >= 10,
  tasks_25: (s) => s.totalCompleted >= 25,
  tasks_50: (s) => s.totalCompleted >= 50,
  tasks_100: (s) => s.totalCompleted >= 100,
  tasks_250: (s) => s.totalCompleted >= 250,
  tasks_500: (s) => s.totalCompleted >= 500,

  // Streak conditions
  streak_3: (s) => s.currentStreak >= 3 || s.longestStreak >= 3,
  streak_7: (s) => s.currentStreak >= 7 || s.longestStreak >= 7,
  streak_14: (s) => s.currentStreak >= 14 || s.longestStreak >= 14,
  streak_30: (s) => s.currentStreak >= 30 || s.longestStreak >= 30,
  streak_60: (s) => s.currentStreak >= 60 || s.longestStreak >= 60,
  streak_100: (s) => s.currentStreak >= 100 || s.longestStreak >= 100,

  // XP conditions
  xp_100: (s) => s.totalPoints >= 100,
  xp_500: (s) => s.totalPoints >= 500,
  xp_1000: (s) => s.totalPoints >= 1000,
  xp_2500: (s) => s.totalPoints >= 2500,
  xp_5000: (s) => s.totalPoints >= 5000,
  xp_10000: (s) => s.totalPoints >= 10000,

  // Special conditions
  daily_goal: (s) => s.todayCompleted >= 5,
  five_in_day: (s) => s.todayCompleted >= 5,
  ten_in_day: (s) => s.todayCompleted >= 10,
  level_5: (s) => getLevel(s.totalPoints) >= 5,
  level_10: (s) => getLevel(s.totalPoints) >= 10,
  level_20: (s) => getLevel(s.totalPoints) >= 20,
}

// ── Schema ──────────────────────────────────────────────────────

let achievementSchemaEnsured = false

/**
 * Ensure achievement table exists.
 */
export async function ensureAchievementSchema(): Promise<void> {
  if (achievementSchemaEnsured) return
  await ensureSchema()
  const client = getPersistenceClient()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS gamification_achievements (
      id TEXT PRIMARY KEY,
      unlocked_at TEXT NOT NULL
    )
  `)

  achievementSchemaEnsured = true
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Check all achievements against current stats.
 * Awards any newly-met achievements.
 *
 * @returns Newly unlocked achievements + totals
 *
 * @kcs Idempotent — already-unlocked achievements are skipped.
 * Called after every task completion via the gamification API.
 */
export async function checkAchievements(
  stats: GamificationStats,
): Promise<AchievementCheckResult> {
  await ensureAchievementSchema()
  const client = getPersistenceClient()

  // Get already-unlocked IDs
  const existing = await client.execute(
    "SELECT id, unlocked_at FROM gamification_achievements",
  )
  const unlockedMap = new Map<string, string>()
  for (const row of existing.rows) {
    const r = row as Record<string, unknown>
    unlockedMap.set(String(r.id), String(r.unlocked_at))
  }

  const newlyUnlocked: UnlockedAchievement[] = []
  const now = new Date().toISOString()

  for (const achievement of ACHIEVEMENTS) {
    // Skip if already unlocked
    if (unlockedMap.has(achievement.id)) continue

    // Check condition
    const condition = CONDITIONS[achievement.id]
    if (!condition || !condition(stats)) continue

    // Unlock!
    await client.execute({
      sql: "INSERT OR IGNORE INTO gamification_achievements(id, unlocked_at) VALUES(?, ?)",
      args: [achievement.id, now],
    })

    newlyUnlocked.push({ ...achievement, unlockedAt: now })
  }

  return {
    newlyUnlocked,
    total: ACHIEVEMENTS.length,
    unlocked: unlockedMap.size + newlyUnlocked.length,
  }
}

/**
 * Get all achievements with their unlock status.
 */
export async function getAllAchievements(): Promise<{
  achievements: (Achievement & { unlockedAt: string | null })[]
  total: number
  unlocked: number
}> {
  await ensureAchievementSchema()
  const client = getPersistenceClient()

  const existing = await client.execute(
    "SELECT id, unlocked_at FROM gamification_achievements",
  )
  const unlockedMap = new Map<string, string>()
  for (const row of existing.rows) {
    const r = row as Record<string, unknown>
    unlockedMap.set(String(r.id), String(r.unlocked_at))
  }

  const achievements = ACHIEVEMENTS.map((a) => ({
    ...a,
    unlockedAt: unlockedMap.get(a.id) ?? null,
  }))

  return {
    achievements,
    total: ACHIEVEMENTS.length,
    unlocked: unlockedMap.size,
  }
}

/**
 * Get yearly data for heatmap (365 days).
 * Returns daily completion counts for the specified year.
 */
export async function getYearlyHeatmapData(year?: number): Promise<{ date: string, count: number }[]> {
  await ensureAchievementSchema()
  const client = getPersistenceClient()

  const targetYear = year ?? new Date().getFullYear()
  const startDate = `${targetYear}-01-01`
  const endDate = `${targetYear}-12-31`

  const result = await client.execute({
    sql: "SELECT date, completed_count FROM gamification_stats WHERE date >= ? AND date <= ? ORDER BY date",
    args: [startDate, endDate],
  })

  // Build full 365-day map
  const dataMap = new Map<string, number>()
  for (const row of result.rows) {
    const r = row as Record<string, unknown>
    dataMap.set(String(r.date), Number(r.completed_count))
  }

  const days: { date: string, count: number }[] = []
  const current = new Date(`${targetYear}-01-01T00:00:00`)
  const end = new Date(`${targetYear}-12-31T00:00:00`)

  while (current <= end) {
    const dateStr = current.toISOString().split("T")[0]!
    days.push({ date: dateStr, count: dataMap.get(dateStr) ?? 0 })
    current.setDate(current.getDate() + 1)
  }

  return days
}

/** Reset for tests */
export function resetAchievementForTests(): void {
  achievementSchemaEnsured = false
}
