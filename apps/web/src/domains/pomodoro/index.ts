/**
 * Pomodoro Domain — Public API
 *
 * @kcs This barrel file is the only public import path for the pomodoro domain.
 * Cross-context imports should use: import { ... } from "@domains/pomodoro"
 */

export {
  getTimerState,
  startFocus,
  skipToBreak,
  skipBreak,
  cancelSession,
  getSessionHistory,
  getTodayStats,
  startTimeEntry,
  stopTimeEntry,
  getTimeEntries,
  getTotalTimeForTask,
  ensurePomodoroSchema,
  resetPomodoroForTests,
} from "./pomodoro-service"

export {
  DEFAULT_POMODORO_CONFIG,
  type PomodoroConfig,
  type PomodoroState,
  type PomodoroSession,
  type PomodoroPhase,
  type TimeEntry,
} from "./pomodoro-types"
