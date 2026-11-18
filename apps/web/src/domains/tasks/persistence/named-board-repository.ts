import { randomInt, randomUUID } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { isActiveAgentToken } from "@domains/auth"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { boardGrantStillCurrent, changeBoardGrants, currentBoardGrantRevision, readBoardGrantRevision } from "./board-grant-fence"

export type BoardActor = { kind: "ha_user" | "agent"; id: string }
export type BoardRole = "owner" | "member" | "viewer" | "service"
export type TaskBoardAction =
  | "read" | "create" | "edit" | "move" | "assign"
  | "complete" | "reopen" | "delete" | "archive" | "restore" | "purge" | "transfer"

interface BoardAccess {
  id: string
  name: string
  role: BoardRole
  state: "active" | "archived"
  revision?: number
  denyCompletion: boolean
  denyDeletion: boolean
  policy?: { denyCompletion: boolean; denyDeletion: boolean; denyAgentDeletion: boolean }
}

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
  id: string,
): Promise<BoardAccess | null> {
  const { rows: [row] } = await db.execute({
    sql: `SELECT board.id, board.name, board.state, board.revision, access.role,
        (policy.deny_completion OR access.deny_completion) AS deny_completion,
        (policy.deny_deletion OR access.deny_deletion OR
          (access.principal_type = 'agent' AND policy.deny_agent_deletion)) AS deny_deletion,
        policy.deny_completion AS board_deny_completion, policy.deny_deletion AS board_deny_deletion,
        policy.deny_agent_deletion AS board_deny_agent_deletion
      FROM task_boards AS board
      JOIN board_access_grants AS access ON access.board_id = board.id
      JOIN board_permissions AS policy ON policy.board_id = board.id
      WHERE board.id = ? AND board.id <> 'household' AND board.state IN ('active', 'archived')
        AND access.principal_type = ? AND access.principal_id = ?
        AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)`,
    args: [id, actor.kind, actor.id, revision],
  })
  if (!row) return null
  return {
    id: String(row.id), name: String(row.name), state: row.state as BoardAccess["state"],
    revision: Number(row.revision), role: row.role as BoardRole, denyCompletion: row.deny_completion === 1, denyDeletion: row.deny_deletion === 1,
    ...(row.role === "owner" ? { policy: {
      denyCompletion: row.board_deny_completion === 1, denyDeletion: row.board_deny_deletion === 1,
      denyAgentDeletion: row.board_deny_agent_deletion === 1,
    } } : {}),
  }
}

export async function readHouseholdBoardState(db: Pick<Client, "execute">): Promise<"active" | "retired"> {
  const { rows: [row] } = await db.execute("SELECT state FROM task_boards WHERE id = 'household'")
  return row?.state === "active" ? "active" : "retired"
}

export async function householdBoardIsActive(db: Pick<Client, "execute">): Promise<boolean> {
  return await readHouseholdBoardState(db) === "active"
}

export class NamedBoardRepository {
  constructor(private readonly db: Client, private readonly markerPath?: string) {}

