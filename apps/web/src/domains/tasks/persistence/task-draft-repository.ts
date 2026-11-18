import type { HomeAssistantAreaSelection } from "../../../lib/home-assistant-area-access"
import { readHomeAssistantAreaPolicyRevision } from "./home-assistant-task-area"
import { createHash } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import type { Client, InStatement, Row } from "@libsql/client"
import { normalizeLabelTitle, taskLabelInsert } from "@domains/labels"
import { taskCreationPayload } from "../task-creation-service"
import { formatTicketKey } from "../../../lib/ticket-key"
import {
  taskDraftSnapshot,
  type SavedTaskDraft,
  type TaskDraftRead,
  type TaskDraftReceipt,
  type TaskDraftVersion,
  type TaskDraftWrite,
} from "../../../lib/task-draft-state"
import { recentActivityPersonKey } from "./recent-activity"
import { taskInsertStatement, type TaskCreationData } from "./task-repository"

type Save = Extract<TaskDraftWrite, { action: "save" }>
type Publish = Extract<TaskDraftWrite, { action: "publish" }>
type Abandon = Extract<TaskDraftWrite, { action: "abandon-publish" }>
type Resolution = { state: "saved" | "open" | "unavailable" } | { state: "published"; receipt: TaskDraftReceipt }

const draftOwner = "owner_id = ? AND board_id = 'household'"
const activeDraft = `SELECT * FROM task_drafts WHERE ${draftOwner}`
const matchesDraft = `${draftOwner} AND draft_id = ? AND revision = ?`
const receiptOwner = "r.owner_id = ? AND r.board_id = 'household'"
const receiptSelect = `SELECT r.*, t.ticket_number FROM task_draft_receipts r
                        LEFT JOIN tasks t ON t.id = r.task_id AND t.task_board_id IS NULL`

function versionArgs(ownerId: string, version: TaskDraftVersion) {
  return [ownerId, version.draftId, version.revision]
}

function draftFromRow(row: Row | undefined): SavedTaskDraft | null {
  if (!row) return null
  return {
    draftId: String(row.draft_id),
    revision: Number(row.revision),
    updatedAt: Number(row.updated_at),
    snapshot: taskDraftSnapshot.parse(JSON.parse(String(row.snapshot_json))),
  }
}

