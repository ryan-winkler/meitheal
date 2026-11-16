import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Client, Transaction } from "@libsql/client"

const maxMarkerSize = 160
export const boardGrantPath = "/data/meitheal-board-grants.json"
const revisionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const pendingDirectory = (path: string) => join(dirname(path), "meitheal-board-grants-pending")
const pendingFile = (path: string, revision: string) => join(pendingDirectory(path), revision + ".json")

/** A missing or invalid marker cannot establish the current Board audience. */
export async function readBoardGrantRevision(path = boardGrantPath): Promise<string | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stats = await file.stat()
      if (!stats.isFile() || stats.size > maxMarkerSize) return null
      const bytes = Buffer.alloc(maxMarkerSize + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== stats.size) return null
      const content = JSON.parse(bytes.toString("utf8", 0, bytesRead)) as { epoch?: unknown }
      const revision = content?.epoch
      return typeof revision === "string" && revisionPattern.test(revision) ? revision : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function databaseRevision(db: Pick<Client, "execute">) {
  const { rows: [current] } = await db.execute("SELECT revision FROM board_access_epoch WHERE singleton = 1")
  return typeof current?.revision === "string" && revisionPattern.test(current.revision) ? current.revision : null
}

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_DIRECTORY | constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}

async function prepareGrantMarker(path: string, revision: string) {
  const directory = pendingDirectory(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = await open(pendingFile(path, revision), "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify({ epoch: revision }))
    await file.sync()
  } finally {
    await file.close()
  }
  await syncDirectory(directory)
  await syncDirectory(dirname(path))
}

/** The caller holds the SQLite writer. Only an exact, committed pending marker can finalize. */
async function publishCommittedMarker(path: string, revision: string): Promise<boolean> {
  if (await readBoardGrantRevision(path) === revision) return true
  const prepared = pendingFile(path, revision)
  if (await readBoardGrantRevision(prepared) !== revision) return false

  try {
    await rename(prepared, path)
    await syncDirectory(dirname(path))
    return true
  } catch {
    return false
  }
}

/** A delayed reader cannot accept old data while the on-disk marker catches up. */
export async function boardGrantStillCurrent(db: Pick<Client, "execute">, revision: string, path = boardGrantPath) {
  return await readBoardGrantRevision(path) === revision && await databaseRevision(db) === revision
}

/** Finish an interrupted live publication when the database and the excluded journal agree. */
export async function currentBoardGrantRevision(
  db: Pick<Client, "execute" | "transaction">,
  path = boardGrantPath,
): Promise<string | null> {
  const marker = await readBoardGrantRevision(path)
  const revision = await databaseRevision(db)
  if (revision === marker) return revision
  if (!revision || await readBoardGrantRevision(pendingFile(path, revision)) !== revision) return null

  const tx = await db.transaction("write")
  try {
    if (await databaseRevision(tx) !== revision) return null
    return await publishCommittedMarker(path, revision) ? revision : null
  } finally {
    tx.close()
  }
}

type GrantChange<T> = { next: T } | { unchanged: T }
type GrantChangeResult<T> = { status: "committed" | "committed-locked" | "unchanged"; result: T } | { status: "locked" }

/**
 * The caller checks current Board authority inside the supplied writer.
 * Journal the next audience outside App backups and commit SQLite before publication.
 */
export async function changeBoardGrants<T>(
  db: Pick<Client, "transaction">,
  change: (tx: Transaction, revision: string | null) => Promise<GrantChange<T>>,
  path = boardGrantPath,
): Promise<GrantChangeResult<T>> {
  const transaction = await db.transaction("write")
  let next: string | undefined
  let commitAttempted = false
  let committed: T
  try {
    const revision = await databaseRevision(transaction)
    if (revision) {
      if (!await publishCommittedMarker(path, revision)) return { status: "locked" }
    } else {
      const { rows } = await transaction.execute("SELECT 1 FROM task_boards WHERE id <> 'household' LIMIT 1")
      if (rows.length || await readBoardGrantRevision(path)) return { status: "locked" }
    }
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
    const finalizer = await db.transaction("write")
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
