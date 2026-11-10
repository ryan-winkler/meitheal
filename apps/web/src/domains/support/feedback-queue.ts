import { createHash, randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"
import type { Client, Row } from "@libsql/client"

const CATEGORIES = ["problem", "accessibility", "suggestion", "other"] as const
const ROUTE_FAMILIES = ["home", "tasks", "calendar", "settings", "other"] as const
const REVIEW_STATES = ["in_progress", "resolved", "declined"] as const
const STATES = ["open", ...REVIEW_STATES] as const
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SCOPE_ID = /^[0-9A-Za-z:_-]{1,128}$/
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:[-+][0-9a-z][0-9a-z.-]{0,31})?$/i

export const MAX_FEEDBACK_MESSAGE_BYTES = 4 * 1024
export const MAX_FEEDBACK_DISPOSITION_BYTES = 1024
export const MAX_FEEDBACK_REPORTS = 500
export const MAX_FEEDBACK_RESERVED_BYTES = 4 * 1024 * 1024
export const FEEDBACK_PAGE_SIZE = 50

type FeedbackCategory = typeof CATEGORIES[number]
type FeedbackRouteFamily = typeof ROUTE_FAMILIES[number]
export type FeedbackState = typeof STATES[number]

/** Server-owned scope. Construct only after authenticating the actor and installation. */
export interface VerifiedFeedbackActor {
  installationId: string
  actorId: string
  role: "member" | "admin"
}

interface FeedbackContent {
  category: FeedbackCategory
  message: string
  appVersion: string | null
  routeFamily: FeedbackRouteFamily | null
}

export interface FeedbackReceipt {
  id: string
  receivedAt: number
}

export interface FeedbackReport extends FeedbackContent, FeedbackReceipt {
  submitterId: string
  state: FeedbackState
  claimedBy: string | null
  closedBy: string | null
  disposition: string | null
}

export interface FeedbackCursor {
  receivedAt: number
  id: string
}

type FeedbackError = "forbidden" | "invalid_input" | "conflict" | "queue_full" | "not_found"
export type FeedbackResult<T> = { ok: true, value: T } | { ok: false, errorCode: FeedbackError }

const REPORT_FIELDS = `id, created_at, submitter_id, category, message, app_version,
  route_family, state, claimed_by, closed_by, disposition`

function hasFeedbackScope(actor: VerifiedFeedbackActor | null): actor is VerifiedFeedbackActor {
  return !!actor
    && typeof actor.installationId === "string" && SCOPE_ID.test(actor.installationId)
    && typeof actor.actorId === "string" && SCOPE_ID.test(actor.actorId)
    && (actor.role === "admin" || actor.role === "member")
}

function isAdmin(actor: VerifiedFeedbackActor | null): actor is VerifiedFeedbackActor {
  return hasFeedbackScope(actor) && actor.role === "admin"
}

function isAllowed<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && allowed.some(item => item === value)
}

function isReportId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value)
}

function plainText(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || Buffer.byteLength(value) > maxBytes) return null
  const text = value.replace(/\r\n?/g, "\n").trim()
  return text && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ud800-\udfff]/u.test(text) ? text : null
}

function parseSubmission(input: unknown): { submissionId: string, content: FeedbackContent } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const { submissionId, category, message, appVersion, routeFamily, ...extra } = input as Record<string, unknown>
  if (Object.keys(extra).length || !isReportId(submissionId)
    || !isAllowed(CATEGORIES, category)
    || (appVersion !== undefined && (typeof appVersion !== "string" || !VERSION.test(appVersion)))
    || (routeFamily !== undefined && !isAllowed(ROUTE_FAMILIES, routeFamily))) return null
  const text = plainText(message, MAX_FEEDBACK_MESSAGE_BYTES)
  if (!text) return null

  return {
    submissionId: submissionId.toLowerCase(),
    content: {
      category,
      message: text,
      appVersion: appVersion ?? null,
      routeFamily: routeFamily ?? null,
    },
  }
}

function toReceipt(row: Row): FeedbackReceipt {
  return { id: String(row.id), receivedAt: Number(row.created_at) }
}

