import { resolveHAAssignmentProof } from "../assignment-proof"
import { createHash } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import type { Client, InStatement, Row } from "@libsql/client"
import { normalizeLabelTitle } from "@domains/labels"
import type { HomeAssistantAreaSelection } from "../../../lib/home-assistant-area-access"
import { taskDraftSnapshot, type SavedTaskDraft, type TaskDraftRead, type TaskDraftReceipt, type TaskDraftVersion, type TaskDraftWrite } from "../../../lib/task-draft-state"
import { requireBoardScope, scopeBoardAccess, type BoardScope } from "../board-scope"
import { taskCreationPayload } from "../task-creation-service"
import { boardOperationClient, BoardOperationError } from "./board-operation-client"
import { taskOwnedBy } from "./board-storage"
import { recentActivityPersonKey } from "./recent-activity"
import { TaskRepository, type TaskCreationData } from "./task-repository"
import { sql, sourceSql, type SqlFragment } from "./sql-fragment"

type Save = Extract<TaskDraftWrite, { action: "save" }>
type Publish = Extract<TaskDraftWrite, { action: "publish" }>
type Abandon = Extract<TaskDraftWrite, { action: "abandon-publish" }>
type Resolution = { state: "saved" | "open" | "unavailable" } | { state: "published", receipt: TaskDraftReceipt }

export class DraftLabelsChangedError extends Error {
  readonly status = 409
  readonly errorCode = "STALE_LABELS"
  constructor() { super("A selected label changed. Keep your draft, then remove the old label or explicitly create it again.") }
}

function draftFromRow(row: Row | undefined): SavedTaskDraft | null {
  return row ? { draftId: String(row.draft_id), revision: Number(row.revision), updatedAt: Number(row.updated_at), snapshot: taskDraftSnapshot.parse(JSON.parse(String(row.snapshot_json))) } : null
}
function receiptFromRow(row: Row | undefined): TaskDraftReceipt | null {
  return row ? { draftId: String(row.draft_id), revision: Number(row.revision), taskId: String(row.task_id), ticketKey: row.ticket_key == null ? null : String(row.ticket_key), publishedAt: Number(row.published_at) } : null
}
function matchesVersion(row: Row | undefined, version: TaskDraftVersion): boolean { return row?.draft_id === version.draftId && row?.revision === version.revision }

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

