import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import type { Client, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { unwrapRegisteredContinuityClient } from "./continuity-client"
import { principalProof, type VerifiedPrincipal } from "../board-scope"
import { BoardOperationError } from "./board-operation-client"

export {
  boardGrantPath,
  boardGrantStillCurrent,
  currentBoardGrantRevision,
  readBoardGrantRevision
} from "../../../../scripts/board-grant-journal.mjs"
import {
  databaseRevision,
  getBoardGrantPath,
  pendingFile,
  prepareGrantMarker,
  publishCommittedMarker
} from "../../../../scripts/board-grant-journal.mjs"

type GrantChange<TNext, TUnchanged = TNext> = { next: TNext } | { unchanged: TUnchanged }
type GrantChangeResult<TNext, TUnchanged = TNext> =
  | { status: "committed" | "committed-locked"; result: TNext }
  | { status: "unchanged"; result: TUnchanged }
  | { status: "locked" }

/**
 * The caller checks current Board authority inside the supplied writer.
 * Journal the next audience outside App backups and commit SQLite before publication.
 */
export async function changeBoardGrants<TNext, TUnchanged = TNext>(
  db: Pick<Client, "transaction">,
  principal: VerifiedPrincipal,
  change: (tx: Transaction, revision: string | null) => Promise<GrantChange<TNext, TUnchanged>>,
  path = getBoardGrantPath(db)
): Promise<GrantChangeResult<TNext, TUnchanged>> {
  // The journal owns its epoch update and publication boundary. A normal
  // continuity guard would reject its intentional epoch change before commit.
  db = unwrapRegisteredContinuityClient(db)
  const transaction = await acquireWriteTransaction(db)
  let next: string | undefined
  let commitAttempted = false
  let committed: TNext
  try {
    const revision = await databaseRevision(transaction)
    // Only enrolled, independently current installations can change authority.
    if (!revision || !(await publishCommittedMarker(path, revision))) return { status: "locked" }
    if (!principalProof(principal)) throw new BoardOperationError("stale")
    const result = await change(transaction, revision)
    if ("unchanged" in result) {
      if (!principalProof(principal)) throw new BoardOperationError("stale")
      return { status: "unchanged", result: result.unchanged }
    }

    next = randomUUID()
    await prepareGrantMarker(path, next)
    await transaction.execute({
      sql: `INSERT INTO board_access_epoch(singleton, revision) VALUES (1, ?)
            ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision`,
      args: [next]
    })
    // Entitlements may intentionally change in this writer. The independently
    // verified identity must nevertheless survive every asynchronous journal step.
    if (!principalProof(principal)) throw new BoardOperationError("stale")
    if (principal.kind === "agent") {
      const {
        rows: [token]
      } = await transaction.execute({
        sql: "SELECT expires_at FROM agent_tokens WHERE id=? AND revoked=0",
        args: [principal.tokenId]
      })
      if (
        !token ||
        (token.expires_at !== null && !(Date.parse(String(token.expires_at)) > Date.now()))
      )
        throw new BoardOperationError("stale")
    }
    if (!principalProof(principal)) throw new BoardOperationError("stale")
    commitAttempted = true
    await transaction.commit()
    committed = result.next
  } catch (error) {
    // Do not delete a journal if committing may already have persisted its database revision.
    if (next && !commitAttempted) await rm(pendingFile(path, next), { force: true }).catch(() => {})
    throw error
  } finally {
    transaction.close()
  }

  // Reacquire the writer before publication. Any later writer first publishes this revision.
  try {
    const finalizer = await acquireWriteTransaction(db)
    try {
      const revision = await databaseRevision(finalizer)
      const published = revision !== next || (await publishCommittedMarker(path, next))
      return { status: published ? "committed" : "committed-locked", result: committed }
    } finally {
      finalizer.close()
    }
  } catch {
    return { status: "committed-locked", result: committed }
  }
}