function toReport(row: Row): FeedbackReport {
  return {
    ...toReceipt(row),
    submitterId: String(row.submitter_id),
    category: row.category as FeedbackCategory,
    message: String(row.message),
    appVersion: row.app_version as string | null,
    routeFamily: row.route_family as FeedbackRouteFamily | null,
    state: row.state as FeedbackState,
    claimedBy: row.claimed_by as string | null,
    closedBy: row.closed_by as string | null,
    disposition: row.disposition as string | null,
  }
}

// The local client fails immediately when a separate SQLite connection holds a writer lock.
async function retryBusyWrite<T>(write: () => Promise<T>): Promise<T> {
  for (const delay of [5, 15, 30, 60]) {
    try {
      return await write()
    } catch (error) {
      if (typeof error !== "object" || !error || !("code" in error) || error.code !== "SQLITE_BUSY") throw error
    }
    await setTimeout(delay)
  }
  return write()
}

export class FeedbackQueue {
  constructor(private readonly db: Client) {}

  async submit(actor: VerifiedFeedbackActor | null, input: unknown): Promise<FeedbackResult<FeedbackReceipt>> {
    if (!hasFeedbackScope(actor)) return { ok: false, errorCode: "forbidden" }

    const submission = parseSubmission(input)
    if (!submission) return { ok: false, errorCode: "invalid_input" }
    const { submissionId, content } = submission
    const { category, message, appVersion, routeFamily } = content
    const payload = JSON.stringify(content)
    const digest = createHash("sha256").update(payload).digest("hex")
    const reservedBytes = Buffer.byteLength(payload) + MAX_FEEDBACK_DISPOSITION_BYTES

    // The quota check and upsert share one write statement. A retry returns
    // its stored receipt without changing the report, even at capacity.
    const result = await retryBusyWrite(() => this.db.execute({
      sql: `INSERT INTO feedback_reports (
        id, installation_id, submitter_id, submission_id, digest, reserved_bytes,
        category, message, app_version, route_family, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM (
        SELECT count(*) AS reports, coalesce(sum(reserved_bytes), 0) AS bytes,
          max(submitter_id = ? AND submission_id = ?) AS existing
        FROM feedback_reports WHERE installation_id = ?
      )
      WHERE existing = 1 OR (reports < ? AND bytes <= ?)
      ON CONFLICT(installation_id, submitter_id, submission_id)
        DO UPDATE SET digest = feedback_reports.digest
      RETURNING id, created_at, digest`,
      args: [
        randomUUID(), actor.installationId, actor.actorId, submissionId, digest, reservedBytes,
        category, message, appVersion, routeFamily, Date.now(),
        actor.actorId, submissionId, actor.installationId,
        MAX_FEEDBACK_REPORTS, MAX_FEEDBACK_RESERVED_BYTES - reservedBytes,
      ],
    }))

    const row = result.rows[0]
    if (!row) return { ok: false, errorCode: "queue_full" }
    if (row.digest !== digest) return { ok: false, errorCode: "conflict" }
    return { ok: true, value: toReceipt(row) }
  }

  async get(actor: VerifiedFeedbackActor | null, id: string): Promise<FeedbackResult<FeedbackReport>> {
    if (!isAdmin(actor)) return { ok: false, errorCode: "forbidden" }
    if (!isReportId(id)) return { ok: false, errorCode: "invalid_input" }

    const result = await this.db.execute({
      sql: `SELECT ${REPORT_FIELDS} FROM feedback_reports WHERE installation_id = ? AND id = ?`,
      args: [actor.installationId, id.toLowerCase()],
    })
    const row = result.rows[0]
    return row ? { ok: true, value: toReport(row) } : { ok: false, errorCode: "not_found" }
  }