function receiptFromRow(row: Row | undefined): TaskDraftReceipt | null {
  if (!row) return null
  return {
    draftId: String(row.draft_id),
    revision: Number(row.revision),
    taskId: String(row.task_id),
    ticketKey: formatTicketKey(typeof row.ticket_number === "number" ? row.ticket_number : null),
    publishedAt: Number(row.published_at),
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function isDraftWriterBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY"
}

function exactReceipt(ownerId: string, version: TaskDraftVersion, attemptId: string): InStatement {
  return {
    sql: `${receiptSelect} WHERE ${receiptOwner} AND r.draft_id = ? AND r.revision = ? AND r.attempt_id = ?`,
    args: [...versionArgs(ownerId, version), attemptId],
  }
}

function matchesVersion(row: Row | undefined, version: TaskDraftVersion): boolean {
  return row?.draft_id === version.draftId && row?.revision === version.revision
}

export class TaskDraftRepository {
  constructor(private readonly client: Client) {}

  private async write(statements: InStatement[]) {
    for (const delay of [5, 15, 30, 60]) {
      try {
        return await this.client.batch(statements, "write")
      } catch (error) {
        if (!isDraftWriterBusy(error)) throw error
        await setTimeout(delay)
      }
    }
    return this.client.batch(statements, "write")
  }

  async read(ownerId: string, selector?: TaskDraftRead["resolve"]) {
    const statements: InStatement[] = [
      { sql: activeDraft, args: [ownerId] },
      {
        sql: `${receiptSelect} WHERE ${receiptOwner} ORDER BY r.published_seq DESC LIMIT 1`,
        args: [ownerId],
      },
    ]
    if (selector?.kind === "publish") statements.push(exactReceipt(ownerId, selector, selector.attemptId))

    const [draftRows, latestRows, exactRows] = await this.client.batch(statements, "read")
    const row = draftRows?.rows[0]
    const receipt = receiptFromRow(exactRows?.rows[0])
    let resolution: Resolution | undefined
    if (selector?.kind === "save") {
      resolution = { state: row?.save_attempt_id === selector.attemptId ? "saved" : "unavailable" }
    } else if (selector?.kind === "publish") {
      resolution = receipt ? { state: "published", receipt }
        : { state: matchesVersion(row, selector) ? "open" : "unavailable" }
    }
    return { draft: draftFromRow(row), latestReceipt: receiptFromRow(latestRows?.rows[0]), resolution }
  }

  async save(ownerId: string, { expected, attemptId, snapshot }: Save, now = Date.now()) {
    const digest = fingerprint(snapshot)
    const values = [JSON.stringify(snapshot), now, attemptId, digest]
    const [, selected] = await this.write([
      expected ? {
        sql: `UPDATE task_drafts SET revision = revision + 1, snapshot_json = ?, updated_at = ?,
                save_attempt_id = ?, save_digest = ?
              WHERE ${matchesDraft} AND save_attempt_id IS NOT ?`,
        args: [...values, ...versionArgs(ownerId, expected), attemptId],
      } : {
        sql: `INSERT INTO task_drafts (owner_id, board_id, draft_id, revision, snapshot_json, updated_at, save_attempt_id, save_digest)
              VALUES (?, 'household', ?, 1, ?, ?, ?, ?) ON CONFLICT(owner_id, board_id) DO NOTHING`,
        args: [ownerId, crypto.randomUUID(), ...values],
      },
      { sql: activeDraft, args: [ownerId] },
    ])
    const row = selected?.rows[0]
    return row?.save_attempt_id === attemptId && row.save_digest === digest ? draftFromRow(row) : null
  }

  async discard(ownerId: string, expected: TaskDraftVersion): Promise<boolean> {
    const [deleted] = await this.write([{
      sql: `DELETE FROM task_drafts WHERE ${matchesDraft} RETURNING draft_id`,
      args: versionArgs(ownerId, expected),
    }])
    return Boolean(deleted?.rows.length)
  }

  async abandon(ownerId: string, { expected, attemptId }: Abandon, now = Date.now()) {
    const [receiptRows, advanced] = await this.write([
      exactReceipt(ownerId, expected, attemptId),
      {
        sql: `UPDATE task_drafts SET revision = revision + 1, updated_at = ?, save_attempt_id = '', save_digest = ''
              WHERE ${matchesDraft} RETURNING *`,
        args: [now, ...versionArgs(ownerId, expected)],
      },
    ])
    return { receipt: receiptFromRow(receiptRows?.rows[0]), draft: draftFromRow(advanced?.rows[0]) }
  }

  async replay(ownerId: string, { expected, attemptId, task }: Publish) {
    const rows = await this.client.execute(exactReceipt(ownerId, expected, attemptId))
    const row = rows.rows[0]
    return row?.request_digest === fingerprint(task) ? receiptFromRow(row) : null
  }

  async publish(ownerId: string, input: Publish, prepared: TaskCreationData | null, now = Date.now(), area?: HomeAssistantAreaSelection) {
    const { expected, attemptId, task } = input
    const exact = exactReceipt(ownerId, expected, attemptId)
    const current: InStatement = { sql: activeDraft, args: [ownerId] }
    const digest = fingerprint(task)
    const newLabels = [...new Set(task.newLabels)]
    if (!prepared || newLabels.some(name => !name || normalizeLabelTitle(name) !== name)) {
      const [receiptRows, draftRows] = await this.client.batch([exact, current], "read")
      const row = receiptRows?.rows[0]
      return {
        receipt: row?.request_digest === digest ? receiptFromRow(row) : null,
        conflict: !matchesVersion(draftRows?.rows[0], expected),
        eventId: null,
        ticketNumber: null,
      }
    }

    const eventId = crypto.randomUUID()
    const writeGuard = {
      sql: `EXISTS (SELECT 1 FROM task_drafts WHERE ${matchesDraft})
        AND NOT EXISTS (SELECT 1 FROM task_draft_receipts r WHERE ${receiptOwner} AND r.attempt_id = ?)
        AND EXISTS (SELECT 1 FROM kanban_lanes WHERE board_id = 'household' AND key = ?)
        AND (? <> 'backlog' OR COALESCE((
          SELECT CASE WHEN json_valid(value) THEN COALESCE(json_extract(value, '$'), 'unavailable')
                      ELSE 'unavailable' END FROM settings WHERE key = 'backlog_mode'
        ), 'visible') = 'visible')
        AND (? IS NULL OR EXISTS (SELECT 1 FROM goals WHERE id = ? AND owner_board_id IS NULL AND retired_at IS NULL))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_board_id IS NULL AND retired_at IS NULL
          AND status = 'active' AND COALESCE(area_id, 'default') = ?))
        AND (? IS NULL OR substr(?, 1, 3) = 'ha_' OR EXISTS (SELECT 1 FROM custom_users WHERE id = ?))
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS wanted
          WHERE NOT EXISTS (SELECT 1 FROM vikunja_labels WHERE lower(title) = lower(wanted.value))
        )`,
      args: [
        ...versionArgs(ownerId, expected), ownerId, attemptId, prepared.status, prepared.status,
        prepared.goal_id ?? null, prepared.goal_id ?? null,
        prepared.project_id ?? null, prepared.project_id ?? null, prepared.area_id,
        prepared.assigned_to, prepared.assigned_to, prepared.assigned_to, JSON.stringify(task.catalogLabels),
      ],
    }

    if (area) {
      const policy = readHomeAssistantAreaPolicyRevision(area.revision)
      writeGuard.sql += ` AND EXISTS (${policy.sql})`
      writeGuard.args.push(...policy.args)
    }
    // Every side effect is gated by the UUID of this insert, so a replay can only read its receipt.
    const [inserted, , , , , receiptRows, draftRows] = await this.write([
      taskInsertStatement(prepared, now, { idempotencyKey: eventId, requestId: eventId, guard: writeGuard }),
      {
        sql: `INSERT INTO task_draft_receipts
                (owner_id, board_id, draft_id, revision, attempt_id, request_digest, task_id, event_id, published_at)
              SELECT ?, 'household', ?, ?, ?, ?, id, ?, ? FROM tasks WHERE id = ? AND request_id = ?`,
        args: [...versionArgs(ownerId, expected), attemptId, digest, eventId, now, prepared.id, eventId],
      },
      {
        sql: `INSERT INTO task_activity_log
                (task_id, field, actor, actor_type, event_type, summary, correlation_id, created_at, feed_action, feed_person_key)
              SELECT id, 'created', ?, 'user', 'created', 'Task published from a draft', ?, ?, 'added', ?
              FROM tasks WHERE id = ? AND request_id = ?`,
        args: [ownerId, eventId, now, recentActivityPersonKey(ownerId), prepared.id, eventId],
      },
      {
        sql: `INSERT INTO domain_events (event_id, event_type, task_id, request_id, idempotency_key, payload, created_at)
              SELECT ?, 'task.created', id, ?, ?,
                     json_set(?, '$.ticket_number', ticket_number, '$.ticket_key', 'MTH-' || ticket_number), ?
              FROM tasks WHERE id = ? AND request_id = ?`,
        args: [eventId, eventId, eventId, JSON.stringify(taskCreationPayload(prepared, 0, now)), now, prepared.id, eventId],
      },
      {
        sql: `DELETE FROM task_drafts WHERE ${matchesDraft} AND EXISTS (SELECT 1 FROM tasks WHERE id = ? AND request_id = ?)`,
        args: [...versionArgs(ownerId, expected), prepared.id, eventId],
      },
      exact,
      current,
      ...newLabels.map(name => taskLabelInsert(name, prepared.id, eventId)),
      ...(area?.id ? [{
        sql: "INSERT INTO home_assistant_task_areas (task_id, area_id) SELECT id, ? FROM tasks WHERE id = ? AND request_id = ?",
        args: [area.id, prepared.id, eventId],
      }] : []),
    ])
    const row = receiptRows?.rows[0]
    const ticket = inserted?.rows[0]?.ticket_number
    return {
      receipt: row?.request_digest === digest ? receiptFromRow(row) : null,
      conflict: !matchesVersion(draftRows?.rows[0], expected),
      eventId: typeof ticket === "number" ? eventId : null,
      ticketNumber: typeof ticket === "number" ? ticket : null,
    }
  }
}
