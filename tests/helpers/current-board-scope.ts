import type { getPersistenceClient } from "./persistence-fixture"
type Client = ReturnType<typeof getPersistenceClient>
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { registerVerifiedPrincipal, type VerifiedPrincipal, type WorkOperation } from "../../apps/web/src/domains/tasks/board-scope"

/** Synthetic current identity only; this helper never admits a restored database. */
export function fixturePrincipal(id = "owner", administrator = true): VerifiedPrincipal {
  return registerVerifiedPrincipal({ kind: "ha_user", id }, { administrator, expiresAt: Date.now() + 60_000 })
}

export async function currentBoardScope(db: Client, boardId = "household", principal = fixturePrincipal(),
  operation: WorkOperation = { resource: "task", action: "read" }) {
  const result = await new BoardAccessService(db).resolve(principal, boardId, operation)
  if (!result.ok) throw new Error(`Fixture Board scope unavailable: ${result.errorCode}`)
  return result.scope
}
