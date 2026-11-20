import { BoardAccessService } from "../board-access-service"
import { resolveHAAssignmentProof } from "../assignment-proof"
import { isActiveAgentToken } from "@domains/auth"
import { resolveIntakeSubmissionScope } from "../intake-scope"
import {
  requireBoardScope,
  principalProof,
  validateBoardScope,
  scopeIntakeSubmission,
  type BoardScope,
  type VerifiedPrincipal
} from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { getBoardGrantPath } from "../../../../scripts/board-grant-journal.mjs"
import { normalizeStatus, STATUS } from "../../../lib/status-config"
import {
  boardGrantStillCurrent,
  changeBoardGrants,
  currentBoardGrantRevision,
  readBoardGrantRevision
} from "./board-grant-fence"
import { selectNamedBoardAccess, type BoardActor } from "./named-board-repository"
import { insertNamedTask } from "./named-board-task-repository"

const permitDuration = 24 * 60 * 60 * 1_000
const maxOpenPermits = 20
const maxSubmissions = 60
const unavailable = { ok: false, errorCode: "unavailable" } as const
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

type PermitResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; errorCode: "unavailable" | "quota" | "conflict" }

interface Submission {
  title: string
  description: string
  assignToRecipient: boolean
}

export class BoardIntakeRepository {
  private readonly principal: VerifiedPrincipal
  private readonly markerPath: string
  constructor(
    private readonly db: Client,
    context: BoardScope | VerifiedPrincipal,
    markerPath = getBoardGrantPath(db)
  ) {
    if ("boardId" in context) {
      requireBoardScope(context)
      this.principal = context.principal
    } else this.principal = context
    if (!principalProof(this.principal)) throw new Error("A verified intake principal is required")
    this.markerPath = markerPath
  }
  private matches(actor: BoardActor) {
    return (
      actor.kind === this.principal.kind &&
      actor.id === this.principal.id &&
      Boolean(principalProof(this.principal))
    )
  }
  private async senderActive(actor: BoardActor) {
    return (
      this.matches(actor) &&
      (this.principal.kind !== "agent" ||
        (await isActiveAgentToken(this.db, this.principal.tokenId, "tasks:write")))
    )
  }

  /** Own accepted receipts survive closure without supplying task authority. */
  private async acceptedReceiptAllowed(intakeId: string, revision: string): Promise<boolean> {
    const proof = principalProof(this.principal)
    if (!proof || !(await boardGrantStillCurrent(this.db, revision, this.markerPath))) return false
    const {
      rows: [intake]
    } = await this.db.execute({
      sql: "SELECT intake.board_id FROM board_intakes intake JOIN board_intake_senders sender ON sender.intake_id=intake.id WHERE intake.id=? AND sender.sender_kind=? AND sender.sender_id=?",
      args: [intakeId, this.principal.kind, this.principal.id]
    })
    if (!intake) return false
    const human = proof.ingressPrincipal
    if (human) {
      const { rows } = await this.db.execute({
        sql: "SELECT 1 FROM board_intake_senders WHERE intake_id=? AND sender_kind='ha_user' AND sender_id=?",
        args: [intakeId, human.id]
      })
      if (
        !rows.length &&
        !(
          await new BoardAccessService(this.db).resolveInTransaction(
            human,
            String(intake.board_id),
            { resource: "task", action: "read" },
            this.db,
            revision
          )
        ).ok
      )
        return false
    }
    return (
      Boolean(principalProof(this.principal)) &&
      (await boardGrantStillCurrent(this.db, revision, this.markerPath))
    )
  }

