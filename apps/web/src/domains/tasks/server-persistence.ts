/** Server-only persistence port for cooperating domains. Never serialize these fragments. */
import type { Client } from "@libsql/client"
import { principalProof, type BoardScope, type VerifiedPrincipal } from "./board-scope"
import { storageBoardId, ownedPlanning, taskOwnedBy } from "./persistence/board-storage"
import { guardClientContinuity } from "./persistence/continuity-client"
import { sql, type SqlFragment } from "./persistence/sql-fragment"
export { sql, sourceSql, joinSql, type SqlFragment } from "./persistence/sql-fragment"

/** Only a finite yes/no check is shared; principal proofs and minting remain private. */
export function isVerifiedPrincipalCurrent(principal: VerifiedPrincipal): boolean {
  return Boolean(principalProof(principal))
}
export function boardPlanningOwnership(scope: BoardScope, sourceAlias: string): SqlFragment {
  return ownedPlanning(scope, sourceAlias)
}
export function boardTaskOwnership(scope: BoardScope, sourceAlias = "tasks"): SqlFragment {
  return taskOwnedBy(scope, sourceAlias)
}
/** A bound INSERT expression, never a raw physical Board owner id/encoding descriptor. */
export function boardOwnerInsertExpression(scope: BoardScope): SqlFragment {
  return sql`${storageBoardId(scope)}`
}
/** Preserve continuity for personal-domain writers without exposing an unwrap primitive. */
export function guardWorkPersistence(client: Client): Client {
  return guardClientContinuity(client)
}
