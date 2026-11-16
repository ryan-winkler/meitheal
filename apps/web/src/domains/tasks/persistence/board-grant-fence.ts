import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { mkdtemp, open, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Client, Transaction } from "@libsql/client"

const maxMarkerSize = 160
export const boardGrantPath = "/data/meitheal-board-grants.json"
const revisionPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

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

type GrantChange<T> = { next: T } | { unchanged: T }
type GrantChangeResult<T> = { status: "committed" | "unchanged"; result: T } | { status: "locked" }

/**
 * The caller checks current Board authority inside the supplied writer transaction.
 * Commit the new audience first. The prior marker closes access until publication.
 */
export async function changeBoardGrants<T>(
  db: Pick<Client, "transaction">,
  change: (tx: Transaction, revision: string | null) => Promise<GrantChange<T>>,
  path = boardGrantPath,
): Promise<GrantChangeResult<T>> {
  const namedMarker = await readBoardGrantRevision(path)
  const transaction = await db.transaction("write")
  let temporaryDirectory: string | undefined
  try {
    const { rows: [current] } = await transaction.execute("SELECT revision FROM board_access_epoch WHERE singleton = 1")
    const revision = typeof current?.revision === "string" ? current.revision : null
    if (revision !== namedMarker) return { status: "locked" }
    if (!revision && (await transaction.execute("SELECT 1 FROM task_boards WHERE id <> 'household' LIMIT 1")).rows.length) {
      return { status: "locked" }
    }
    const result = await change(transaction, revision)
    if ("unchanged" in result) return { status: "unchanged", result: result.unchanged }

    const next = randomUUID()
    const directoryPath = dirname(path)
    temporaryDirectory = await mkdtemp(join(directoryPath, ".meitheal-grants-"))
    const temporaryFile = join(temporaryDirectory, "revision")
    const file = await open(temporaryFile, "wx", 0o600)
    try {
      await file.writeFile(JSON.stringify({ epoch: next }))
      await file.sync()
    } finally {
      await file.close()
    }

    await transaction.execute({
      sql: `INSERT INTO board_access_epoch(singleton, revision) VALUES (1, ?)
            ON CONFLICT(singleton) DO UPDATE SET revision = excluded.revision`,
      args: [next],
    })
    await transaction.commit()
    await rename(temporaryFile, path)
    const directory = await open(directoryPath, constants.O_DIRECTORY | constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
    return { status: "committed", result: result.next }
  } finally {
    transaction.close()
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {})
  }
}