  /** Read a scope without inheriting permissions from Home Assistant administration. */
  async findAccess(actor: BoardActor, id: string) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return null
    const access = await selectNamedBoardAccess(this.db, actor, revision, id)
    return await boardGrantStillCurrent(this.db, revision, this.markerPath) ? access : null
  }

  async findDirectory(actor: BoardActor) {
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const { rows } = await this.db.execute({
      sql: `SELECT board.id, board.name, board.state, board.revision, access.role,
          CASE WHEN preference.ha_user_id IS NULL THEN 0 ELSE 1 END AS hidden
        FROM task_boards AS board
        JOIN board_access_grants AS access ON access.board_id = board.id
        JOIN board_permissions AS policy ON policy.board_id = board.id
        LEFT JOIN board_sidebar_preferences AS preference ON preference.board_id = board.id
          AND access.principal_type = 'ha_user' AND preference.ha_user_id = access.principal_id
        WHERE board.id <> 'household' AND board.state IN ('active', 'archived')
          AND access.principal_type = ? AND access.principal_id = ?
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)
        ORDER BY board.name COLLATE NOCASE, board.id`,
      args: [actor.kind, actor.id, revision],
    })
    if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return []
    return rows.map(row => ({
      id: String(row.id), name: String(row.name), state: row.state as BoardAccess["state"],
      role: row.role as BoardRole, hidden: row.hidden === 1,
    }))
  }

  /** The caller verifies that the creator is the current active Home Assistant user. */
  async create(ownerId: string, name: string) {
    const boardId = randomUUID()
    return changeBoardGrants(this.db, async tx => {
      const now = Date.now()
      await tx.batch([
        {
          sql: `INSERT INTO task_boards
            (id, name, visibility, ticket_prefix, created_at, updated_at)
            VALUES (?, ?, 'restricted', ?, ?, ?)`,
          args: [boardId, name, boardTicketPrefix(), now, now],
        }, {
          sql: "INSERT INTO board_permissions (board_id) VALUES (?)",
          args: [boardId],
        }, {
          sql: `INSERT INTO board_access_grants (board_id, principal_type, principal_id, role)
            VALUES (?, 'ha_user', ?, 'owner')`,
          args: [boardId, ownerId],
        },
        ...(["pending", "active", "complete"] as const).map((key, position) => ({
          sql: `INSERT INTO kanban_lanes
            (id, key, label, position, includes, built_in, created_at, updated_at, board_id)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          args: [randomUUID(), key, ["To Do", "In Progress", "Done"][position]!, position,
            JSON.stringify([key]), now, now, boardId],
        })),
      ])
      return { next: { id: boardId } }
    }, this.markerPath)
  }

  async findDeleted(actor: BoardActor) {
    if (actor.kind !== "ha_user") return []
    const revision = await currentBoardGrantRevision(this.db, this.markerPath)
    if (!revision) return []
    const { rows } = await this.db.execute({
      sql: `SELECT board.id, board.name, board.revision FROM task_boards AS board
        JOIN board_access_grants AS access ON access.board_id = board.id
        JOIN board_permissions AS policy ON policy.board_id = board.id
        WHERE board.state = 'retired' AND board.id <> 'household'
          AND access.principal_type = 'ha_user' AND access.principal_id = ? AND access.role = 'owner'
          AND NOT access.deny_deletion AND NOT policy.deny_deletion
          AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)
        ORDER BY board.name COLLATE NOCASE, board.id`,
      args: [actor.id, revision],
    })
    if (!await boardGrantStillCurrent(this.db, revision, this.markerPath)) return []
    return rows.map(row => ({ id: String(row.id), name: String(row.name), revision: Number(row.revision) }))
  }

  async changeLifecycle(actor: BoardActor, id: string, state: "active" | "retired", revision: number, householdAdmin = false) {
    if (actor.kind !== "ha_user") return { status: "unchanged", result: "unavailable" } as const
    return changeBoardGrants(this.db, async (tx, epoch) => {
      if (id !== "household") {
        const { rows: [owner] } = await tx.execute({
          sql: `SELECT 1 FROM board_access_grants AS access JOIN board_permissions AS policy ON policy.board_id = access.board_id
            WHERE access.board_id = ? AND access.principal_type = 'ha_user' AND access.principal_id = ?
              AND access.role = 'owner' AND NOT access.deny_deletion AND NOT policy.deny_deletion
              AND EXISTS (SELECT 1 FROM board_access_epoch WHERE singleton = 1 AND revision = ?)`,
          args: [id, actor.id, epoch],
        })
        if (!owner) return { unchanged: "unavailable" as const }
      } else if (!householdAdmin) return { unchanged: "unavailable" as const }
      const { rows: [board] } = await tx.execute({ sql: "SELECT state, revision FROM task_boards WHERE id = ?", args: [id] })
      if (!board) return { unchanged: "unavailable" as const }
      if (board.state === state) return { unchanged: "saved" as const }
      if (Number(board.revision) !== revision) return { unchanged: "stale" as const }
      await tx.execute({ sql: "UPDATE task_boards SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ?", args: [state, Date.now(), id] })
      return { next: "saved" as const }
    }, this.markerPath, { keepUninitialized: id === "household" })
  }

  async updateRestrictions(ownerId: string, id: string, policy: {
    denyCompletion: boolean
    denyDeletion: boolean
    denyAgentDeletion: boolean
  }) {
    return changeBoardGrants(this.db, async (tx, revision) => {
      const owner = await this.getOwner(tx, ownerId, id, revision)
      if (!owner) return { unchanged: false }
      const outcome = await tx.execute({
        sql: `UPDATE board_permissions SET deny_completion = ?, deny_deletion = ?, deny_agent_deletion = ?
          WHERE board_id = ? AND (deny_completion, deny_deletion, deny_agent_deletion) IS NOT (?, ?, ?)`,
        args: [policy.denyCompletion, policy.denyDeletion, policy.denyAgentDeletion, id,
          policy.denyCompletion, policy.denyDeletion, policy.denyAgentDeletion],
      })
      return outcome.rowsAffected ? { next: true } : { unchanged: true }
    }, this.markerPath)
  }

  async updateMember(ownerId: string, id: string, memberId: string, next: {
    role: Exclude<BoardRole, "service">
    denyCompletion: boolean
    denyDeletion: boolean
  } | null, activeUsers: readonly string[]) {
    return changeBoardGrants(this.db, async (tx, revision) => {
      const owner = await this.getOwner(tx, ownerId, id, revision)
      if (!owner) return { unchanged: "unavailable" as const }
      if (next && !activeUsers.includes(memberId)) return { unchanged: "unavailable" as const }
      const { rows: [previous] } = await tx.execute({
        sql: `SELECT role FROM board_access_grants
          WHERE board_id = ? AND principal_type = 'ha_user' AND principal_id = ?`,
        args: [id, memberId],
      })
      if (previous?.role === "owner" && next?.role !== "owner") {
        const { rows: remaining } = await tx.execute({
          sql: `SELECT 1 FROM board_access_grants
            WHERE board_id = ? AND principal_type = 'ha_user' AND role = 'owner' AND principal_id <> ?
              AND principal_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
          args: [id, memberId, JSON.stringify(activeUsers)],
        })
        if (!remaining.length) return { unchanged: "last-owner" as const }
      }

      const outcome = next ? await tx.execute({
        sql: `INSERT INTO board_access_grants (board_id, principal_type, principal_id, role, deny_completion, deny_deletion)
          VALUES (?, 'ha_user', ?, ?, ?, ?)
          ON CONFLICT(board_id, principal_type, principal_id) DO UPDATE SET
            role = excluded.role, deny_completion = excluded.deny_completion, deny_deletion = excluded.deny_deletion
          WHERE (role, deny_completion, deny_deletion) IS NOT (excluded.role, excluded.deny_completion, excluded.deny_deletion)`,
        args: [id, memberId, next.role, next.denyCompletion, next.denyDeletion],
      }) : await tx.execute({
        sql: `DELETE FROM board_access_grants WHERE board_id = ? AND principal_type = 'ha_user' AND principal_id = ?`,
        args: [id, memberId],
      })
      return outcome.rowsAffected ? { next: "saved" as const } : { unchanged: "saved" as const }
    }, this.markerPath)
  }

  async updateAgent(ownerId: string, boardId: string, tokenId: string, enabled: boolean) {
    return changeBoardGrants(this.db, async (tx, revision) => {
      const owner = await this.getOwner(tx, ownerId, boardId, revision)
      if (!owner || owner.state !== "active") return { unchanged: false }
      if (enabled && !await isActiveAgentToken(tx, tokenId, "tasks:read")) return { unchanged: false }
      const result = enabled ? await tx.execute({
        sql: `INSERT OR IGNORE INTO board_access_grants (board_id, principal_type, principal_id, role)
          VALUES (?, 'agent', ?, 'service')`,
        args: [boardId, tokenId],
      }) : await tx.execute({
        sql: "DELETE FROM board_access_grants WHERE board_id = ? AND principal_type = 'agent' AND principal_id = ?",
        args: [boardId, tokenId],
      })
      return result.rowsAffected ? { next: true } : { unchanged: true }
    }, this.markerPath)
  }

  async setSidebarHidden(actor: BoardActor, id: string, hidden: boolean): Promise<boolean> {
    if (actor.kind !== "ha_user") return false
    const revision = await readBoardGrantRevision(this.markerPath)
    if (!revision) return false
    const tx = await acquireWriteTransaction(this.db)
    try {
      if (!await selectNamedBoardAccess(tx, actor, revision, id)) return false
      if (hidden) {
        await tx.execute({
          sql: "INSERT OR IGNORE INTO board_sidebar_preferences (board_id, ha_user_id) VALUES (?, ?)",
          args: [id, actor.id],
        })
      } else {
        await tx.execute({
          sql: "DELETE FROM board_sidebar_preferences WHERE board_id = ? AND ha_user_id = ?",
          args: [id, actor.id],
        })
      }
      if (await readBoardGrantRevision(this.markerPath) !== revision) return false
      await tx.commit()
      return true
    } finally {
      tx.close()
    }
  }

  private async getOwner(tx: Transaction, ownerId: string, boardId: string, revision: string | null) {
    if (!revision) return null
    const access = await selectNamedBoardAccess(tx, { kind: "ha_user", id: ownerId }, revision, boardId)
    return access?.role === "owner" ? access : null
  }
}
