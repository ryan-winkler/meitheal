/** Historical tracker data is retained. Routines use TasksContext templates and task occurrences. */
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
