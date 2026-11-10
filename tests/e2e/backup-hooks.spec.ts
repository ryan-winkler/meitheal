import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { POST as prepare } from "../../apps/web/src/pages/api/backup/prepare"
import { POST as complete } from "../../apps/web/src/pages/api/backup/complete"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { resolveRouteScope } from "../../apps/web/src/lib/agent-token-guard"

test.describe.configure({ mode: "serial" })

let directory: string
let previousDb: string | undefined

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-backup-hooks-"))
  previousDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  resetPersistenceForTests()
  await ensureSchema()
})

test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDb
  await rm(directory, { recursive: true, force: true })
})

test("prepare checkpoints committed WAL data into a standalone readable database file", async () => {
  const client = getPersistenceClient()
  await client.execute("CREATE TABLE backup_checkpoint_fixture (title TEXT NOT NULL)")
  await client.execute({ sql: "INSERT INTO backup_checkpoint_fixture (title) VALUES (?)", args: ["Committed household fixture"] })
  const response = await prepare({} as never)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, checkpoint: "complete", log_frames: 0, checkpointed_frames: 0 })

  // Inspect a separate snapshot, never a second client on the live database.
  const snapshotPath = join(directory, "snapshot.db")
  await copyFile(join(directory, "test.db"), snapshotPath)
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
  try {
    expect(snapshot.prepare("SELECT title FROM backup_checkpoint_fixture").get()?.title).toBe("Committed household fixture")
    expect(snapshot.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok")
  } finally {
    snapshot.close()
  }

  // Preparation never quiesces writes and completion is not needed to unlock.
  await client.execute({ sql: "INSERT INTO backup_checkpoint_fixture (title) VALUES (?)", args: ["Write after checkpoint"] })
  expect((await client.execute("SELECT COUNT(*) AS total FROM backup_checkpoint_fixture")).rows[0]?.total).toBe(2)
})

for (const [name, row, code] of [
  ["busy", { busy: 1, log: 4, checkpointed: 3 }, "BACKUP_CHECKPOINT_BUSY"],
  ["incomplete", { busy: 0, log: 4, checkpointed: 3 }, "BACKUP_CHECKPOINT_BUSY"],
  ["invalid", { unexpected: true }, "BACKUP_CHECKPOINT_INVALID"],
] as const) {
  test(`prepare refuses a ${name} SQLite checkpoint result instead of acknowledging success`, async () => {
    const client = getPersistenceClient()
    const execute = client.execute.bind(client)
    client.execute = (async (sql: Parameters<typeof execute>[0]) => {
      if (sql === "PRAGMA wal_checkpoint(TRUNCATE)") return { rows: [row] } as unknown as Awaited<ReturnType<typeof execute>>
      return execute(sql)
    }) as typeof client.execute
    try {
      const response = await prepare({} as never)
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ ok: false, errorCode: code })
    } finally {
      client.execute = execute
    }
  })
}

test("checkpoint exceptions are explicit failures and completion stays idempotent", async () => {
  const client = getPersistenceClient()
  const execute = client.execute.bind(client)
  client.execute = (async () => { throw new Error("Synthetic checkpoint failure") }) as typeof client.execute
  try {
    const response = await prepare({} as never)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ ok: false, errorCode: "BACKUP_CHECKPOINT_FAILED" })
  } finally {
    client.execute = execute
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await complete({} as never)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, writes_paused: false })
  }
})

test("backup hook routes require explicit agent settings-write authority", () => {
  expect(resolveRouteScope("/api/backup/prepare", "POST")).toBe("settings:write")
  expect(resolveRouteScope("/api/backup/complete", "POST")).toBe("settings:write")
})
