import { guardClientContinuity } from "./persistence/continuity-client"
import { acquireWriteTransaction } from "../../../scripts/database-client.mjs"
import { validateIntegrationScope, type IntegrationScope } from "./board-automation"
import { validateBoardPlacement } from "./board-access-service"
import type { BoardScope } from "./board-scope"
import { scopedTaskRead } from "./persistence/board-work-query"
import { taskOwnedBy } from "./persistence/board-storage"
import { sql, sourceSql } from "./persistence/sql-fragment"
import { projectPublicTaskFields } from "./task-projection"
import { formatTicketKey } from "../../lib/ticket-key"
import type { Client } from "@libsql/client"

export const OVERDUE_CHECKPOINT_KEY = "system.overdue-events.checked-at"
export const OVERDUE_BATCH_LIMIT = 100

type Dispatch = (event: string, task: Record<string, unknown>, requestId: string, scope: BoardScope) => Promise<unknown>

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
  sourceClient: Client,
  dispatch: Dispatch,
  now: number,
  context: IntegrationScope,
): Promise<{ observed: number; dispatchFailed: number; baselineCreated: boolean }> {
  const empty = { observed: 0, dispatchFailed: 0, baselineCreated: false }
  if (context.binding.purpose !== "builtin.overdue.observe" ||
    !(await validateIntegrationScope(context, sourceClient, { resource: "task", action: "read" })).ok) return empty
  const client = guardClientContinuity(sourceClient)
  const checkpointKey = `${OVERDUE_CHECKPOINT_KEY}:${context.scope.boardId}`
  const initialWriter = await acquireWriteTransaction(client)
  let baselineCreated = false
  try {
    if (!(await validateIntegrationScope(context, initialWriter, { resource: "task", action: "edit" })).ok) return empty
    const initialized = await initialWriter.execute({
    sql: "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
    args: [checkpointKey, String(now), now],
  })
    baselineCreated = initialized.rowsAffected > 0
    await initialWriter.commit()
  } finally { initialWriter.close() }
  if (baselineCreated) {
    // First installation starts observation now, without replaying old tasks.
    return { observed: 0, dispatchFailed: 0, baselineCreated: true }
  }

  const checkpoint = await client.execute({
    sql: "SELECT value FROM app_settings WHERE key = ?",
    args: [checkpointKey],
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
    const result = await client.execute(scopedTaskRead(context.scope, sourceSql(`SELECT *, ${DUE_MS} AS overdue_due_ms, ${EVENT_ID} AS overdue_event_id
            FROM scoped_tasks
            WHERE (${range.where}) AND ${OPEN_TASK_LEGACY_COMPAT}
              AND due_date IS NOT NULL AND due_date != ''
              AND ${DUE_MS} <= ?
              AND (${DUE_MS} > ? OR updated_at > ?)
              AND NOT EXISTS (SELECT 1 FROM domain_events WHERE event_id = ${EVENT_ID})
            ORDER BY ${DUE_MS}, id LIMIT ?`,
      [...range.args, now, since, since, OVERDUE_BATCH_LIMIT],
    )))
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
    if (!(await validateIntegrationScope(context, client, { resource: "task", action: "read" })).ok) break
    const eventId = String(task.overdue_event_id)
    const payload = projectPublicTaskFields(task)
    payload.board_id = context.scope.boardId
    payload.ticket_key = task.ticket_ref ?? formatTicketKey(task.ticket_number == null ? null : Number(task.ticket_number))
    const writer = await acquireWriteTransaction(client)
    let claimed = false
    try {
      if (!(await validateIntegrationScope(context, writer, { resource: "task", action: "edit" })).ok) break
      if (!await validateBoardPlacement(context.scope, writer, {
        areaId: task.area_id == null ? null : String(task.area_id),
        projectId: task.project_id == null ? null : String(task.project_id),
      })) continue
      const recorded = await writer.execute(sql`INSERT INTO domain_events
        (event_id, event_type, task_id, request_id, idempotency_key, payload, created_at)
        SELECT ${eventId}, 'task.overdue', id, ${eventId}, ${eventId}, ${JSON.stringify(payload)}, ${now}
        FROM tasks WHERE ${taskOwnedBy(context.scope)} AND id = ${String(task.id)}
          AND due_date = ${String(task.due_date)} AND updated_at = ${task.updated_at as string | number}
          AND ${sourceSql(OPEN_TASK_LEGACY_COMPAT)}
        ON CONFLICT(event_id) DO NOTHING`)
      if (!(await validateIntegrationScope(context, writer, { resource: "task", action: "edit" })).ok) break
      await writer.commit()
      claimed = recorded.rowsAffected > 0
    } finally { writer.close() }
    if (!claimed) continue
    observed++
    try {
      if (!(await validateIntegrationScope(context, client, { resource: "task", action: "read" })).ok) break
      await dispatch("task.overdue", payload, eventId, context.scope)
    } catch { dispatchFailed++ }
  }

  // Leave the window open while a bounded backlog remains. Already-recorded
  // episodes are excluded on the next tick, including after a process restart.
  if (!batchFull) {
    const writer = await acquireWriteTransaction(client)
    try {
      if ((await validateIntegrationScope(context, writer, { resource: "task", action: "edit" })).ok) {
        await writer.execute({
          sql: "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
          args: [String(now), now, checkpointKey, storedValue],
        })
        await writer.commit()
      }
    } finally { writer.close() }
  }

  return { observed, dispatchFailed, baselineCreated: false }
}
