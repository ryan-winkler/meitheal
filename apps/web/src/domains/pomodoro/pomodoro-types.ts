/**
 * Pomodoro Domain — Types
 *
 * @domain pomodoro
 * @bounded-context pomodoro
 *
 * @kcs Pomodoro technique intervals:
 * - Focus: 25 min (configurable)
 * - Short break: 5 min (configurable)
 * - Long break: 15 min (after 4 focus sessions)
 */

export interface PomodoroConfig {
  focusMinutes: number
  shortBreakMinutes: number
  longBreakMinutes: number
  sessionsBeforeLongBreak: number
}

export const DEFAULT_POMODORO_CONFIG: PomodoroConfig = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  sessionsBeforeLongBreak: 4,
}

export type PomodoroPhase = "focus" | "short_break" | "long_break" | "idle"

export interface PomodoroSession {
  id: string
  taskId: string | null
  phase: PomodoroPhase
  startedAt: string
  completedAt: string | null
  cancelledAt: string | null
  durationMinutes: number
  focusCount: number
}

export interface PomodoroState {
  phase: PomodoroPhase
  /** Seconds remaining in current phase */
  remaining: number
  /** Total seconds in current phase */
  total: number
  /** Focus sessions completed in this cycle */
  focusCount: number
  /** Task ID linked to current session */
  taskId: string | null
  /** Active session ID */
  sessionId: string | null
}

export interface TimeEntry {
  id: string
  taskId: string
  startedAt: string
  stoppedAt: string | null
  durationSeconds: number
}