export class TaskDraftRepository {
  constructor(private readonly client: Client, private readonly scope: BoardScope) { requireBoardScope(scope) }
  private owner(ownerId: string) {
    if (!["ha_user", "local_operator"].includes(this.scope.principal.kind) || ownerId !== this.scope.principal.id) throw new BoardOperationError("unavailable")
  }
  private db() { return boardOperationClient(this.client, this.scope, { resource: "task", action: "edit" }) }
  private draft(ownerId: string): SqlFragment { return sql`SELECT * FROM task_drafts WHERE owner_id = ${ownerId} AND board_id = ${this.scope.boardId}` }
  private match(ownerId: string, version: TaskDraftVersion): SqlFragment {
    return sql`owner_id = ${ownerId} AND board_id = ${this.scope.boardId} AND draft_id = ${version.draftId} AND revision = ${version.revision}`
  }
  private receipt(ownerId: string, version?: TaskDraftVersion, attemptId?: string): SqlFragment {
    return sql`SELECT r.*, COALESCE(t.ticket_ref, ${scopeBoardAccess(this.scope).ticketPrefix} || '-' || t.ticket_number) AS ticket_key
      FROM task_draft_receipts AS r LEFT JOIN tasks AS t ON t.id = r.task_id AND ${taskOwnedBy(this.scope, "t")}
      WHERE r.owner_id = ${ownerId} AND r.board_id = ${this.scope.boardId}
      ${version ? sql`AND r.draft_id = ${version.draftId} AND r.revision = ${version.revision} AND r.attempt_id = ${attemptId ?? null}` : sourceSql("ORDER BY r.published_seq DESC LIMIT 1")}`
  }
  private async write(statements: InStatement[]) {
    for (const delay of [5, 15, 30, 60]) {
      try { return await this.db().batch(statements, "write") } catch (error) { if (!isDraftWriterBusy(error)) throw error; await setTimeout(delay) }
    }
    return this.db().batch(statements, "write")
  }
  private async validateLabels(reader: Pick<Client, "execute">, catalog: readonly string[]) {
    if (!catalog.length) return
    const { rows: [invalid] } = await reader.execute(sql`SELECT 1 FROM json_each(${JSON.stringify(catalog)}) AS wanted
      WHERE NOT EXISTS (SELECT 1 FROM vikunja_labels WHERE board_id = ${this.scope.boardId} AND lower(title) = lower(wanted.value)) LIMIT 1`)
    if (invalid) throw new DraftLabelsChangedError()
  }
  async read(ownerId: string, selector?: TaskDraftRead["resolve"]) {
    this.owner(ownerId)
    const [draftRows, latestRows, exactRows] = await this.db().batch([this.draft(ownerId), this.receipt(ownerId), ...(selector?.kind === "publish" ? [this.receipt(ownerId, selector, selector.attemptId)] : [])], "read")
    const row = draftRows?.rows[0]
    const receipt = receiptFromRow(exactRows?.rows[0])
    let resolution: Resolution | undefined
    if (selector?.kind === "save") resolution = { state: row?.save_attempt_id === selector.attemptId ? "saved" : "unavailable" }
    else if (selector?.kind === "publish") resolution = receipt ? { state: "published", receipt } : { state: matchesVersion(row, selector) ? "open" : "unavailable" }
    return { draft: draftFromRow(row), latestReceipt: receiptFromRow(latestRows?.rows[0]), resolution }
  }
  async save(ownerId: string, { expected, attemptId, snapshot }: Save, now = Date.now()) {
    this.owner(ownerId)
    const digest = fingerprint(snapshot)
    const tx = await this.db().transaction("write")
    try {
      await this.validateLabels(tx, snapshot.labels.filter(name => !snapshot.newLabels.includes(name)))
      if (expected) await tx.execute(sql`UPDATE task_drafts SET revision = revision + 1, snapshot_json = ${JSON.stringify(snapshot)}, updated_at = ${now}, save_attempt_id = ${attemptId}, save_digest = ${digest}
        WHERE ${this.match(ownerId, expected)} AND save_attempt_id IS NOT ${attemptId}`)
      else await tx.execute(sql`INSERT INTO task_drafts(owner_id, board_id, draft_id, revision, snapshot_json, updated_at, save_attempt_id, save_digest)
        VALUES (${ownerId}, ${this.scope.boardId}, ${crypto.randomUUID()}, 1, ${JSON.stringify(snapshot)}, ${now}, ${attemptId}, ${digest}) ON CONFLICT(owner_id, board_id) DO NOTHING`)
      const { rows: [row] } = await tx.execute(this.draft(ownerId))
      await tx.commit()
      return row?.save_attempt_id === attemptId && row.save_digest === digest ? draftFromRow(row) : null
    } finally { tx.close() }
  }
  async discard(ownerId: string, expected: TaskDraftVersion): Promise<boolean> {
    this.owner(ownerId)
    const [deleted] = await this.write([sql`DELETE FROM task_drafts WHERE ${this.match(ownerId, expected)} RETURNING draft_id`])
    return Boolean(deleted?.rows.length)
  }
  async abandon(ownerId: string, { expected, attemptId }: Abandon, now = Date.now()) {
    this.owner(ownerId)
    const [receiptRows, advanced] = await this.write([this.receipt(ownerId, expected, attemptId), sql`UPDATE task_drafts SET revision = revision + 1, updated_at = ${now}, save_attempt_id = '', save_digest = '' WHERE ${this.match(ownerId, expected)} RETURNING *`])
    return { receipt: receiptFromRow(receiptRows?.rows[0]), draft: draftFromRow(advanced?.rows[0]) }
  }
  async replay(ownerId: string, { expected, attemptId, task }: Publish) {
    this.owner(ownerId)
    const { rows: [row] } = await this.db().execute(this.receipt(ownerId, expected, attemptId))
    return row?.request_digest === fingerprint(task) ? receiptFromRow(row) : null
  }
  async publish(ownerId: string, input: Publish, prepared: TaskCreationData | null, now = Date.now(), area?: HomeAssistantAreaSelection) {
    this.owner(ownerId)
    const { expected, attemptId, task } = input
    const digest = fingerprint(task)
    const assignmentProof = prepared?.assigned_to?.startsWith("ha_") ? await resolveHAAssignmentProof(this.scope, prepared.assigned_to.slice(3)) : undefined
    const tx = await this.db().transaction("write")
    try {
      const { rows: [previous] } = await tx.execute(this.receipt(ownerId, expected, attemptId))
      const { rows: [draft] } = await tx.execute(this.draft(ownerId))
      if (previous) return { receipt: previous.request_digest === digest ? receiptFromRow(previous) : null, conflict: !matchesVersion(draft, expected), eventId: null, ticketNumber: null }
      if (!prepared || !matchesVersion(draft, expected)) return { receipt: null, conflict: !matchesVersion(draft, expected), eventId: null, ticketNumber: null }
      const newLabels = [...new Set(task.newLabels)]
      if (newLabels.some(name => !name || normalizeLabelTitle(name) !== name)) return { receipt: null, conflict: false, eventId: null, ticketNumber: null }
      await this.validateLabels(tx, task.catalogLabels)
      const eventId = crypto.randomUUID()
      const created = await new TaskRepository(this.client, this.scope).createWorkInWriter(tx, prepared, {
        requestId: eventId, newLabels, assignmentProof, activityActor: { kind: "human", personKey: recentActivityPersonKey(ownerId) }, ...(area ? { homeLocation: area } : {}),
      }, now)
      if (!created.ok) return { receipt: null, conflict: false, eventId: null, ticketNumber: null }
      const correlated = await tx.execute(sql`UPDATE task_activity_log SET correlation_id = ${eventId}
        WHERE task_id = ${created.task.id} AND field = 'created' AND feed_action = 'added'
          AND feed_person_key = ${recentActivityPersonKey(ownerId)} AND correlation_id IS NULL`)
      if (correlated.rowsAffected !== 1) throw new Error("The draft publication activity could not be correlated")
      await tx.execute(sql`INSERT INTO task_draft_receipts(owner_id, board_id, draft_id, revision, attempt_id, request_digest, task_id, event_id, published_at)
        VALUES (${ownerId}, ${this.scope.boardId}, ${expected.draftId}, ${expected.revision}, ${attemptId}, ${digest}, ${created.task.id}, ${eventId}, ${now})`)
      const deleted = await tx.execute(sql`DELETE FROM task_drafts WHERE ${this.match(ownerId, expected)}`)
      if (deleted.rowsAffected !== 1) throw new Error("The draft changed while publishing")
      const payload = { ...taskCreationPayload(prepared, created.ticketNumber, now), board_id: this.scope.boardId, ticket_key: created.task.ticket_ref }
      await tx.execute(sql`INSERT INTO domain_events(event_id,event_type,task_id,request_id,idempotency_key,payload,created_at)
        VALUES (${eventId}, 'task.created', ${created.task.id}, ${eventId}, ${eventId}, ${JSON.stringify(payload)}, ${now})`)
      const { rows: [receipt] } = await tx.execute(this.receipt(ownerId, expected, attemptId))
      await tx.commit()
      return { receipt: receiptFromRow(receipt), conflict: false, eventId, ticketNumber: created.ticketNumber }
    } finally { tx.close() }
  }
}
