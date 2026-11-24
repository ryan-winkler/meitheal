import type { Client, Transaction } from "@libsql/client"
import {
  boardOperationClient, ensureSchema, getPersistenceClient, validateBoardScope, validateTaskOperation,
  type BoardScope,
} from "@domains/tasks"
import { DEFAULT_POMODORO_CONFIG, type PomodoroState, type PomodoroSession, type PomodoroPhase, type TimeEntry } from "./pomodoro-types"

export class PomodoroTaskUnavailableError extends Error {}
export async function ensurePomodoroSchema(): Promise<void> { await ensureSchema() }
const config = DEFAULT_POMODORO_CONFIG
const idle = (focusCount = 0): PomodoroState => ({ phase: "idle", remaining: 0, total: 0, focusCount, taskId: null, sessionId: null })
type Timer = { scope: BoardScope, state: PomodoroState, interval: ReturnType<typeof setInterval> | null, busy: boolean }
// A timer belongs to a principal in one Board. Historical unattributed rows are
// retained, but never adopted by whoever happens to open the application next.
const timers = new Map<string, Timer>()
const key = (scope: BoardScope) => JSON.stringify([scope.boardId, scope.principal.kind, scope.principal.id])
const ownerArgs = (scope: BoardScope) => [scope.boardId, scope.principal.kind, scope.principal.id]
const owner = "board_id = ? AND principal_kind = ? AND principal_id = ?"
function stop(timer: Timer): void { if (timer.interval) clearInterval(timer.interval); timer.interval = null }
function timerFor(scope: BoardScope): Timer {
  const existing = timers.get(key(scope))
  if (existing && existing.scope.authorityRevision === scope.authorityRevision && existing.scope.boardRevision === scope.boardRevision) { existing.scope = scope; return existing }
  if (existing) stop(existing)
  const timer: Timer = { scope, state: idle(), interval: null, busy: false }
  timers.set(key(scope), timer)
  return timer
}
async function requireTask(reader: Pick<Client, "execute">, scope: BoardScope, taskId: string | null, action: "read" | "edit", expected?: string): Promise<void> {
  const allowed = taskId ? await validateTaskOperation(reader, scope, taskId, { resource: "task", action }, expected) :
    (await validateBoardScope(scope, reader, { resource: "task", action })).ok
  if (!allowed) throw new PomodoroTaskUnavailableError("Task unavailable")
}
async function writer<T>(scope: BoardScope, taskId: string | null, run: (tx: Transaction) => Promise<T>, expected?: string): Promise<T> {
  await ensurePomodoroSchema()
  const tx = await boardOperationClient(getPersistenceClient(), scope, { resource: "task", action: "edit" }, taskId ? [taskId] : []).transaction("write")
  try {
    await requireTask(tx, scope, taskId, "edit", expected)
    const value = await run(tx)
    await requireTask(tx, scope, taskId, "edit", expected)
    await tx.commit()
    return value
  } finally { tx.close() }
}
async function createSession(timer: Timer): Promise<void> {
  const { scope, state } = timer
  const id = `pom_${crypto.randomUUID()}`
  await writer(scope, state.taskId, tx => tx.execute({
    sql: `INSERT INTO pomodoro_sessions(id, task_id, phase, started_at, duration_minutes, focus_count, board_id, principal_kind, principal_id)
      VALUES (?, ?, 'focus', ?, ?, ?, ?, ?, ?)`,
    args: [id, state.taskId, new Date().toISOString(), config.focusMinutes, state.focusCount, ...ownerArgs(scope)],
  }))
  state.sessionId = id
}
function countdown(timer: Timer): void {
  stop(timer)
  if (timers.get(key(timer.scope)) !== timer) return
  timer.interval = setInterval(() => {
    if (timer.busy) return
    if (timer.state.remaining > 0) { timer.state.remaining--; return }
    timer.busy = true
    phaseComplete(timer).catch(() => {
      // A revoked or expired proof cannot persist work or start a new phase.
      stop(timer)
      timer.state = idle(timer.state.focusCount)
    }).finally(() => { timer.busy = false })
  }, 1000)
  timer.interval.unref?.()
}
async function phaseComplete(timer: Timer): Promise<void> {
  stop(timer)
  const { scope, state } = timer
  if (state.phase === "focus") {
    const now = new Date().toISOString()
    const count = state.focusCount + 1
    await writer(scope, state.taskId, async tx => {
      const saved = await tx.execute({ sql: `UPDATE pomodoro_sessions SET completed_at = ?, focus_count = ? WHERE id = ? AND ${owner} AND completed_at IS NULL AND cancelled_at IS NULL`, args: [now, count, state.sessionId, ...ownerArgs(scope)] })
      if (saved.rowsAffected && state.taskId) await tx.execute({
        sql: `INSERT INTO time_entries(id, task_id, started_at, stopped_at, duration_seconds, board_id, principal_kind, principal_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [`pom_${crypto.randomUUID()}`, state.taskId, new Date(Date.now() - state.total * 1000).toISOString(), now, state.total, ...ownerArgs(scope)],
      })
    })
    state.focusCount = count
    state.phase = count % config.sessionsBeforeLongBreak === 0 ? "long_break" : "short_break"
    state.total = (state.phase === "long_break" ? config.longBreakMinutes : config.shortBreakMinutes) * 60
    state.remaining = state.total
  } else if (state.phase === "short_break" || state.phase === "long_break") {
    await createSession(timer)
    state.phase = "focus"
    state.remaining = state.total = config.focusMinutes * 60
  }
  countdown(timer)
}
export async function getTimerState(scope: BoardScope): Promise<PomodoroState> {
  await ensurePomodoroSchema()
  const timer = timerFor(scope)
  try { await requireTask(getPersistenceClient(), scope, timer.state.taskId, "read") }
  catch (error) { stop(timer); timer.state = idle(timer.state.focusCount); throw error }
  return { ...timer.state }
}
export async function startFocus(scope: BoardScope, taskId: string | null = null): Promise<PomodoroState> {
  const timer = timerFor(scope)
  const next: Timer = { scope, state: { ...idle(), phase: "focus", remaining: config.focusMinutes * 60, total: config.focusMinutes * 60, taskId }, interval: null, busy: false }
  await createSession(next)
  stop(timer)
  timers.set(key(scope), next)
  countdown(next)
  return { ...next.state }
}
export async function skipToBreak(scope: BoardScope): Promise<PomodoroState> {
  const timer = timerFor(scope)
  if (timer.state.phase === "focus") await phaseComplete(timer)
  else await requireTask(getPersistenceClient(), scope, timer.state.taskId, "edit")
  return { ...timer.state }
}
export async function skipBreak(scope: BoardScope): Promise<PomodoroState> {
  const timer = timerFor(scope)
  if (timer.state.phase === "short_break" || timer.state.phase === "long_break") await phaseComplete(timer)
  else await requireTask(getPersistenceClient(), scope, timer.state.taskId, "edit")
  return { ...timer.state }
}
export async function cancelSession(scope: BoardScope): Promise<PomodoroState> {
  const timer = timerFor(scope)
  await writer(scope, timer.state.taskId, async tx => {
    if (timer.state.sessionId) await tx.execute({ sql: `UPDATE pomodoro_sessions SET cancelled_at = ? WHERE id = ? AND ${owner} AND completed_at IS NULL`, args: [new Date().toISOString(), timer.state.sessionId, ...ownerArgs(scope)] })
  })
  stop(timer)
  timer.state = idle(timer.state.focusCount)
  return { ...timer.state }
}
export async function getSessionHistory(scope: BoardScope, limit = 20): Promise<PomodoroSession[]> {
  await ensurePomodoroSchema()
  const client = boardOperationClient(getPersistenceClient(), scope, { resource: "task", action: "read" })
  const tx = await client.transaction("read")
  try {
    const result = await tx.execute({ sql: `SELECT id, task_id, phase, started_at, completed_at, cancelled_at, duration_minutes, focus_count FROM pomodoro_sessions WHERE ${owner} AND completed_at IS NOT NULL ORDER BY completed_at DESC`, args: ownerArgs(scope) })
    const values: PomodoroSession[] = []
    for (const row of result.rows) {
      const taskId = row.task_id ? String(row.task_id) : null
      if (taskId && !await validateTaskOperation(tx, scope, taskId, { resource: "task", action: "read" })) continue
      values.push({ id: String(row.id), taskId, phase: String(row.phase) as PomodoroPhase, startedAt: String(row.started_at), completedAt: row.completed_at ? String(row.completed_at) : null, cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null, durationMinutes: Number(row.duration_minutes), focusCount: Number(row.focus_count) })
      if (values.length >= Math.max(1, Math.min(10000, limit))) break
    }
    await tx.commit()
    return values
  } finally { tx.close() }
}
export async function getTodayStats(scope: BoardScope): Promise<{ sessionsCompleted: number, totalFocusMinutes: number }> {
  const today = new Date().toISOString().slice(0, 10)
  const rows = (await getSessionHistory(scope, 10000)).filter(row => row.phase === "focus" && row.completedAt?.slice(0, 10) === today)
  return { sessionsCompleted: rows.length, totalFocusMinutes: rows.reduce((sum, row) => sum + row.durationMinutes, 0) }
}
export type TimeEntryMutationResult = { ok: true, entry: TimeEntry | null } | { ok: false, errorCode: "not_found" | "assignee_mismatch" }
function timeEntry(row: Record<string, unknown>): TimeEntry {
  return { id: String(row.id), taskId: String(row.task_id), startedAt: String(row.started_at), stoppedAt: row.stopped_at ? String(row.stopped_at) : null, durationSeconds: Number(row.duration_seconds) }
}
async function stopEntry(tx: Transaction, scope: BoardScope, taskId: string): Promise<TimeEntry | null> {
  const { rows: [row] } = await tx.execute({ sql: `SELECT id, task_id, started_at FROM time_entries WHERE task_id = ? AND ${owner} AND stopped_at IS NULL ORDER BY started_at DESC LIMIT 1`, args: [taskId, ...ownerArgs(scope)] })
  if (!row) return null
  const now = new Date()
  const durationSeconds = Math.max(0, Math.round((now.getTime() - new Date(String(row.started_at)).getTime()) / 1000))
  await tx.execute({ sql: `UPDATE time_entries SET stopped_at = ?, duration_seconds = ? WHERE id = ? AND ${owner}`, args: [now.toISOString(), durationSeconds, row.id!, ...ownerArgs(scope)] })
  return { id: String(row.id), taskId, startedAt: String(row.started_at), stoppedAt: now.toISOString(), durationSeconds }
}
export async function startTimeEntryForTask(scope: BoardScope, taskId: string, expectedAssignedTo?: string): Promise<TimeEntryMutationResult> {
  try {
    const entry = await writer(scope, taskId, async tx => {
      await stopEntry(tx, scope, taskId)
      const id = `pom_${crypto.randomUUID()}`, startedAt = new Date().toISOString()
      await tx.execute({ sql: `INSERT INTO time_entries(id, task_id, started_at, duration_seconds, board_id, principal_kind, principal_id) VALUES (?, ?, ?, 0, ?, ?, ?)`, args: [id, taskId, startedAt, ...ownerArgs(scope)] })
      return { id, taskId, startedAt, stoppedAt: null, durationSeconds: 0 }
    }, expectedAssignedTo)
    return { ok: true, entry }
  } catch (error) {
    if (error instanceof PomodoroTaskUnavailableError) return { ok: false, errorCode: expectedAssignedTo === undefined ? "not_found" : "assignee_mismatch" }
    throw error
  }
}
export async function stopTimeEntryForTask(scope: BoardScope, taskId: string, expectedAssignedTo?: string): Promise<TimeEntryMutationResult> {
  try { return { ok: true, entry: await writer(scope, taskId, tx => stopEntry(tx, scope, taskId), expectedAssignedTo) } }
  catch (error) {
    if (error instanceof PomodoroTaskUnavailableError) return { ok: false, errorCode: expectedAssignedTo === undefined ? "not_found" : "assignee_mismatch" }
    throw error
  }
}
export async function startTimeEntry(scope: BoardScope, taskId: string): Promise<TimeEntry> {
  const result = await startTimeEntryForTask(scope, taskId)
  if (!result.ok || !result.entry) throw new PomodoroTaskUnavailableError("Task unavailable")
  return result.entry
}
export async function stopTimeEntry(scope: BoardScope, taskId: string): Promise<TimeEntry | null> {
  const result = await stopTimeEntryForTask(scope, taskId)
  return result.ok ? result.entry : null
}
export async function getTimeEntries(scope: BoardScope, taskId: string): Promise<TimeEntry[]> {
  await ensurePomodoroSchema()
  const result = await boardOperationClient(getPersistenceClient(), scope, { resource: "task", action: "read" }, [taskId]).execute({ sql: `SELECT id, task_id, started_at, stopped_at, duration_seconds FROM time_entries WHERE task_id = ? AND ${owner} ORDER BY started_at DESC`, args: [taskId, ...ownerArgs(scope)] })
  return result.rows.map(timeEntry)
}
export async function getTotalTimeForTask(scope: BoardScope, taskId: string): Promise<number> {
  return (await getTimeEntries(scope, taskId)).reduce((sum, row) => sum + row.durationSeconds, 0)
}
export function resetPomodoroForTests(): void { for (const timer of timers.values()) stop(timer); timers.clear() }
