/**
 * Habit Tracker Domain — Service
 *
 * @domain habits
 * @bounded-context habits
 *
 * Manages daily habits with completion tracking.
 * Habits are separate from tasks — designed for daily recurring behavior tracking.
 *
 * @kcs Habits are simple: name + frequency + daily completions.
 * No complex scheduling — just "did you do this today?"
 * Completion history stored per-date for streak calculation.
 */

import { randomUUID } from "node:crypto"
import {
  ensureSchema,
  getPersistenceClient,
} from "../tasks/persistence/store"

// ── Schema ──────────────────────────────────────────────────────

let schemaEnsured = false

export async function ensureHabitSchema(): Promise<void> {
  if (schemaEnsured) return
  await ensureSchema()
  const client = getPersistenceClient()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '✅',
      color TEXT NOT NULL DEFAULT '#6366f1',
      frequency TEXT NOT NULL DEFAULT 'daily',
      target_count INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS habit_completions (
      id TEXT PRIMARY KEY,
      habit_id TEXT NOT NULL,
      completed_date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (habit_id) REFERENCES habits(id) ON DELETE CASCADE,
      UNIQUE(habit_id, completed_date)
    )
  `)

  await client.execute("CREATE INDEX IF NOT EXISTS habit_completions_habit_idx ON habit_completions(habit_id)")
  await client.execute("CREATE INDEX IF NOT EXISTS habit_completions_date_idx ON habit_completions(completed_date)")

  schemaEnsured = true
}

// ── Types ───────────────────────────────────────────────────────

export interface Habit {
  id: string
  name: string
  icon: string
  color: string
  frequency: "daily" | "weekly"
  targetCount: number
  active: boolean
  createdAt: number
}

export interface HabitWithStats extends Habit {
  todayCount: number
  currentStreak: number
  longestStreak: number
  totalCompletions: number
}

// ── CRUD ────────────────────────────────────────────────────────

function generateId(): string {
  return `habit_${Date.now()}_${randomUUID().slice(0, 8)}`
}

export async function createHabit(data: {
  name: string
  icon?: string
  color?: string
  frequency?: "daily" | "weekly"
  targetCount?: number
}): Promise<Habit> {
  await ensureHabitSchema()
  const client = getPersistenceClient()
  const id = generateId()
  const now = Date.now()

  await client.execute({
    sql: `INSERT INTO habits (id, name, icon, color, frequency, target_count, active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    args: [
      id,
      data.name,
      data.icon ?? "✅",
      data.color ?? "#6366f1",
      data.frequency ?? "daily",
      data.targetCount ?? 1,
      now, now,
    ],
  })

  return {
    id,
    name: data.name,
    icon: data.icon ?? "✅",
    color: data.color ?? "#6366f1",
    frequency: data.frequency ?? "daily",
    targetCount: data.targetCount ?? 1,
    active: true,
    createdAt: now,
  }
}

