import type { Client, Transaction } from "@libsql/client"
import { validateBoardScope, type BoardScope, type WorkOperation } from "./board-scope"
import { changeBoardGrants } from "./persistence/board-grant-fence"
import { BoardOperationError } from "./persistence/board-operation-client"

/** Snapshot a credential ceiling when a current Board manager explicitly approves it. */
export function agentBoardOperations(scopes: readonly string[]): WorkOperation[] {
  const operations: WorkOperation[] = []
  if (scopes.includes("tasks:read"))
    operations.push(
      { resource: "board", action: "read" },
      { resource: "task", action: "read" },
      { resource: "routine", action: "read" },
    )
  if (scopes.includes("search:read") || scopes.includes("tasks:read"))
    operations.push({ resource: "task", action: "search" })
  if (scopes.includes("tasks:write")) {
    operations.push(
      ...(["create", "edit", "move", "assign", "complete", "reopen"] as const).map((action) => ({
        resource: "task" as const,
        action
      })),
      { resource: "routine", action: "create" },
      { resource: "routine", action: "edit" },
    )
  } else if (scopes.includes("tasks:write:assigned")) {
    operations.push(
      ...(["edit", "move", "assign", "complete", "reopen"] as const).map((action) => ({
        resource: "task" as const,
        action
      }))
    )
  }
  if (scopes.includes("tasks:delete")) {
    operations.push({ resource: "task", action: "delete" }, { resource: "routine", action: "delete" })
  }
  if (scopes.includes("tasks:propose")) operations.push({ resource: "task", action: "propose" })
  if (scopes.includes("projects:read")) operations.push({ resource: "project", action: "read" })
  if (scopes.includes("projects:write"))
    operations.push(
      ...(["create", "edit", "delete"] as const).map((action) => ({
        resource: "project" as const,
        action
      }))
    )
  return operations
}

/** Auth owns credential persistence; Tasks approves its bounded Board ceiling atomically. */
export async function createBoardAgentCredential<T>(
  db: Client,
  scope: BoardScope,
  input: { tokenId: string; scopes: readonly string[]; assigneeId: string | null },
  persistCredential: (tx: Transaction) => Promise<T>
) {
  return changeBoardGrants(db, scope.principal, async (tx) => {
    const current = await validateBoardScope(scope, tx, { resource: "board", action: "manage" })
    if (!current.ok || !["ha_user", "local_operator"].includes(scope.principal.kind)) {
      throw new BoardOperationError(current.ok ? "denied" : current.errorCode)
    }
    const assigned =
      input.scopes.includes("tasks:write:assigned") && !input.scopes.includes("tasks:write")
    if (assigned) {
      const { rows } = await tx.execute({
        sql: "SELECT 1 FROM custom_users WHERE id=? AND kind='agent'",
        args: [input.assigneeId]
      })
      if (!rows.length) throw new BoardOperationError("denied")
    }
    const value = await persistCredential(tx)
    await tx.execute({
      sql: `INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits)
        VALUES (?,'agent',?,'service',?)`,
      args: [
        scope.boardId,
        input.tokenId,
        JSON.stringify({
          operations: agentBoardOperations(input.scopes),
          ...(assigned ? { assignedTo: input.assigneeId } : {})
        })
      ]
    })
    const final = await validateBoardScope(scope, tx, { resource: "board", action: "manage" })
    if (!final.ok) throw new BoardOperationError(final.errorCode)
    return { next: value }
  })
}

export interface AgentTokenBoardGrant {
  id: string
  name: string
  ticketPrefix: string
}

/** Read active Board grants for a set of agent token IDs, optionally restricted to visible Board IDs. */
export async function listBoardGrantsForAgentTokens(
  db: Pick<Client, "execute">,
  tokenIds: readonly string[],
  allowedBoardIds?: ReadonlySet<string>
): Promise<Map<string, AgentTokenBoardGrant[]>> {
  const grants = new Map<string, AgentTokenBoardGrant[]>()
  if (tokenIds.length === 0) return grants
  const placeholders = tokenIds.map(() => "?").join(", ")
  const result = await db.execute({
    sql: `SELECT g.principal_id AS token_id, b.id AS board_id, b.name AS board_name, b.ticket_prefix
      FROM board_access_grants AS g
      INNER JOIN task_boards AS b ON b.id = g.board_id
      WHERE g.principal_type = 'agent'
        AND b.state = 'active'
        AND g.principal_id IN (${placeholders})
      ORDER BY b.name COLLATE NOCASE ASC`,
    args: [...tokenIds]
  })
  for (const row of result.rows) {
    const tokenId = String(row.token_id ?? "")
    const boardId = String(row.board_id ?? "")
    if (!tokenId || !boardId) continue
    if (allowedBoardIds && !allowedBoardIds.has(boardId)) continue
    const list = grants.get(tokenId) ?? []
    list.push({
      id: boardId,
      name: String(row.board_name ?? "Board"),
      ticketPrefix: String(row.ticket_prefix ?? "")
    })
    grants.set(tokenId, list)
  }
  return grants
}

/** Clean up orphaned Board access grants when an agent token is permanently deleted. */
export async function removeAgentBoardGrants(
  db: Pick<Client, "execute">,
  tokenId: string
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM board_access_grants WHERE principal_type = 'agent' AND principal_id = ?",
    args: [tokenId]
  })
}