  async findDestinations(actor: BoardActor) {
    if (!(await this.senderActive(actor))) return []
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const { rows } = await this.db.execute({
      sql: `SELECT intake.id, intake.label, intake.recipient_user_id AS recipient, lane.key
        FROM board_intake_senders AS access
        JOIN board_intakes AS intake ON intake.id = access.intake_id AND intake.enabled = 1
        JOIN task_boards AS board ON board.id = intake.board_id AND board.state = 'active'
        JOIN board_permissions AS policy ON policy.board_id = board.id
        JOIN kanban_lanes AS lane ON lane.id = intake.lane_id AND lane.board_id = board.id
        WHERE access.sender_kind = ? AND access.sender_id = ?
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)
        ORDER BY intake.label COLLATE NOCASE, intake.id`,
      args: [actor.kind, actor.id, revision]
    })
    if (!(await boardGrantStillCurrent(this.db, revision, this.markerPath))) return []
    const result = []
    const admitted: BoardScope[] = []
    for (const row of rows) {
      if (!triageStatus(String(row.key))) continue
      const scope = await resolveIntakeSubmissionScope(this.db, this.principal, String(row.id))
      if (!scope.ok) continue
      admitted.push(scope.scope)
      result.push({
        id: String(row.id),
        label: String(row.label),
        acceptsAssignment: typeof row.recipient === "string"
      })
    }
    for (const scope of admitted)
      if (!(await validateBoardScope(scope, this.db, { resource: "task", action: "create" })).ok)
        return []
    return principalProof(this.principal) &&
      (await boardGrantStillCurrent(this.db, revision, this.markerPath))
      ? result
      : []
  }

  async findSubmissions(sender: BoardActor, now = Date.now()) {
    if (!(await this.senderActive(sender))) return []
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const { rows } = await this.db.execute({
      sql: `SELECT intake_id, resume_id, draft_title, acknowledgement FROM board_intake_requests
        WHERE sender_kind = ? AND sender_id = ? AND resume_id IS NOT NULL AND expires_at > ?
        ORDER BY expires_at DESC, resume_id`,
      args: [sender.kind, sender.id, now]
    })
    if (!(await boardGrantStillCurrent(this.db, revision, this.markerPath))) return []
    const result = []
    const admitted: BoardScope[] = []
    for (const row of rows) {
      if (typeof row.acknowledgement === "string") {
        if (!(await this.acceptedReceiptAllowed(String(row.intake_id), revision))) continue
      } else {
        const scope = await resolveIntakeSubmissionScope(
          this.db,
          this.principal,
          String(row.intake_id)
        )
        if (!scope.ok) continue
        admitted.push(scope.scope)
      }
      result.push({
        id: String(row.resume_id),
        title: String(row.draft_title),
        acknowledgement: typeof row.acknowledgement === "string" ? row.acknowledgement : null
      })
    }
    for (const scope of admitted)
      if (!(await validateBoardScope(scope, this.db, { resource: "task", action: "create" })).ok)
        return []
    return principalProof(this.principal) &&
      (await boardGrantStillCurrent(this.db, revision, this.markerPath))
      ? result
      : []
  }

  /** Internal fresh-Core preflight input, never part of the sender acknowledgement DTO. */
  async findSubmissionRecipient(
    sender: BoardActor,
    locator: { token?: string; resumeId?: string }
  ): Promise<string | null> {
    if (
      !(await this.senderActive(sender)) ||
      (locator.token !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(locator.token))
    )
      return null
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const {
      rows: [row]
    } = await this.db.execute({
      sql: `SELECT intake_id FROM board_intake_requests
      WHERE sender_kind = ? AND sender_id = ? AND expires_at > ? AND (digest = ? OR resume_id = ?)`,
      args: [
        sender.kind,
        sender.id,
        Date.now(),
        locator.token ? digest(locator.token) : null,
        locator.resumeId ?? null
      ]
    })
    if (!row) return null
    const result = await resolveIntakeSubmissionScope(
      this.db,
      this.principal,
      String(row.intake_id)
    )
    return result.ok && (await boardGrantStillCurrent(this.db, revision, this.markerPath))
      ? (scopeIntakeSubmission(result.scope)?.recipientUserId ?? null)
      : null
  }

