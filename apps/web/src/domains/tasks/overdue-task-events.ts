import type { Client } from "@libsql/client"

export const OVERDUE_CHECKPOINT_KEY = "system.overdue-events.checked-at"
export const OVERDUE_BATCH_LIMIT = 100

type Dispatch = (event: string, task: Record<string, unknown>, requestId: string) => Promise<unknown>

// Same instant semantics as the task API: ISO dates/date-times or epoch-ms text.
const DUE_MS = `CASE
  WHEN due_date NOT GLOB '*[^0-9]*' AND length(due_date) >= 12
    THEN CAST(due_date AS INTEGER)
  ELSE CAST(ROUND((julianday(due_date) - 2440587.5) * 86400000) AS INTEGER)
END`
const EVENT_ID = "'overdue:' || length(id) || ':' || id || ':' || due_date"
// Existing stores may retain terminal aliases from before status normalization.
const OPEN_TASK_LEGACY_COMPAT = "status NOT IN ('complete', 'done', 'archived', 'cancelled', 'canceled')"

/**
 * Record observed overdue transitions once per task/due-date value, then route
 * them through the existing best-effort dispatcher. Ledger rows acknowledge
 * observation, not receipt by HA or a webhook subscriber.
 */
export async function checkOverdueTaskEvents(
  client: Pick<Client, "execute">,
  dispatch: Dispatch,
  now = Date.now(),
): Promise<{ observed: number; dispatchFailed: number; baselineCreated: boolean }> {
  const initialized = await client.execute({
    sql: "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
    args: [OVERDUE_CHECKPOINT_KEY, String(now), now],
  })
  if (initialized.rowsAffected > 0) {
    // First installation starts observation now, without replaying old tasks.
    return { observed: 0, dispatchFailed: 0, baselineCreated: true }
  }

  const checkpoint = await client.execute({
    sql: "SELECT value FROM app_settings WHERE key = ?",
    args: [OVERDUE_CHECKPOINT_KEY],
  })
  const storedValue = String(checkpoint.rows[0]?.value ?? "")
  const since = Number(storedValue)
  if (!Number.isFinite(since) || since < 0) throw new Error("Invalid overdue event checkpoint")
  if (now <= since) return { observed: 0, dispatchFailed: 0, baselineCreated: false }

  // Index-backed ranges keep historical task inventories out of normal ticks.
  // +/- one day covers offsets in ISO date-times; the exact instant predicate
  // below still decides whether a due time crossed. Recent due-date edits are
  // checked independently so moving a deadline into the past is observed too.
  const ranges = [
    { where: "due_date >= ? AND due_date <= ?", args: [new Date(since - 86400000).toISOString(), new Date(now + 86400000).toISOString()] },
    { where: "due_date >= ? AND due_date <= ?", args: [String(since), String(now)] },
    { where: "updated_at > ? AND updated_at <= ?", args: [since, now] },
  ]
  const candidates = new Map<string, Record<string, unknown>>()
  let batchFull = false
  for (const range of ranges) {
    const result = await client.execute({
      sql: `SELECT *, ${DUE_MS} AS overdue_due_ms, ${EVENT_ID} AS overdue_event_id
            FROM tasks
            WHERE (${range.where}) AND ${OPEN_TASK_LEGACY_COMPAT}
              AND due_date IS NOT NULL AND due_date != ''
              AND ${DUE_MS} <= ?
              AND (${DUE_MS} > ? OR updated_at > ?)
              AND NOT EXISTS (SELECT 1 FROM domain_events WHERE event_id = ${EVENT_ID})
            ORDER BY ${DUE_MS}, id LIMIT ?`,
      args: [...range.args, now, since, since, OVERDUE_BATCH_LIMIT],
    })
    if (result.rows.length === OVERDUE_BATCH_LIMIT) batchFull = true
    for (const row of result.rows) candidates.set(String(row.id), row)
  }

  let observed = 0
  let dispatchFailed = 0
  const tasks = [...candidates.values()].sort((a, b) =>
    Number(a.overdue_due_ms) - Number(b.overdue_due_ms) || String(a.id).localeCompare(String(b.id)),
  )
  if (tasks.length > OVERDUE_BATCH_LIMIT) batchFull = true
  for (const task of tasks.slice(0, OVERDUE_BATCH_LIMIT)) {
    const eventId = String(task.overdue_event_id)
    const { overdue_due_ms: _dueMs, overdue_event_id: _eventId, ...payload } = task
    const recorded = await client.execute({
      // Recheck state at the atomic claim, in case completion/due-date changes
      // happened after selection. The primary key arbitrates concurrent ticks.
      sql: `INSERT INTO domain_events
              (event_id, event_type, task_id, request_id, idempotency_key, payload, created_at)
            SELECT ?, 'task.overdue', id, ?, ?, ?, ? FROM tasks
            WHERE id = ? AND due_date = ? AND ${OPEN_TASK_LEGACY_COMPAT}
            ON CONFLICT(event_id) DO NOTHING`,
      args: [eventId, eventId, eventId, JSON.stringify(payload), now, String(task.id), String(task.due_date)],
    })
    if (recorded.rowsAffected === 0) continue
    observed++
    try {
      await dispatch("task.overdue", payload, eventId)
    } catch {
      dispatchFailed++
    }
  }

  // Leave the window open while a bounded backlog remains. Already-recorded
  // episodes are excluded on the next tick, including after a process restart.
  if (!batchFull) {
    await client.execute({
      sql: "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
      args: [String(now), now, OVERDUE_CHECKPOINT_KEY, storedValue],
    })
  }
  return { observed, dispatchFailed, baselineCreated: false }
}
