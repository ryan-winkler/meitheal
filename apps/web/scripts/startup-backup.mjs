import { chmod, link, mkdir, mkdtemp, readdir, rm, stat, statfs, unlink } from "node:fs/promises"
import path from "node:path"

const MAX_BACKUPS = 5

/** @param {import("@libsql/client").Client} client */
export async function autoBackupDb(client) {
  if (client.protocol !== "file") return

  let scratch
  try {
    const { rows } = await client.execute("PRAGMA database_list")
    const dbPath = rows.find(row => row.name === "main")?.file
    if (typeof dbPath !== "string" || !dbPath) return
    const database = await stat(dbPath)
    if (!database.isFile() || database.size === 0) return

    const backupDir = path.join(path.dirname(dbPath), "backups")
    await mkdir(backupDir, { recursive: true, mode: 0o700 })
    const { backup, DatabaseSync } = await import("node:sqlite")
    const source = new DatabaseSync(dbPath, { readOnly: true })
    let snapshotPath
    try {
      // Pin a WAL read snapshot so concurrent commits cannot restart the backup.
      source.exec("BEGIN")
      const pages = Number(source.prepare("PRAGMA page_count").get()?.page_count)
      const pageSize = Number(source.prepare("PRAGMA page_size").get()?.page_size)
      const free = await statfs(backupDir)
      if (free.bavail * free.bsize < pages * pageSize) {
        throw new Error("Not enough space for the startup backup")
      }
      scratch = await mkdtemp(path.join(backupDir, ".meitheal-startup-"))
      snapshotPath = path.join(scratch, "snapshot.tmp")
      await backup(source, snapshotPath)
    } finally {
      source.close()
    }

    // Keep each retained snapshot readable as one file, even on a read-only volume.
    const snapshot = new DatabaseSync(snapshotPath)
    try {
      if (snapshot.prepare("PRAGMA journal_mode=DELETE").get()?.journal_mode !== "delete") {
        throw new Error("Could not finalize the startup backup")
      }
    } finally {
      snapshot.close()
    }

    await chmod(snapshotPath, 0o600)
    const size = (await stat(snapshotPath)).size
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
    const backupPath = path.join(backupDir, `meitheal-${timestamp}.db`)
    // Publish a completed file without replacing an existing backup on a name collision.
    await link(snapshotPath, backupPath)
    console.log(`[meitheal] DB backup created: ${backupPath} (${size} bytes)`)

    try {
      const entries = await readdir(backupDir, { withFileTypes: true })
      const snapshots = await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.startsWith("meitheal-") && entry.name.endsWith(".db"))
        .map(async entry => ({ name: entry.name, time: (await stat(path.join(backupDir, entry.name))).mtimeMs })))
      snapshots.sort((a, b) => b.time - a.time || b.name.localeCompare(a.name))
      for (const old of snapshots.slice(MAX_BACKUPS)) await unlink(path.join(backupDir, old.name))
    } catch {
      // A rotation failure must not prevent startup or invalidate the new backup.
    }
  } catch {
    console.error("[meitheal] DB backup failed — continuing without backup")
  } finally {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true }).catch(() => {
        console.error("[meitheal] Could not remove the startup backup scratch directory")
      })
    }
  }
}
