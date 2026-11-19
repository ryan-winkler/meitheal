import { BoardAccessService } from "./board-access-service"
import { createHash } from "node:crypto"
import type { Client } from "@libsql/client"
import { normalizeStatus, STATUS } from "../../lib/status-config"
import { boardGrantStillCurrent, currentBoardGrantRevision } from "./persistence/board-grant-fence"
import {
  principalProof,
  limitBoardScope,
  registerBoardScope,
  type BoardScope,
  type ScopeResult,
  type VerifiedPrincipal,
  type WorkOperation
} from "./board-scope"

const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

async function selectIntake(
  db: Pick<Client, "execute">,
  principal: VerifiedPrincipal,
  intakeId: string,
  revision: string
) {
  if (!principalProof(principal) || !["ha_user", "agent"].includes(principal.kind)) return null
  if (principal.kind === "agent") {
    const {
      rows: [token]
    } = await db.execute({
      sql: `SELECT expires_at FROM agent_tokens WHERE id = ? AND revoked = 0
        AND EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(scopes) THEN scopes ELSE '[]' END) WHERE value = 'tasks:write')`,
      args: [principal.tokenId]
    })
    if (
      !token ||
      (token.expires_at !== null &&
        (!Number.isFinite(Date.parse(String(token.expires_at))) ||
          Date.parse(String(token.expires_at)) <= Date.now()))
    )
      return null
  }
  const {
    rows: [row]
  } = await db.execute({
    sql: `SELECT intake.id,intake.board_id,intake.lane_id,intake.recipient_user_id,lane.key,
        board.revision,board.storage_encoding
      FROM board_intakes AS intake JOIN board_intake_senders AS sender ON sender.intake_id=intake.id
      JOIN task_boards AS board ON board.id=intake.board_id AND board.state='active'
      JOIN board_permissions AS policy ON policy.board_id=board.id
      JOIN kanban_lanes AS lane ON lane.id=intake.lane_id AND lane.board_id=board.id
      WHERE intake.id=? AND intake.enabled=1 AND sender.sender_kind=? AND sender.sender_id=?
        AND EXISTS(SELECT 1 FROM board_access_epoch WHERE singleton=1 AND revision=?)`,
    args: [intakeId, principal.kind, principal.id, revision]
  })
  if (!row || !["legacy_null_v1", "scoped_v1"].includes(String(row.storage_encoding))) return null
  const status = normalizeStatus(String(row.key))
  if (![STATUS.PENDING, STATUS.ACTIVE, STATUS.BACKLOG].some((value) => value === status))
    return null
  return {
    boardId: String(row.board_id),
    boardRevision: Number(row.revision),
    storageEncoding: row.storage_encoding as "legacy_null_v1" | "scoped_v1",
    intakeId: String(row.id),
    laneId: String(row.lane_id),
    recipientUserId: typeof row.recipient_user_id === "string" ? row.recipient_user_id : null,
    status
  }
}

/** Existing owner-approved senders may submit without gaining membership or readable work. */
export async function resolveIntakeSubmissionScope(
  db: Client,
  principal: VerifiedPrincipal,
  intakeId: string
): Promise<ScopeResult> {
  if (!principalProof(principal)) return { ok: false, errorCode: "unavailable" }
  const revision = await currentBoardGrantRevision(db)
  if (!revision) return { ok: false, errorCode: "continuity_locked" }
  const destination = await selectIntake(db, principal, intakeId, revision)
  if (!destination) return { ok: false, errorCode: "unavailable" }
  const expected = fingerprint(destination)
  const operationAllowed = (operation: WorkOperation) =>
    operation.resource === "task" && operation.action === "create"
  const scope: BoardScope = registerBoardScope(
    {
      boardId: destination.boardId,
      principal,
      authorityRevision: revision,
      boardRevision: destination.boardRevision,
      capabilities: { operations: [{ resource: "task", action: "create" }] }
    },
    {
      storageEncoding: destination.storageEncoding,
      access: {
        id: destination.boardId,
        name: "",
        ticketPrefix: "",
        state: "active",
        revision: destination.boardRevision,
        role: "service",
        denyCompletion: true,
        denyDeletion: true
      },
      intakeSubmission: {
        intakeId: destination.intakeId,
        laneId: destination.laneId,
        recipientUserId: destination.recipientUserId,
        status: destination.status
      },
      validate: async (reader, operation) => {
        if (!operationAllowed(operation)) return { ok: false, errorCode: "denied" }
        if (!principalProof(principal) || !(await boardGrantStillCurrent(reader, revision)))
          return { ok: false, errorCode: "stale" }
        const current = await selectIntake(reader, principal, intakeId, revision)
        return current && fingerprint(current) === expected
          ? { ok: true, scope }
          : { ok: false, errorCode: "unavailable" }
      }
    }
  )
  const ingressPrincipal = principalProof(principal)?.ingressPrincipal
  let result = scope
  if (ingressPrincipal) {
    let limit = await new BoardAccessService(db).resolveInTransaction(
      ingressPrincipal,
      destination.boardId,
      { resource: "task", action: "create" },
      db,
      revision
    )
    // A current sender of this exact intake may still submit without Board membership.
    if (!limit.ok && (limit.errorCode === "unavailable" || limit.errorCode === "denied"))
      limit = await resolveIntakeSubmissionScope(db, ingressPrincipal, intakeId)
    if (!limit.ok) return limit
    if (limit.scope.authorityRevision !== revision) return { ok: false, errorCode: "stale" }
    result = limitBoardScope(scope, limit.scope)
  }
  return (await boardGrantStillCurrent(db, revision))
    ? { ok: true, scope: result }
    : { ok: false, errorCode: "stale" }
}
