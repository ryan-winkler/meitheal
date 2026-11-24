import type { Client, InStatement, InValue } from "@libsql/client"
import { BoardOperationError, boardOperationClient, canReadBoardAggregate, getPersistenceClient, validateBoardFeature, type BoardScope } from "@domains/tasks"

/** Access to this context's own Board-bound statistics tables. */
export async function gamificationClient(scope: BoardScope, write = false): Promise<Client> {
  const base = getPersistenceClient()
  if (!await validateBoardFeature(scope, base, "achievements") || !write && !await canReadBoardAggregate(base, scope)) throw new BoardOperationError("unavailable")
  return boardOperationClient(base, scope, { resource: "task", action: write ? "complete" : "read" })
}

/** Explicit source queries reference board_stats/board_achievements, with values bound in lexical order. */
export function gamificationRead(scope: BoardScope, query: InStatement): InStatement {
  const statement = typeof query === "string" ? { sql: query, args: [] } : query
  if (statement.args && !Array.isArray(statement.args)) throw new Error("Scoped statistics require positional arguments")
  return {
    sql: `WITH board_stats AS (SELECT * FROM gamification_stats WHERE board_id = ?),
      board_achievements AS (SELECT * FROM gamification_achievements WHERE board_id = ?)
      ${statement.sql}`,
    args: [scope.boardId, scope.boardId, ...(statement.args as InValue[] | undefined ?? [])],
  }
}