  /** Configure an audience that can send work without reading the Board. */
  async create(
    ownerId: string,
    boardId: string,
    input: {
      label: string
      laneId: string
      senders: readonly BoardActor[]
      recipientUserId?: string
    }
  ) {
    if (ownerId !== this.principal.id) return { status: "unchanged", result: null } as const
    return changeBoardGrants(
      this.db,
      this.principal,
      async (tx, revision) => {
        if (!revision) return { unchanged: null }
        const owner = await selectNamedBoardAccess(tx, this.principal, revision, boardId)
        if (!owner || owner.role !== "owner" || owner.state !== "active") return { unchanged: null }
        const {
          rows: [lane]
        } = await tx.execute({
          sql: "SELECT key FROM kanban_lanes WHERE id = ? AND board_id = ?",
          args: [input.laneId, boardId]
        })
        if (!lane || !triageStatus(String(lane.key))) return { unchanged: null }
        const id = randomUUID()
        await tx.execute({
          sql: "INSERT INTO board_intakes (id, board_id, lane_id, label, recipient_user_id) VALUES (?, ?, ?, ?, ?)",
          args: [id, boardId, input.laneId, input.label, input.recipientUserId ?? null]
        })
        for (const sender of input.senders) {
          await tx.execute({
            sql: "INSERT OR IGNORE INTO board_intake_senders (intake_id, sender_kind, sender_id) VALUES (?, ?, ?)",
            args: [id, sender.kind, sender.id]
          })
        }
        return { next: { id } }
      },
      this.markerPath
    )
  }

  async setEnabled(ownerId: string, boardId: string, intakeId: string, enabled: boolean) {
    if (ownerId !== this.principal.id) return { status: "unchanged", result: false } as const
    return changeBoardGrants(
      this.db,
      this.principal,
      async (tx, revision) => {
        if (!revision) return { unchanged: false }
        const owner = await selectNamedBoardAccess(tx, this.principal, revision, boardId)
        if (owner?.role !== "owner") return { unchanged: false }
        const result = await tx.execute({
          sql: "UPDATE board_intakes SET enabled = ? WHERE id = ? AND board_id = ? AND enabled IS NOT ?",
          args: [enabled, intakeId, boardId, enabled]
        })
        return result.rowsAffected ? { next: true } : { unchanged: false }
      },
      this.markerPath
    )
  }