export async function getHabits(): Promise<HabitWithStats[]> {
  await ensureHabitSchema()
  const client = getPersistenceClient()
  const today = new Date().toISOString().split("T")[0]!

  const result = await client.execute(
    "SELECT * FROM habits WHERE active = 1 ORDER BY created_at ASC"
  )
  if (result.rows.length === 0) return []

  const habitIds = result.rows.map(row => String((row as Record<string, unknown>).id))
  const grouped = await client.execute({
    sql: `SELECT habit_id,
                 COUNT(*) AS total_completions,
                 COALESCE(MAX(CASE WHEN completed_date = ? THEN count END), 0) AS today_count,
                 json_group_array(completed_date) AS dates_json
          FROM (
            SELECT habit_id, completed_date, count
            FROM habit_completions
            WHERE habit_id IN (SELECT value FROM json_each(?))
            ORDER BY habit_id ASC, completed_date DESC
          )
          GROUP BY habit_id`,
    args: [today, JSON.stringify(habitIds)],
  })

  const statsByHabit = new Map<string, { todayCount: number; totalCompletions: number; dates: string[] }>()
  for (const row of grouped.rows) {
    const r = row as Record<string, unknown>
    let dates: string[] = []
    if (typeof r.dates_json === "string") {
      try {
        const parsed = JSON.parse(r.dates_json)
        if (Array.isArray(parsed)) dates = parsed.map(String)
      } catch {
        dates = []
      }
    }
    statsByHabit.set(String(r.habit_id), {
      todayCount: Number(r.today_count ?? 0),
      totalCompletions: Number(r.total_completions ?? 0),
      dates,
    })
  }

  const habits: HabitWithStats[] = []
  for (const row of result.rows) {
    const r = row as Record<string, unknown>
    const habitId = String(r.id)
    const stat = statsByHabit.get(habitId)
    const streakData = computeStreakFromDates(stat?.dates ?? [], today)

    habits.push({
      id: habitId,
      name: String(r.name),
      icon: String(r.icon),
      color: String(r.color),
      frequency: String(r.frequency) as "daily" | "weekly",
      targetCount: Number(r.target_count),
      active: Number(r.active) === 1,
      createdAt: Number(r.created_at),
      todayCount: stat?.todayCount ?? 0,
      currentStreak: streakData.current,
      longestStreak: streakData.longest,
      totalCompletions: stat?.totalCompletions ?? 0,
    })
  }

  return habits
}

export async function completeHabit(habitId: string, date?: string): Promise<{ count: number }> {
  await ensureHabitSchema()
  const client = getPersistenceClient()
  const completedDate = date ?? new Date().toISOString().split("T")[0]!
  const id = generateId()

  // Upsert: increment count if already completed today
  await client.execute({
    sql: `INSERT INTO habit_completions (id, habit_id, completed_date, count, created_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(habit_id, completed_date) DO UPDATE SET count = count + 1`,
    args: [id, habitId, completedDate, Date.now()],
  })

  // Get updated count
  const result = await client.execute({
    sql: "SELECT count FROM habit_completions WHERE habit_id = ? AND completed_date = ?",
    args: [habitId, completedDate],
  })

  return { count: Number((result.rows[0] as Record<string, unknown>).count) }
}

export async function deleteHabit(habitId: string): Promise<void> {
  await ensureHabitSchema()
  const client = getPersistenceClient()
  await client.execute({
    sql: "UPDATE habits SET active = 0, updated_at = ? WHERE id = ?",
    args: [Date.now(), habitId],
  })
}

// ── Streak Calculation ──────────────────────────────────────────

function computeStreakFromDates(dates: string[], today: string): { current: number, longest: number } {
  if (dates.length === 0) return { current: 0, longest: 0 }

  let current = 0
  let longest = 0
  let streak = 0
  let expectedDate = today

  for (const date of dates) {
    if (date === expectedDate) {
      streak++
      // Move expected to previous day
      const d = new Date(expectedDate)
      d.setDate(d.getDate() - 1)
      expectedDate = d.toISOString().split("T")[0]!
    } else if (current === 0 && streak === 0) {
      // First date might be yesterday if not yet completed today
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)
      if (date === yesterday.toISOString().split("T")[0]) {
        streak = 1
        const d = new Date(date)
        d.setDate(d.getDate() - 1)
        expectedDate = d.toISOString().split("T")[0]!
      } else {
        // No current streak
        current = 0
        streak = 1
        longest = Math.max(longest, streak)
        break
      }
    } else {
      // Break in streak
      if (current === 0) current = streak
      longest = Math.max(longest, streak)
      streak = 1
      const d = new Date(date)
      d.setDate(d.getDate() - 1)
      expectedDate = d.toISOString().split("T")[0]!
    }
  }

  if (current === 0) current = streak
  longest = Math.max(longest, streak)

  return { current, longest }
}

/** Reset for tests */
export function resetHabitSchemaForTests(): void {
  schemaEnsured = false
}
