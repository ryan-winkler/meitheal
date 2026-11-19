import { mkdir } from "node:fs/promises"
import path from "node:path"
import { openDatabaseForStartup, withStartupWriteTransaction } from "./database-client.mjs"
import { autoBackupDb } from "./startup-backup.mjs"
import { applyStartupTaskSchema, validateStartupTaskSchema } from "./task-schema-startup.mjs"
import { finalizeStartupBoardGrant, initializeBoardGrantContinuity } from "./board-grant-journal.mjs"

const dbUrl = process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db"
const checkOnly = process.argv.includes("--check")

async function main() {
  if (!checkOnly && dbUrl.startsWith("file:")) {
    await mkdir(path.dirname(path.resolve(dbUrl.slice("file:".length))), { recursive: true })
  }
  const client = await openDatabaseForStartup(dbUrl, { readOnly: checkOnly, markerPath: process.env.MEITHEAL_BOARD_GRANT_PATH })
  try {
    if (checkOnly) {
      const tx = await client.transaction("read")
      try {
        await validateStartupTaskSchema(tx)
      } finally {
        tx.close()
      }
      console.log("Migration check passed (no pending migrations).")
      return
    }

    await autoBackupDb(client)
    let initialRevision = null
    const applied = await withStartupWriteTransaction(client, async tx => {
      const applied = await applyStartupTaskSchema(tx)
      initialRevision = await initializeBoardGrantContinuity(client, tx)
      return applied
    })
    await finalizeStartupBoardGrant(client, initialRevision)
    for (const file of applied) console.log(`Applied migration: ${file}`)
    if (applied.length === 0) console.log("No migrations to apply.")
  } finally {
    client.close()
  }
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