  /** Only the sender-bound token and its own expiry leave the repository. */
  async issue(
    sender: BoardActor,
    intakeId: string,
    now?: number
  ): Promise<PermitResult<{ token: string; expiresAt: number }>>
  async issue(
    sender: BoardActor,
    intakeId: string,
    now: number,
    draft: Submission & { resumeId: string }
  ): Promise<PermitResult<{ resumeId: string; expiresAt: number }>>
  async issue(
    sender: BoardActor,
    intakeId: string,
    now = Date.now(),
    draft?: Submission & { resumeId: string }
  ) {
    if (!(await this.senderActive(sender))) return unavailable
    const resolved = await resolveIntakeSubmissionScope(this.db, this.principal, intakeId)
    if (!resolved.ok) return unavailable
    const tx = await boardOperationClient(this.db, resolved.scope, {
      resource: "task",
      action: "create"
    }).transaction("write")
    try {
      if (draft) {
        const {
          rows: [existing]
        } = await tx.execute({
          sql: `SELECT intake_id, expires_at, submitted_digest, draft_title, draft_description, draft_assign
            FROM board_intake_requests WHERE sender_kind = ? AND sender_id = ? AND resume_id = ?`,
          args: [sender.kind, sender.id, draft.resumeId]
        })
        if (existing) {
          if (Number(existing.expires_at) <= now) return unavailable
          const matches =
            existing.intake_id === intakeId &&
            (typeof existing.submitted_digest === "string"
              ? existing.submitted_digest === fingerprint(draft)
              : existing.draft_title === draft.title &&
                existing.draft_description === draft.description &&
                existing.draft_assign === Number(draft.assignToRecipient))
          return matches
            ? ({
                ok: true,
                value: { resumeId: draft.resumeId, expiresAt: Number(existing.expires_at) }
              } as const)
            : ({ ok: false, errorCode: "conflict" } as const)
        }
      }
      const revision = await readBoardGrantRevision(this.markerPath)
      if (!revision || !(await this.eligibleIntake(tx, sender, intakeId, revision)))
        return unavailable
      await tx.execute({
        sql: "DELETE FROM board_intake_requests WHERE sender_kind = ? AND sender_id = ? AND expires_at <= ? AND (accepted_at IS NULL OR accepted_at <= ?)",
        args: [sender.kind, sender.id, now, now - permitDuration]
      })
      const {
        rows: [counts]
      } = await tx.execute({
        sql: `SELECT COUNT(*) FILTER (WHERE acknowledgement IS NULL) AS outstanding,
              COUNT(*) FILTER (WHERE accepted_at > ?) AS submitted
            FROM board_intake_requests WHERE sender_kind = ? AND sender_id = ?`,
        args: [now - permitDuration, sender.kind, sender.id]
      })
      if (
        Number(counts?.outstanding) >= maxOpenPermits ||
        Number(counts?.submitted) >= maxSubmissions
      ) {
        return { ok: false, errorCode: "quota" } as const
      }
      const token = randomBytes(32).toString("base64url")
      const expiresAt = now + permitDuration
      await tx.execute({
        sql: `INSERT INTO board_intake_requests (
            digest, intake_id, sender_kind, sender_id, expires_at, resume_id, draft_title, draft_description, draft_assign
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          digest(token),
          intakeId,
          sender.kind,
          sender.id,
          expiresAt,
          draft?.resumeId ?? null,
          draft?.title ?? null,
          draft?.description ?? null,
          draft ? Number(draft.assignToRecipient) : null
        ]
      })
      if ((await readBoardGrantRevision(this.markerPath)) !== revision) return unavailable
      await tx.commit()
      return {
        ok: true,
        value: draft ? { resumeId: draft.resumeId, expiresAt } : { token, expiresAt }
      } as const
    } finally {
      tx.close()
    }
  }

  /** The route revalidates the current sender and the opted-in recipient against Home Assistant. */
  async submit(
    sender: BoardActor,
    token: string,
    content: Submission,
    activeUsers: readonly string[],
    now = Date.now()
  ) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return unavailable
    return this.deliver(sender, digest(token), undefined, content, activeUsers, now)
  }

  async retry(
    sender: BoardActor,
    resumeId: string,
    activeUsers: readonly string[],
    now = Date.now()
  ) {
    return this.deliver(sender, undefined, resumeId, undefined, activeUsers, now)
  }

  private async deliver(
    sender: BoardActor,
    tokenDigest: string | undefined,
    resumeId: string | undefined,
    submitted: Submission | undefined,
    activeUsers: readonly string[],
    now: number
  ) {
    if (!(await this.senderActive(sender))) return unavailable
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return unavailable
    const lookup = {
      sql: `SELECT digest, intake_id, acknowledgement, submitted_digest, draft_title, draft_description, draft_assign
      FROM board_intake_requests WHERE sender_kind = ? AND sender_id = ? AND expires_at > ? AND (digest = ? OR resume_id = ?)`,
      args: [sender.kind, sender.id, now, tokenDigest ?? null, resumeId ?? null]
    }
    const {
      rows: [candidate]
    } = await this.db.execute(lookup)
    if (!candidate || !(await boardGrantStillCurrent(this.db, revision, this.markerPath)))
      return unavailable
    if (typeof candidate.acknowledgement === "string") {
      if (!(await this.acceptedReceiptAllowed(String(candidate.intake_id), revision)))
        return unavailable
      return !submitted || candidate.submitted_digest === fingerprint(submitted)
        ? ({ ok: true, value: { acknowledgement: candidate.acknowledgement } } as const)
        : ({ ok: false, errorCode: "conflict" } as const)
    }
    const resolved = await resolveIntakeSubmissionScope(
      this.db,
      this.principal,
      String(candidate.intake_id)
    )
    if (!resolved.ok) return unavailable
    const scope = resolved.scope
    const destination = scopeIntakeSubmission(scope)
    if (!destination) return unavailable
    const assignRequested = submitted?.assignToRecipient ?? candidate.draft_assign === 1
    const assignmentProof =
      assignRequested && destination.recipientUserId
        ? await resolveHAAssignmentProof(scope, destination.recipientUserId)
        : undefined
    const tx = await boardOperationClient(this.db, scope, {
      resource: "task",
      action: "create"
    }).transaction("write")
    try {
      const {
        rows: [saved]
      } = await tx.execute(lookup)
      if (!saved || saved.intake_id !== candidate.intake_id) return unavailable
      if (typeof saved.acknowledgement === "string")
        return !submitted || saved.submitted_digest === fingerprint(submitted)
          ? ({ ok: true, value: { acknowledgement: saved.acknowledgement } } as const)
          : ({ ok: false, errorCode: "conflict" } as const)
      const content =
        submitted ??
        (typeof saved.draft_title === "string" && typeof saved.draft_description === "string"
          ? {
              title: saved.draft_title,
              description: saved.draft_description,
              assignToRecipient: saved.draft_assign === 1
            }
          : null)
      if (!content) return unavailable
      const {
        rows: [recent]
      } = await tx.execute({
        sql: "SELECT COUNT(*) AS accepted FROM board_intake_requests WHERE sender_kind = ? AND sender_id = ? AND accepted_at > ?",
        args: [sender.kind, sender.id, now - permitDuration]
      })
      if (Number(recent?.accepted) >= maxSubmissions)
        return { ok: false, errorCode: "quota" } as const
      let assignedTo: string | undefined
      if (content.assignToRecipient) {
        if (!destination.recipientUserId || !activeUsers.includes(destination.recipientUserId))
          return unavailable
        const {
          rows: [eligible]
        } = await tx.execute({
          sql: `SELECT 1 FROM task_boards WHERE id = ? AND state = 'active' AND
          (visibility = 'shared' OR EXISTS (SELECT 1 FROM board_access_grants WHERE board_id = task_boards.id AND principal_type = 'ha_user' AND principal_id = ?))`,
          args: [scope.boardId, destination.recipientUserId]
        })
        if (!eligible) return unavailable
        assignedTo = "ha_" + destination.recipientUserId
      }
      const task = await insertNamedTask(
        tx,
        {
          boardId: scope.boardId,
          laneId: destination.laneId,
          status: destination.status,
          content,
          assignmentProof,
          ...(assignedTo ? { assignedTo } : {})
        },
        scope,
        this.db
      )
      if (!task) return unavailable
      const acknowledgement = randomUUID()
      await tx.execute({
        sql: `UPDATE board_intake_requests SET task_id = ?, acknowledgement = ?, submitted_digest = ?, accepted_at = ?, draft_description = NULL, draft_assign = NULL WHERE digest = ?`,
        args: [task.id, acknowledgement, fingerprint(content), now, String(saved.digest)]
      })
      await tx.commit()
      return { ok: true, value: { acknowledgement } } as const
    } finally {
      tx.close()
    }
  }

  private async eligibleIntake(tx: Transaction, sender: BoardActor, id: string, revision: string) {
    const {
      rows: [intake]
    } = await tx.execute({
      sql: `SELECT intake.board_id, intake.lane_id, intake.recipient_user_id, lane.key
        FROM board_intakes AS intake
        JOIN board_intake_senders AS access ON access.intake_id = intake.id
        JOIN task_boards AS board ON board.id = intake.board_id AND board.state = 'active'
        JOIN board_permissions AS policy ON policy.board_id = board.id
        JOIN kanban_lanes AS lane ON lane.id = intake.lane_id AND lane.board_id = board.id
        WHERE intake.id = ? AND intake.enabled = 1 AND access.sender_kind = ? AND access.sender_id = ?
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)`,
      args: [id, sender.kind, sender.id, revision]
    })
    if (!intake) return null
    const status = triageStatus(String(intake.key))
    return status
      ? {
          boardId: String(intake.board_id),
          laneId: String(intake.lane_id),
          recipient_user_id: intake.recipient_user_id,
          status
        }
      : null
  }
}

function triageStatus(key: string) {
  const status = normalizeStatus(key)
  return status === STATUS.PENDING || status === STATUS.ACTIVE || status === STATUS.BACKLOG
    ? status
    : null
}

function fingerprint(content: Submission) {
  return digest(JSON.stringify([content.title, content.description, content.assignToRecipient]))
}
