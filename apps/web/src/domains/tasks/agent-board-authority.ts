import type { Client, Transaction } from "@libsql/client"
import { validateBoardScope, type BoardScope, type WorkOperation } from "./board-scope"
import { changeBoardGrants } from "./persistence/board-grant-fence"
import { BoardOperationError } from "./persistence/board-operation-client"

/** Snapshot a credential ceiling when a current Board manager explicitly approves it. */
export function agentBoardOperations(scopes: readonly string[]): WorkOperation[] {
  const operations: WorkOperation[] = []
  if (scopes.includes("tasks:read"))
    operations.push({ resource: "board", action: "read" }, { resource: "task", action: "read" })
  if (scopes.includes("search:read") || scopes.includes("tasks:read"))
    operations.push({ resource: "task", action: "search" })
  if (scopes.includes("tasks:write")) {
    operations.push(
      ...(["create", "edit", "move", "assign", "complete", "reopen"] as const).map((action) => ({
        resource: "task" as const,
        action
      }))
    )
  } else if (scopes.includes("tasks:write:assigned")) {
    operations.push(
      ...(["edit", "move", "assign", "complete", "reopen"] as const).map((action) => ({
        resource: "task" as const,
        action
      }))
    )
  }
  if (scopes.includes("tasks:delete")) operations.push({ resource: "task", action: "delete" })
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
