import { STATUS_CONFIG } from "../../../lib/status-config"
import { randomInt, randomUUID } from "node:crypto"
import { BoardAccessService } from "../board-access-service"
import { agentBoardOperations } from "../agent-board-authority"
import {
  principalProof,
  scopeBoardAccess,
  type VerifiedPrincipal,
  type BoardAccessView
} from "../board-scope"
import type { Client, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { getBoardGrantPath } from "../../../../scripts/board-grant-journal.mjs"
import {
  boardGrantStillCurrent,
  changeBoardGrants,
  currentBoardGrantRevision,
  readBoardGrantRevision
} from "./board-grant-fence"
import {
  NAMED_BOARD_PRESETS,
  isNamedBoardPreset,
  type NamedBoardPreset
} from "../named-board-presets"

export type BoardActor = { kind: VerifiedPrincipal["kind"]; id: string }
export type BoardRole = "owner" | "member" | "viewer" | "service"
export type TaskBoardAction =
  | "read"
  | "create"
  | "edit"
  | "move"
  | "assign"
  | "complete"
  | "reopen"
  | "delete"
  | "archive"
  | "restore"
  | "purge"
  | "transfer"

type BoardAccess = BoardAccessView

const base32Symbols = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function boardTicketPrefix() {
  let prefix = ""
  for (let index = 0; index < 8; index++) {
    prefix += base32Symbols[randomInt(base32Symbols.length)]
  }
  return prefix
}

export function permitsBoardTaskAction(access: BoardAccess, action: TaskBoardAction): boolean {
  if (action === "read") return true
  if (access.state !== "active" || access.role === "viewer") return false
  if (action === "complete" || action === "reopen") return !access.denyCompletion
  if (action === "delete") return !access.denyDeletion
  if (action === "archive" || action === "restore" || action === "purge") {
    return access.role === "owner" && !access.denyDeletion
  }
  if (action === "transfer") return access.role === "owner"
  return true
}

/** Use within the same transaction as a protected effect or projection. */
export async function selectNamedBoardAccess(
  db: Pick<Client, "execute">,
  actor: BoardActor,
  revision: string,
  id: string
): Promise<BoardAccess | null> {
  const result = await new BoardAccessService(db as Client).resolveInTransaction(
    actor as VerifiedPrincipal,
    id,
    { resource: "board", action: "read" },
    db,
    revision
  )
  return result.ok ? scopeBoardAccess(result.scope) : null
}

export class NamedBoardRepository {
  constructor(
    private readonly db: Client,
    private readonly markerPath = getBoardGrantPath(db)
  ) {}

  /** Read a scope without inheriting permissions from Home Assistant administration. */
  async findAccess(actor: BoardActor, id: string) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const access = await selectNamedBoardAccess(this.db, actor, revision, id)
    return (await boardGrantStillCurrent(this.db, revision, this.markerPath)) &&
      principalProof(actor as VerifiedPrincipal)
      ? access
      : null
  }

  async findDirectory(actor: BoardActor) {
    if (!principalProof(actor as VerifiedPrincipal)) return []
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const { rows } = await this.db.execute(
      "SELECT id FROM task_boards WHERE state IN ('active', 'archived') ORDER BY name COLLATE NOCASE, id"
    )
    const directory = []
    for (const row of rows) {
      const access = await this.findAccess(actor, String(row.id))
      if (!access) continue
      const { rows: preference } = await this.db.execute({
        sql: "SELECT 1 FROM board_sidebar_preferences WHERE board_id = ? AND ha_user_id = ?",
        args: [access.id, actor.id]
      })
      directory.push({ ...access, hidden: preference.length > 0 })
    }
    return (await boardGrantStillCurrent(this.db, revision, this.markerPath)) &&
      principalProof(actor as VerifiedPrincipal)
      ? directory
      : []
  }

  /** The caller verifies that the creator is the current active Home Assistant user. */
  async create(owner: VerifiedPrincipal, name: string, preset?: NamedBoardPreset) {
    if (preset !== undefined && !isNamedBoardPreset(preset))
      throw new Error("Choose an available Board preset.")
    const labels = preset === undefined ? undefined : NAMED_BOARD_PRESETS[preset]
    if (!["ha_user", "local_operator"].includes(owner.kind) || !principalProof(owner))
      return { status: "locked" } as const
    const boardId = randomUUID()
    return changeBoardGrants(
      this.db,
      owner,
      async (tx) => {
        if (!principalProof(owner)) throw new Error("Current Board creator proof expired")
        const now = Date.now()
        await tx.batch([
          {
            sql: `INSERT INTO task_boards
            (id, name, visibility, ticket_prefix, created_at, updated_at)
            VALUES (?, ?, 'restricted', ?, ?, ?)`,
            args: [boardId, name, boardTicketPrefix(), now, now]
          },
          {
            sql: "INSERT INTO board_permissions (board_id) VALUES (?)",
            args: [boardId]
          },
          {
            sql: `INSERT INTO board_access_grants (board_id, principal_type, principal_id, role)
            VALUES (?, ?, ?, 'owner')`,
            args: [boardId, owner.kind, owner.id]
          },
          ...STATUS_CONFIG.map((status, position) => ({
            sql: `INSERT INTO kanban_lanes
            (id, key, label, position, includes, built_in, created_at, updated_at, board_id)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            args: [
              randomUUID(),
              status.defaultLane,
              labels?.[position] ?? status.label,
              position,
              JSON.stringify([status.canonical]),
              now,
              now,
              boardId
            ]
          }))
        ])
        return { next: { id: boardId } }
      },
      this.markerPath
    )
  }

  async findDeleted(actor: BoardActor) {
    if (
      !["ha_user", "local_operator"].includes(actor.kind) ||
      !principalProof(actor as VerifiedPrincipal)
    )
      return []
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const { rows } = await this.db.execute(
      "SELECT id FROM task_boards WHERE state='retired' ORDER BY name COLLATE NOCASE,id"
    )
    const result = []
    for (const row of rows) {
      const access = await new BoardAccessService(this.db).resolve(
        actor as VerifiedPrincipal,
        String(row.id),
        { resource: "board", action: "restore" }
      )
      if (access.ok) {
        const board = scopeBoardAccess(access.scope)
        result.push({ id: board.id, name: board.name, revision: board.revision })
      }
    }
    return (await boardGrantStillCurrent(this.db, revision, this.markerPath)) &&
      principalProof(actor as VerifiedPrincipal)
      ? result
      : []
  }

  async rename(actor: VerifiedPrincipal, id: string, name: string, expected: number) {
    return changeBoardGrants(
      this.db,
      actor,
      async (tx, epoch) => {
        const owner = await this.getOwner(tx, actor, id, epoch)
        if (!owner) return { unchanged: "unavailable" as const }
        if (owner.revision !== expected) return { unchanged: "stale" as const }
        if (owner.name === name) return { unchanged: "saved" as const }
        await tx.execute({
          sql: "UPDATE task_boards SET name = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
          args: [name, Date.now(), id]
        })
        return { next: "saved" as const }
      },
      this.markerPath
    )
  }

  async updateSharing(
    actor: VerifiedPrincipal,
    id: string,
    value: {
      visibility: "shared" | "restricted"
      sharedRole: "member" | "viewer"
      sharedAdminManagement: boolean
    },
    expected: number,
    activeUsers: readonly string[]
  ) {
    return changeBoardGrants(
      this.db,
      actor,
      async (tx, epoch) => {
        const owner = await this.getOwner(tx, actor, id, epoch)
        if (!owner) return { unchanged: "unavailable" as const }
        if (owner.revision !== expected) return { unchanged: "stale" as const }
        if (value.visibility === "restricted" || !value.sharedAdminManagement) {
          const { rows } = await tx.execute({
            sql: `SELECT 1 FROM board_access_grants WHERE board_id = ? AND role = 'owner'
            AND ((principal_type = 'ha_user' AND principal_id IN (SELECT value FROM json_each(?)))
              OR (principal_type = 'local_operator' AND principal_id = ?)) LIMIT 1`,
            args: [id, JSON.stringify(activeUsers), actor.kind === "local_operator" ? actor.id : ""]
          })
          if (!rows.length) return { unchanged: "last-owner" as const }
        }
        await tx.batch([
          {
            sql: "UPDATE task_boards SET visibility = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
            args: [value.visibility, Date.now(), id]
          },
          {
            sql: "UPDATE board_permissions SET shared_role = ?, shared_admin_management = ? WHERE board_id = ?",
            args: [value.sharedRole, value.sharedAdminManagement, id]
          }
        ])
        return { next: "saved" as const }
      },
      this.markerPath
    )
  }

  async changeLifecycle(
    actor: BoardActor,
    id: string,
    state: "active" | "retired",
    revision: number,
    _legacyAdmin = false
  ) {
    if (!["ha_user", "local_operator"].includes(actor.kind))
      return { status: "unchanged", result: "unavailable" } as const
    return changeBoardGrants(
      this.db,
      actor as VerifiedPrincipal,
      async (tx, epoch) => {
        if (!epoch) return { unchanged: "unavailable" as const }
        const access = await new BoardAccessService(this.db).resolveInTransaction(
          actor as VerifiedPrincipal,
          id,
          { resource: "board", action: state === "retired" ? "retire" : "restore" },
          tx,
          epoch
        )
        if (!access.ok) return { unchanged: "unavailable" as const }
        const {
          rows: [board]
        } = await tx.execute({
          sql: "SELECT state, revision FROM task_boards WHERE id = ?",
          args: [id]
        })
        if (!board) return { unchanged: "unavailable" as const }
        if (board.state === state) return { unchanged: "saved" as const }
        if (Number(board.revision) !== revision) return { unchanged: "stale" as const }
        await tx.execute({
          sql: "UPDATE task_boards SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
          args: [state, Date.now(), id]
        })
        return { next: "saved" as const }
      },
      this.markerPath
    )
  }

  async updateRestrictions(
    ownerId: VerifiedPrincipal,
    id: string,
    policy: {
      denyCompletion: boolean
      denyDeletion: boolean
      denyAgentDeletion: boolean
    }
  ) {
    return changeBoardGrants(
      this.db,
      ownerId,
      async (tx, revision) => {
        const owner = await this.getOwner(tx, ownerId, id, revision)
        if (!owner) return { unchanged: false }
        const outcome = await tx.execute({
          sql: `UPDATE board_permissions SET deny_completion = ?, deny_deletion = ?, deny_agent_deletion = ?
          WHERE board_id = ? AND (deny_completion, deny_deletion, deny_agent_deletion) IS NOT (?, ?, ?)`,
          args: [
            policy.denyCompletion,
            policy.denyDeletion,
            policy.denyAgentDeletion,
            id,
            policy.denyCompletion,
            policy.denyDeletion,
            policy.denyAgentDeletion
          ]
        })
        return outcome.rowsAffected ? { next: true } : { unchanged: true }
      },
      this.markerPath
    )
  }

  async updateMember(
    ownerId: VerifiedPrincipal,
    id: string,
    memberId: string,
    next: {
      role: Exclude<BoardRole, "service">
      denyCompletion: boolean
      denyDeletion: boolean
    } | null,
    activeUsers: readonly string[]
  ) {
    return changeBoardGrants(
      this.db,
      ownerId,
      async (tx, revision) => {
        const owner = await this.getOwner(tx, ownerId, id, revision)
        if (!owner) return { unchanged: "unavailable" as const }
        if (next && !activeUsers.includes(memberId)) return { unchanged: "unavailable" as const }
        const {
          rows: [previous]
        } = await tx.execute({
          sql: `SELECT role FROM board_access_grants
          WHERE board_id = ? AND principal_type = 'ha_user' AND principal_id = ?`,
          args: [id, memberId]
        })
        if (previous?.role === "owner" && next?.role !== "owner") {
          const { rows: remaining } = await tx.execute({
            sql: `SELECT 1 FROM board_access_grants
            WHERE board_id = ? AND principal_type = 'ha_user' AND role = 'owner' AND principal_id <> ?
              AND principal_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
            args: [id, memberId, JSON.stringify(activeUsers)]
          })
          if (!remaining.length) return { unchanged: "last-owner" as const }
        }

        const outcome = next
          ? await tx.execute({
              sql: `INSERT INTO board_access_grants (board_id, principal_type, principal_id, role, deny_completion, deny_deletion)
          VALUES (?, 'ha_user', ?, ?, ?, ?)
          ON CONFLICT(board_id, principal_type, principal_id) DO UPDATE SET
            role = excluded.role, deny_completion = excluded.deny_completion, deny_deletion = excluded.deny_deletion
          WHERE (role, deny_completion, deny_deletion) IS NOT (excluded.role, excluded.deny_completion, excluded.deny_deletion)`,
              args: [id, memberId, next.role, next.denyCompletion, next.denyDeletion]
            })
          : await tx.execute({
              sql: `DELETE FROM board_access_grants WHERE board_id = ? AND principal_type = 'ha_user' AND principal_id = ?`,
              args: [id, memberId]
            })
        return outcome.rowsAffected ? { next: "saved" as const } : { unchanged: "saved" as const }
      },
      this.markerPath
    )
  }

  async updateAgent(
    ownerId: VerifiedPrincipal,
    boardId: string,
    tokenId: string,
    enabled: boolean
  ) {
    return changeBoardGrants(
      this.db,
      ownerId,
      async (tx, revision) => {
        const owner = await this.getOwner(tx, ownerId, boardId, revision)
        if (!owner || owner.state !== "active") return { unchanged: false }
        let limits: string | null = null
        if (enabled) {
          const {
            rows: [token]
          } = await tx.execute({
            sql: "SELECT scopes, assignee_id, expires_at FROM agent_tokens WHERE id = ? AND revoked = 0",
            args: [tokenId]
          })
          if (
            !token ||
            (token.expires_at !== null &&
              (!Number.isFinite(Date.parse(String(token.expires_at))) ||
                Date.parse(String(token.expires_at)) <= Date.now()))
          )
            return { unchanged: false }
          let scopes: string[]
          try {
            scopes = JSON.parse(String(token.scopes))
            if (!Array.isArray(scopes) || scopes.some((item) => typeof item !== "string"))
              return { unchanged: false }
          } catch {
            return { unchanged: false }
          }
          const assignedOnly =
            scopes.includes("tasks:write:assigned") && !scopes.includes("tasks:write")
          if (assignedOnly && typeof token.assignee_id !== "string") return { unchanged: false }
          if (assignedOnly) {
            const { rows } = await tx.execute({
              sql: "SELECT 1 FROM custom_users WHERE id=? AND kind='agent'",
              args: [String(token.assignee_id)]
            })
            if (!rows.length) return { unchanged: false }
          }
          limits = JSON.stringify({
            operations: agentBoardOperations(scopes),
            ...(assignedOnly ? { assignedTo: token.assignee_id } : {})
          })
        }
        const result = enabled
          ? await tx.execute({
              sql: `INSERT INTO board_access_grants (board_id, principal_type, principal_id, role, authority_limits)
          VALUES (?, 'agent', ?, 'service', ?)
          ON CONFLICT(board_id, principal_type, principal_id) DO UPDATE SET authority_limits = excluded.authority_limits`,
              args: [boardId, tokenId, limits]
            })
          : await tx.execute({
              sql: "DELETE FROM board_access_grants WHERE board_id = ? AND principal_type = 'agent' AND principal_id = ?",
              args: [boardId, tokenId]
            })
        return result.rowsAffected ? { next: true } : { unchanged: true }
      },
      this.markerPath
    )
  }

  async setSidebarHidden(actor: BoardActor, id: string, hidden: boolean): Promise<boolean> {
    if (!["ha_user", "local_operator"].includes(actor.kind)) return false
    const revision = await readBoardGrantRevision(this.markerPath)
    if (!revision) return false
    const tx = await acquireWriteTransaction(this.db)
    try {
      if (!(await selectNamedBoardAccess(tx, actor, revision, id))) return false
      if (hidden) {
        await tx.execute({
          sql: "INSERT OR IGNORE INTO board_sidebar_preferences (board_id, ha_user_id) VALUES (?, ?)",
          args: [id, actor.id]
        })
      } else {
        await tx.execute({
          sql: "DELETE FROM board_sidebar_preferences WHERE board_id = ? AND ha_user_id = ?",
          args: [id, actor.id]
        })
      }
      if ((await readBoardGrantRevision(this.markerPath)) !== revision) return false
      await tx.commit()
      return true
    } finally {
      tx.close()
    }
  }

  private async getOwner(
    tx: Transaction,
    ownerId: VerifiedPrincipal,
    boardId: string,
    revision: string | null
  ) {
    if (!revision) return null
    const access = await new BoardAccessService(this.db).resolveInTransaction(
      ownerId,
      boardId,
      { resource: "board", action: "manage" },
      tx,
      revision
    )
    return access.ok ? scopeBoardAccess(access.scope) : null
  }
}

export { NamedBoardRepository as BoardRepository }
