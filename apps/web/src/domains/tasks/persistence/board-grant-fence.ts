import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import type { Client, Transaction } from "@libsql/client"
import { acquireWriteTransaction } from "../../../../scripts/database-client.mjs"
import { unwrapRegisteredContinuityClient } from "./continuity-client"

export {
  boardGrantPath, boardGrantStillCurrent, currentBoardGrantRevision, readBoardGrantRevision,
} from "../../../../scripts/board-grant-journal.mjs"
import {
  databaseRevision, getBoardGrantPath, pendingFile, prepareGrantMarker, publishCommittedMarker,
} from "../../../../scripts/board-grant-journal.mjs"

type GrantChange<T> = { next: T } | { unchanged: T }
type GrantChangeResult<T> = { status: "committed" | "committed-locked" | "unchanged"; result: T } | { status: "locked" }

/**
 * The caller checks current Board authority inside the supplied writer.
 * Journal the next audience outside App backups and commit SQLite before publication.
 */
export async function changeBoardGrants<T>(
  db: Pick<Client, "transaction">,
  change: (tx: Transaction, revision: string | null) => Promise<GrantChange<T>>,
  path = getBoardGrantPath(db),
): Promise<GrantChangeResult<T>> {
  // The journal owns its epoch update and publication boundary. A normal
  // continuity guard would reject its intentional epoch change before commit.
  db = unwrapRegisteredContinuityClient(db)
  const transaction = await acquireWriteTransaction(db)
  let next: string | undefined
  let commitAttempted = false
  let committed: T
  try {
    const revision = await databaseRevision(transaction)
    // Only enrolled, independently current installations can change authority.
    if (!revision || !await publishCommittedMarker(path, revision)) return { status: "locked" }
    const result = await change(transaction, revision)
    if ("unchanged" in result) return { status: "unchanged", result: result.unchanged }

    next = randomUUID()
    await prepareGrantMarker(path, next)
    await transaction.execute({
      sql: `INSERT INTO board_access_epoch(singleton, revision) VALUES (1, ?)
            ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision`,
      args: [next],
    })
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
      const published = revision !== next || await publishCommittedMarker(path, next)
      return { status: published ? "committed" : "committed-locked", result: committed }
    } finally {
      finalizer.close()
    }
  } catch {
    return { status: "committed-locked", result: committed }
  }
}