  async list(actor: VerifiedFeedbackActor | null, options: {
    state?: FeedbackState
    cursor?: FeedbackCursor
  } = {}): Promise<FeedbackResult<{ reports: FeedbackReport[], nextCursor: FeedbackCursor | null }>> {
    if (!isAdmin(actor)) return { ok: false, errorCode: "forbidden" }
    const { state, cursor } = options
    if ((state !== undefined && !isAllowed(STATES, state))
      || (cursor && (!Number.isSafeInteger(cursor.receivedAt) || cursor.receivedAt < 0 || !isReportId(cursor.id)))) {
      return { ok: false, errorCode: "invalid_input" }
    }

    const result = await this.db.execute({
      sql: `SELECT ${REPORT_FIELDS} FROM feedback_reports
        WHERE installation_id = ?
        ${state ? "AND state = ?" : ""}
        ${cursor ? "AND (created_at, id) < (?, ?)" : ""}
        ORDER BY created_at DESC, id DESC LIMIT ?`,
      args: [
        actor.installationId,
        ...(state ? [state] : []),
        ...(cursor ? [cursor.receivedAt, cursor.id.toLowerCase()] : []),
        FEEDBACK_PAGE_SIZE + 1,
      ],
    })
    const reports = result.rows.slice(0, FEEDBACK_PAGE_SIZE).map(toReport)
    const last = reports.at(-1)
    const nextCursor = result.rows.length > FEEDBACK_PAGE_SIZE && last
      ? { receivedAt: last.receivedAt, id: last.id }
      : null
    return { ok: true, value: { reports, nextCursor } }
  }

  async review(actor: VerifiedFeedbackActor | null, id: string, state: Exclude<FeedbackState, "open">,
    disposition?: unknown): Promise<FeedbackResult<FeedbackReport>> {
    if (!isAdmin(actor)) return { ok: false, errorCode: "forbidden" }
    if (!isReportId(id) || !isAllowed(REVIEW_STATES, state)) {
      return { ok: false, errorCode: "invalid_input" }
    }
    const claim = state === "in_progress"
    const note = claim ? null : plainText(disposition, MAX_FEEDBACK_DISPOSITION_BYTES)
    if (claim ? disposition !== undefined : !note) return { ok: false, errorCode: "invalid_input" }

    const result = await retryBusyWrite(() => this.db.execute({
      sql: `UPDATE feedback_reports SET state = ?, ${claim ? "claimed_by = ?" : "closed_by = ?"},
        disposition = ? WHERE installation_id = ? AND id = ? AND state = ?
        RETURNING ${REPORT_FIELDS}`,
      args: [state, actor.actorId, note, actor.installationId, id.toLowerCase(), claim ? "open" : "in_progress"],
    }))
    const row = result.rows[0]
    if (row) return { ok: true, value: toReport(row) }
    const existing = await this.get(actor, id)
    return existing.ok ? { ok: false, errorCode: "conflict" } : existing
  }

  async deleteClosed(actor: VerifiedFeedbackActor | null, id: string): Promise<FeedbackResult<null>> {
    if (!isAdmin(actor)) return { ok: false, errorCode: "forbidden" }
    if (!isReportId(id)) return { ok: false, errorCode: "invalid_input" }

    const result = await retryBusyWrite(() => this.db.execute({
      sql: `DELETE FROM feedback_reports
        WHERE installation_id = ? AND id = ? AND state IN ('resolved', 'declined')`,
      args: [actor.installationId, id.toLowerCase()],
    }))
    if (result.rowsAffected === 1) return { ok: true, value: null }
    const existing = await this.get(actor, id)
    return existing.ok ? { ok: false, errorCode: "conflict" } : existing
  }

  async prepareExport(actor: VerifiedFeedbackActor | null, id: string,
    reviewedMessage: unknown): Promise<FeedbackResult<FeedbackContent>> {
    if (!isAdmin(actor)) return { ok: false, errorCode: "forbidden" }
    const message = plainText(reviewedMessage, MAX_FEEDBACK_MESSAGE_BYTES)
    if (!message) return { ok: false, errorCode: "invalid_input" }
    const report = await this.get(actor, id)
    if (!report.ok) return report

    const { category, appVersion, routeFamily } = report.value
    return { ok: true, value: { category, message, appVersion, routeFamily } }
  }
}
