/**
 * Pomodoro Domain — Service
 *
 * @domain pomodoro
 * @bounded-context pomodoro
 *
 * Manages Pomodoro sessions and time tracking.
 * Sessions are persisted to SQLite for history.
 *
 * @kcs The in-memory timer state (PomodoroState) is maintained server-side.
 * Client polls for state updates via GET /api/pomodoro.
 * Start/stop/complete actions are server mutations.
 *
 * @kcs Time entries are separate from Pomodoro sessions.
 * Users can track time without using Pomodoro (simple start/stop timer).
 * Pomodoro sessions auto-generate time entries on completion.
 */

import {
  ensureSchema,
  getPersistenceClient,
} from "../../domains/tasks/persistence/store"

import type {
  PomodoroConfig,
  PomodoroState,
  PomodoroSession,
  PomodoroPhase,
  TimeEntry,
} from "./pomodoro-types"

import { DEFAULT_POMODORO_CONFIG } from "./pomodoro-types"

// ── Schema ──────────────────────────────────────────────────────

let schemaEnsured = false

export async function ensurePomodoroSchema(): Promise<void> {
  if (schemaEnsured) return
  await ensureSchema()
  const client = getPersistenceClient()

  await client.execute(`
    CREATE TABLE IF NOT EXISTS pomodoro_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      phase TEXT NOT NULL DEFAULT 'focus',
      started_at TEXT NOT NULL,
      completed_at TEXT,
      cancelled_at TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 25,
      focus_count INTEGER NOT NULL DEFAULT 0
    )
  `)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0
    )
  `)

  schemaEnsured = true
}

// ── In-Memory Timer State ───────────────────────────────────────

/**
 * Server-side timer state. Only one active session at a time.
 *
 * @kcs This is intentionally in-memory. Pomodoro timers are ephemeral —
 * if the server restarts, the active timer resets. Sessions are persisted
 * to the DB only on completion. This keeps the implementation simple
 * and avoids complex timer persistence logic.
 */
let timerState: PomodoroState = {
  phase: "idle",
  remaining: 0,
  total: 0,
  focusCount: 0,
  taskId: null,
  sessionId: null,
}

let timerInterval: ReturnType<typeof setInterval> | null = null
let config: PomodoroConfig = { ...DEFAULT_POMODORO_CONFIG }

function generateId(): string {
  return `pom_${crypto.randomUUID()}`
}

// ── Timer Control ───────────────────────────────────────────────

function startCountdown(): void {
  stopCountdown()
  timerInterval = setInterval(() => {
    if (timerState.remaining > 0) {
      timerState.remaining--
    } else {
      // Phase completed — auto-transition
      stopCountdown()
      handlePhaseComplete()
    }
  }, 1000)
}

function stopCountdown(): void {
  if (timerInterval) {
    clearInterval(timerInterval)
    timerInterval = null
  }
}

async function handlePhaseComplete(): Promise<void> {
  if (timerState.phase === "focus") {
    timerState.focusCount++

    // Persist the completed focus session
    try {
      await ensurePomodoroSchema()
      const client = getPersistenceClient()
      await client.execute({
        sql: "UPDATE pomodoro_sessions SET completed_at = ?, focus_count = ? WHERE id = ?",
        args: [new Date().toISOString(), timerState.focusCount, timerState.sessionId],
      })

      // Create time entry for the focus session
      if (timerState.taskId) {
        const entryId = generateId()
        await client.execute({
          sql: "INSERT INTO time_entries(id, task_id, started_at, stopped_at, duration_seconds) VALUES(?, ?, ?, ?, ?)",
          args: [
            entryId,
            timerState.taskId,
            new Date(Date.now() - config.focusMinutes * 60 * 1000).toISOString(),
            new Date().toISOString(),
            config.focusMinutes * 60,
          ],
        })
      }
    } catch {
      // Non-critical — session tracking failure doesn't block the timer
    }

    // Transition to break
    const isLongBreak = timerState.focusCount % config.sessionsBeforeLongBreak === 0
    const breakMinutes = isLongBreak ? config.longBreakMinutes : config.shortBreakMinutes
    const breakPhase: PomodoroPhase = isLongBreak ? "long_break" : "short_break"

    timerState.phase = breakPhase
    timerState.total = breakMinutes * 60
    timerState.remaining = breakMinutes * 60
    startCountdown()
  } else {
    // Break completed — transition to next focus
    timerState.phase = "focus"
    timerState.total = config.focusMinutes * 60
    timerState.remaining = config.focusMinutes * 60

    // Create new session record
    const sessionId = generateId()
    timerState.sessionId = sessionId

    try {
      await ensurePomodoroSchema()
      const client = getPersistenceClient()
      await client.execute({
        sql: "INSERT INTO pomodoro_sessions(id, task_id, phase, started_at, duration_minutes, focus_count) VALUES(?, ?, 'focus', ?, ?, ?)",
        args: [sessionId, timerState.taskId, new Date().toISOString(), config.focusMinutes, timerState.focusCount],
      })
    } catch {
      // Non-critical
    }

    startCountdown()
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Get current timer state.
 */
export function getTimerState(): PomodoroState {
  return { ...timerState }
}

/**
 * Start a new Pomodoro focus session.
 */
export async function startFocus(taskId: string | null = null): Promise<PomodoroState> {
  await ensurePomodoroSchema()

  // Cancel any existing session
  stopCountdown()

  const sessionId = generateId()
  timerState = {
    phase: "focus",
    remaining: config.focusMinutes * 60,
    total: config.focusMinutes * 60,
    focusCount: 0,
    taskId,
    sessionId,
  }

  // Persist session start
  const client = getPersistenceClient()
  await client.execute({
    sql: "INSERT INTO pomodoro_sessions(id, task_id, phase, started_at, duration_minutes, focus_count) VALUES(?, ?, 'focus', ?, ?, 0)",
    args: [sessionId, taskId, new Date().toISOString(), config.focusMinutes],
  })

  startCountdown()
  return getTimerState()
}

/**
 * Skip to break immediately.
 */
export async function skipToBreak(): Promise<PomodoroState> {
  if (timerState.phase !== "focus") return getTimerState()

  stopCountdown()
  await handlePhaseComplete()
  return getTimerState()
}

/**
 * Skip break and go to next focus.
 */
export async function skipBreak(): Promise<PomodoroState> {
  if (timerState.phase !== "short_break" && timerState.phase !== "long_break") {
    return getTimerState()
  }

  stopCountdown()
  await handlePhaseComplete()
  return getTimerState()
}

/**
 * Cancel the current session.
 */
export async function cancelSession(): Promise<PomodoroState> {
  stopCountdown()

  if (timerState.sessionId) {
    try {
      await ensurePomodoroSchema()
      const client = getPersistenceClient()
      await client.execute({
        sql: "UPDATE pomodoro_sessions SET cancelled_at = ? WHERE id = ?",
        args: [new Date().toISOString(), timerState.sessionId],
      })
    } catch {
      // Non-critical
    }
  }

  timerState = {
    phase: "idle",
    remaining: 0,
    total: 0,
    focusCount: timerState.focusCount,
    taskId: null,
    sessionId: null,
  }

  return getTimerState()
}

/**
 * Get session history.
 */
export async function getSessionHistory(limit = 20): Promise<PomodoroSession[]> {
  await ensurePomodoroSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "SELECT * FROM pomodoro_sessions WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT ?",
    args: [limit],
  })

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      taskId: r.task_id ? String(r.task_id) : null,
      phase: String(r.phase) as PomodoroPhase,
      startedAt: String(r.started_at),
      completedAt: r.completed_at ? String(r.completed_at) : null,
      cancelledAt: r.cancelled_at ? String(r.cancelled_at) : null,
      durationMinutes: Number(r.duration_minutes),
      focusCount: Number(r.focus_count),
    }
  })
}

/**
 * Get today's Pomodoro stats.
 */
export async function getTodayStats(): Promise<{ sessionsCompleted: number, totalFocusMinutes: number }> {
  await ensurePomodoroSchema()
  const client = getPersistenceClient()
  const today = new Date().toISOString().split("T")[0]!

  const result = await client.execute({
    sql: `SELECT COUNT(*) as total, COALESCE(SUM(duration_minutes), 0) as minutes
          FROM pomodoro_sessions
          WHERE phase = 'focus' AND completed_at IS NOT NULL
          AND date(completed_at) = ?`,
    args: [today],
  })

  const row = result.rows[0] as Record<string, unknown>
  return {
    sessionsCompleted: Number(row.total),
    totalFocusMinutes: Number(row.minutes),
  }
}

// ── Time Tracking (separate from Pomodoro) ──────────────────────

/**
 * Start a time tracking entry for a task.
 */
export async function startTimeEntry(taskId: string): Promise<TimeEntry> {
  await ensurePomodoroSchema()
  const client = getPersistenceClient()

  // Stop any running entry for this task first
  await stopTimeEntry(taskId)

  const id = generateId()
  const now = new Date().toISOString()

  await client.execute({
    sql: "INSERT INTO time_entries(id, task_id, started_at, duration_seconds) VALUES(?, ?, ?, 0)",
    args: [id, taskId, now],
  })

  return { id, taskId, startedAt: now, stoppedAt: null, durationSeconds: 0 }
}

/**
 * Stop the running time entry for a task.
 */
export async function stopTimeEntry(taskId: string): Promise<TimeEntry | null> {
  await ensurePomodoroSchema()
  const client = getPersistenceClient()

  const running = await client.execute({
    sql: "SELECT id, started_at FROM time_entries WHERE task_id = ? AND stopped_at IS NULL ORDER BY started_at DESC LIMIT 1",
    args: [taskId],
  })

  if (running.rows.length === 0) return null

  const row = running.rows[0] as Record<string, unknown>
  const now = new Date()
  const startedAt = new Date(String(row.started_at))
  const durationSeconds = Math.round((now.getTime() - startedAt.getTime()) / 1000)

  await client.execute({
    sql: "UPDATE time_entries SET stopped_at = ?, duration_seconds = ? WHERE id = ?",
    args: [now.toISOString(), durationSeconds, String(row.id)],
  })

  return {
    id: String(row.id),
    taskId,
    startedAt: String(row.started_at),
    stoppedAt: now.toISOString(),
    durationSeconds,
  }
}

/**
 * Get time entries for a task.
 */
export async function getTimeEntries(taskId: string): Promise<TimeEntry[]> {
  await ensurePomodoroSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "SELECT * FROM time_entries WHERE task_id = ? ORDER BY started_at DESC",
    args: [taskId],
  })

  return result.rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      startedAt: String(r.started_at),
      stoppedAt: r.stopped_at ? String(r.stopped_at) : null,
      durationSeconds: Number(r.duration_seconds),
    }
  })
}

/**
 * Get total time tracked for a task (in seconds).
 */
export async function getTotalTimeForTask(taskId: string): Promise<number> {
  await ensurePomodoroSchema()
  const client = getPersistenceClient()

  const result = await client.execute({
    sql: "SELECT COALESCE(SUM(duration_seconds), 0) as total FROM time_entries WHERE task_id = ?",
    args: [taskId],
  })

  return Number((result.rows[0] as Record<string, unknown>).total)
}

/** Reset for tests */
export function resetPomodoroForTests(): void {
  schemaEnsured = false
  stopCountdown()
  timerState = { phase: "idle", remaining: 0, total: 0, focusCount: 0, taskId: null, sessionId: null }
}
