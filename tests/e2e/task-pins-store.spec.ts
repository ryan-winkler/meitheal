import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { execFileSync } from "../helpers/isolated-process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test as base } from "@playwright/test"
import { DATABASE_SCHEMA_VERSION, openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { ensureSchema, getPersistenceClient, getSchemaVersion, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { TaskPinRepository } from "../../apps/web/src/domains/tasks/persistence/task-pin-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { enrollCurrentOwnedLegacyFixture } from "../helpers/current-legacy-fixture"
import { prepareTaskBoardPredecessor } from "../scripts/task-board-predecessor"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
type Database = ReturnType<typeof getPersistenceClient>

const test = base.extend<{ db: Database; legacyPredecessor: boolean }>({
  legacyPredecessor: [false, { option: true }],
  db: async ({ legacyPredecessor }, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const dir = await mkdtemp(join(tmpdir(), "meitheal-pins-"))
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
    resetPersistenceForTests()
    if (!legacyPredecessor) await ensureSchema()
    const db = legacyPredecessor ? openDatabase(process.env.MEITHEAL_DB_URL) : getPersistenceClient()
    try {
      await use(db)
    } finally {
      db.close()
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(dir, { recursive: true, force: true })
    }
  },
})

function migrate(...args: string[]) {
  return execFileSync(process.execPath, ["scripts/migrate.mjs", ...args], {
    cwd: web, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  })
}

async function seed(db: Database, id: string, status = "pending") {
  await db.execute({
    sql: `INSERT INTO tasks (id, title, request_id, idempotency_key, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, 1)`,
    args: [id, id, id, id, status],
  })
}

const legacyTest = test.extend({ legacyPredecessor: true })

legacyTest("verified current legacy enrollment and runtime/CLI reconcile the schema and preserve task data", async ({ db }) => {
  await prepareTaskBoardPredecessor(db)
  await db.execute("ALTER TABLE tasks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0")
  await db.execute({
    sql: `INSERT INTO tasks (id, title, request_id, idempotency_key, status, is_favorite, created_at, updated_at)
          VALUES ('retained', 'retained', 'retained', 'retained', 'pending', 1, 1, 1)`,
    args: [],
  })

  // Recreate the state just before the pin migration on an existing database.
  await db.batch([
    "DROP TABLE task_pins",
    "DELETE FROM __meitheal_migrations WHERE name = '0005_task_pins.mjs'",
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('schema_version', '13', 1)",
  ], "write")
  expect(() => migrate("--check")).toThrow(/Pending migrations: 0005_task_pins.mjs/)
  db.close()
  const database = process.env.MEITHEAL_DB_URL!.slice(5)
  const proof = await enrollCurrentOwnedLegacyFixture({ database, markerPath: database + ".board-grants.json", provenance: "created-in-this-test-and-never-restored" })
  try {
    await ensureSchema()
    expect(getSchemaVersion()).toBe(DATABASE_SCHEMA_VERSION)
    expect(migrate()).toContain("No migrations to apply")
    expect(migrate("--check")).toContain("Migration check passed")
    const retained = await new TaskRepository(getPersistenceClient(), await currentBoardScope(getPersistenceClient())).findById("retained")
    expect(retained?.id).toBe("retained")
    expect(retained?.is_promoted).toBe(0)
    expect((await getPersistenceClient().execute("SELECT task_id FROM archived_task_favorites WHERE task_id = 'retained'")).rows).toHaveLength(1)
  } finally { await rm(proof.custodyDirectory, { recursive: true, force: true }) }
})

test("the migration check rejects a pin index with the wrong sort order", async ({ db }) => {
  migrate()
  await db.batch([
    "DROP INDEX task_pins_owner_recent_idx",
    "CREATE INDEX task_pins_owner_recent_idx ON task_pins(owner_id, pinned_at ASC, task_id ASC)",
  ], "write")
  expect(() => migrate("--check")).toThrow(/Unexpected task pins index/)
  resetPersistenceForTests()
  await expect(ensureSchema()).rejects.toThrow(/Unexpected task pins index/)
})

test("pins are private, idempotent and consistently paginated", async ({ db }) => {
  await ensureSchema()
  const pinsA = new TaskPinRepository(db, await currentBoardScope(db, "household", fixturePrincipal("user-a", false)))
  const pinsB = new TaskPinRepository(db, await currentBoardScope(db, "household", fixturePrincipal("user-b", false)))
  for (let i = 1; i <= 26; i++) {
    const id = `card-${i}`
    await seed(db, id)
    await pinsA.set("user-a", id, true, i)
  }
  await pinsB.set("user-b", "card-26", true, 101)
  expect(await pinsB.get("user-b", "card-25")).toEqual({ id: "card-25", pinned: false, pinned_at: null })
  const retries = await Promise.all([pinsA.set("user-a", "card-26", true, 200), pinsA.set("user-a", "card-26", true, 201)])
  expect(retries).toEqual(Array(2).fill({ id: "card-26", pinned: true, pinned_at: 26 }))
  const first = await pinsA.list("user-a", 1)
  expect(first).toMatchObject({ page: 1, total: 26 })
  expect(first.items).toHaveLength(25)
  expect(first.items[0]).toMatchObject({ id: "card-26", pinned_at: 26 })
  expect(await pinsA.list("user-a", 10)).toMatchObject({ page: 2, total: 26, items: [{ id: "card-1" }] })
  expect(await pinsB.list("user-b", 1)).toMatchObject({ page: 1, total: 1, items: [{ id: "card-26" }] })
  expect(await pinsA.set("user-a", "missing", true)).toBeNull()
  expect(await pinsA.set("user-a", "card-26", false)).toMatchObject({ pinned: false })
  expect(await pinsB.get("user-b", "card-26")).toMatchObject({ pinned: true, pinned_at: 101 })
  expect(await pinsA.list("user-a", 2)).toMatchObject({ page: 1, total: 25 })
})

test("deletion, retention and purge physically cascade for every owner", async ({ db }) => {
  await ensureSchema()
  const pinsA = new TaskPinRepository(db, await currentBoardScope(db, "household", fixturePrincipal("user-a", false)))
  const pinsB = new TaskPinRepository(db, await currentBoardScope(db, "household", fixturePrincipal("user-b", false)))
  const tasks = new TaskRepository(db, await currentBoardScope(db))
  for (const [id, status] of [["normal", "pending"], ["retention", "complete"], ["keep", "pending"]] as const) {
    await seed(db, id, status)
    await pinsA.set("user-a", id, true)
    await pinsB.set("user-b", id, true)
  }
  await db.execute("UPDATE tasks SET status = 'active', deferred_at = 5 WHERE id = 'keep'")
  expect(await pinsA.list("user-a", 1)).toMatchObject({ items: expect.arrayContaining([{ id: "keep", title: "keep", status: "active", ticket_number: null, ticket_key: null, deferred_at: 5, pinned_at: expect.any(Number) }]) })
  await tasks.deleteTask("normal")
  expect(await tasks.deleteCompletedBefore(2)).toBe(1)
  expect((await db.execute("SELECT task_id FROM task_pins ORDER BY owner_id")).rows).toEqual([{ task_id: "keep" }, { task_id: "keep" }])
  await tasks.purgeAll()
  expect((await db.execute("SELECT task_id FROM task_pins")).rows).toEqual([])
})
