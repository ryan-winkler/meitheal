import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { normalizeStatus, STATUS } from "../../../lib/status-config"
import { boardGrantStillCurrent, changeBoardGrants, currentBoardGrantRevision, readBoardGrantRevision } from "./board-grant-fence"
import { selectNamedBoardAccess, type BoardActor } from "./named-board-repository"
import { insertNamedTask } from "./named-board-task-repository"

const permitDuration = 24 * 60 * 60 * 1_000
const maxOpenPermits = 20
const maxSubmissions = 60
const unavailable = { ok: false, errorCode: "unavailable" } as const
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

interface Submission {
  title: string
  description: string
  assignToRecipient: boolean
}

export class BoardIntakeRepository {
  constructor(private readonly db: Client, private readonly markerPath?: string) {}

  async findDestinations(actor: BoardActor) {
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
      args: [actor.kind, actor.id, revision],
    })
    if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return []
    return rows.filter(row => triageStatus(String(row.key))).map(row => ({
      id: String(row.id), label: String(row.label), acceptsAssignment: typeof row.recipient === "string",
    }))
  }

  /** Configure an audience that can send work without reading the Board. */
  async create(ownerId: string, boardId: string, input: {
    label: string; laneId: string; senders: readonly BoardActor[]; recipientUserId?: string
  }) {
    return changeBoardGrants(this.db, async (tx, revision) => {
      if (!revision) return { unchanged: null }
      const owner = await selectNamedBoardAccess(tx, { kind: "ha_user", id: ownerId }, revision, boardId)
      if (!owner || owner.role !== "owner" || owner.state !== "active") return { unchanged: null }
      const { rows: [lane] } = await tx.execute({
        sql: "SELECT key FROM kanban_lanes WHERE id = ? AND board_id = ?", args: [input.laneId, boardId],
      })
      if (!lane || !triageStatus(String(lane.key))) return { unchanged: null }
      const id = randomUUID()
      await tx.execute({
        sql: "INSERT INTO board_intakes (id, board_id, lane_id, label, recipient_user_id) VALUES (?, ?, ?, ?, ?)",
        args: [id, boardId, input.laneId, input.label, input.recipientUserId ?? null],
      })
      for (const sender of input.senders) {
        await tx.execute({
          sql: "INSERT OR IGNORE INTO board_intake_senders (intake_id, sender_kind, sender_id) VALUES (?, ?, ?)",
          args: [id, sender.kind, sender.id],
        })
      }
      return { next: { id } }
    }, this.markerPath)
  }

  async setEnabled(ownerId: string, boardId: string, intakeId: string, enabled: boolean) {
    return changeBoardGrants(this.db, async (tx, revision) => {
      if (!revision) return { unchanged: false }
      const owner = await selectNamedBoardAccess(tx, { kind: "ha_user", id: ownerId }, revision, boardId)
      if (owner?.role !== "owner") return { unchanged: false }
      const result = await tx.execute({
        sql: "UPDATE board_intakes SET enabled = ? WHERE id = ? AND board_id = ? AND enabled IS NOT ?",
        args: [enabled, intakeId, boardId, enabled],
      })
      return result.rowsAffected ? { next: true } : { unchanged: false }
    }, this.markerPath)
  }

  /** Only the sender-bound token and its own expiry leave the repository. */
  async issue(sender: BoardActor, intakeId: string, now = Date.now()) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return unavailable

    const tx = await acquireWriteTransaction(this.db)
    try {
      if (!await this.eligibleIntake(tx, sender, intakeId, revision)) return unavailable
      await tx.execute({
        sql: "DELETE FROM board_intake_requests WHERE expires_at <= ? AND (accepted_at IS NULL OR accepted_at <= ?)",
        args: [now, now - permitDuration],
      })
      const { rows: [counts] } = await tx.execute({
        sql: `SELECT COUNT(*) FILTER (WHERE acknowledgement IS NULL) AS outstanding,
              COUNT(*) FILTER (WHERE accepted_at > ?) AS submitted
            FROM board_intake_requests WHERE sender_kind = ? AND sender_id = ?`,
        args: [now - permitDuration, sender.kind, sender.id],
      })
      if (Number(counts?.outstanding) >= maxOpenPermits || Number(counts?.submitted) >= maxSubmissions) {
        return { ok: false, errorCode: "quota" } as const
      }
      const token = randomBytes(32).toString("base64url")
      const expiresAt = now + permitDuration
      await tx.execute({
        sql: "INSERT INTO board_intake_requests(digest, intake_id, sender_kind, sender_id, expires_at) VALUES (?, ?, ?, ?, ?)",
        args: [digest(token), intakeId, sender.kind, sender.id, expiresAt],
      })
      if (await readBoardGrantRevision(this.markerPath) !== revision) return unavailable
      await tx.commit()
      return { ok: true, value: { token, expiresAt } } as const
    } finally {
      tx.close()
    }
  }

  /** The route revalidates the current sender and the opted-in recipient against Home Assistant. */
  async submit(sender: BoardActor, token: string, content: Submission, activeUsers: readonly string[], now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return unavailable
    const tokenDigest = digest(token)
    const fingerprint = digest(JSON.stringify([content.title, content.description, content.assignToRecipient]))
    const tx = await acquireWriteTransaction(this.db)
    try {
      const { rows: [saved] } = await tx.execute({
        sql: `SELECT intake_id, acknowledgement, submitted_digest FROM board_intake_requests
          WHERE digest = ? AND sender_kind = ? AND sender_id = ? AND expires_at > ?`,
        args: [tokenDigest, sender.kind, sender.id, now],
      })
      if (!saved) return unavailable
      if (typeof saved.acknowledgement === "string") {
        return saved.submitted_digest === fingerprint
          ? { ok: true, value: { acknowledgement: saved.acknowledgement } } as const
          : { ok: false, errorCode: "conflict" } as const
      }

      const revision = await readBoardGrantRevision(this.markerPath)
      if (!revision) return unavailable
      const intake = await this.eligibleIntake(tx, sender, String(saved.intake_id), revision)
      if (!intake) return unavailable

      const { rows: [recent] } = await tx.execute({
        sql: "SELECT COUNT(*) AS accepted FROM board_intake_requests WHERE sender_kind = ? AND sender_id = ? AND accepted_at > ?",
        args: [sender.kind, sender.id, now - permitDuration],
      })
      if (Number(recent?.accepted) >= maxSubmissions) return { ok: false, errorCode: "quota" } as const

      let assignedTo: string | undefined
      if (content.assignToRecipient && typeof intake.recipient_user_id === "string" && activeUsers.includes(intake.recipient_user_id)) {
        const access = await selectNamedBoardAccess(tx, { kind: "ha_user", id: intake.recipient_user_id }, revision, intake.boardId)
        if (access) assignedTo = "ha_" + intake.recipient_user_id
      }
      const task = await insertNamedTask(tx, {
        boardId: intake.boardId, laneId: intake.laneId, status: intake.status, content,
        ...(assignedTo ? { assignedTo } : {}),
      })
      if (!task) return unavailable
      const acknowledgement = randomUUID()
      await tx.execute({
        sql: "UPDATE board_intake_requests SET task_id = ?, acknowledgement = ?, submitted_digest = ?, accepted_at = ? WHERE digest = ?",
        args: [task.id, acknowledgement, fingerprint, now, tokenDigest],
      })
      if (await readBoardGrantRevision(this.markerPath) !== revision) return unavailable
      await tx.commit()
      return { ok: true, value: { acknowledgement } } as const
    } finally {
      tx.close()
    }
  }

  private async eligibleIntake(tx: Transaction, sender: BoardActor, id: string, revision: string) {
    const { rows: [intake] } = await tx.execute({
      sql: `SELECT intake.board_id, intake.lane_id, intake.recipient_user_id, lane.key
        FROM board_intakes AS intake
        JOIN board_intake_senders AS access ON access.intake_id = intake.id
        JOIN task_boards AS board ON board.id = intake.board_id AND board.state = 'active' AND board.id <> 'household'
        JOIN board_permissions AS policy ON policy.board_id = board.id
        JOIN kanban_lanes AS lane ON lane.id = intake.lane_id AND lane.board_id = board.id
        WHERE intake.id = ? AND intake.enabled = 1 AND access.sender_kind = ? AND access.sender_id = ?
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)`,
      args: [id, sender.kind, sender.id, revision],
    })
    if (!intake) return null
    const status = triageStatus(String(intake.key))
    return status ? { boardId: String(intake.board_id), laneId: String(intake.lane_id), recipient_user_id: intake.recipient_user_id, status } : null
  }
}

function triageStatus(key: string) {
  const status = normalizeStatus(key)
  return status === STATUS.PENDING || status === STATUS.ACTIVE || status === STATUS.BACKLOG ? status : null
}
