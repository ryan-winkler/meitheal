import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test as base } from "@playwright/test"
import { ensureSchema, getPersistenceClient, getSchemaVersion, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskPinRepository } from "../../apps/web/src/domains/tasks/persistence/task-pin-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
type Database = ReturnType<typeof getPersistenceClient>

const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const dir = await mkdtemp(join(tmpdir(), "meitheal-pins-"))
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
    resetPersistenceForTests()
    try {
      await use(getPersistenceClient())
    } finally {
      const current = getPersistenceClient()
      if (!current.closed) current.close()
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
    sql: `INSERT INTO tasks (id, title, request_id, idempotency_key, status, is_favorite, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, 1, 1)`,
    args: [id, id, id, id, status],
  })
}

test("runtime-first and CLI-first paths reconcile the schema and preserve task data", async ({ db }) => {
  expect(migrate()).toContain("Applied migration: 0005_task_pins.mjs")
  await ensureSchema()
  await seed(db, "retained")
  expect(getSchemaVersion()).toBe(14)

  // Recreate the state just before the pin migration on an existing database.
  await db.batch([
    "DROP TABLE task_pins",
    "DELETE FROM __meitheal_migrations WHERE name = '0005_task_pins.mjs'",
    "UPDATE app_settings SET value = '13' WHERE key = 'schema_version'",
  ], "write")
  db.close()
  resetPersistenceForTests()
  await ensureSchema()
  expect(getSchemaVersion()).toBe(14)
  expect(() => migrate("--check")).toThrow(/Pending migrations: 0005_task_pins.mjs/)
  expect(migrate()).toContain("Applied migration: 0005_task_pins.mjs")
  expect(migrate("--check")).toContain("Migration check passed")
  expect((await new TaskRepository(getPersistenceClient()).findById("retained"))?.is_favorite).toBe(1)
})

test("the migration check rejects a pin index with the wrong sort order", async ({ db }) => {
  migrate()
  await db.batch([
    "DROP INDEX task_pins_owner_recent_idx",
    "CREATE INDEX task_pins_owner_recent_idx ON task_pins(owner_id, pinned_at ASC, task_id ASC)",
  ], "write")
  expect(() => migrate("--check")).toThrow(/Unexpected task pins index/)
  await expect(ensureSchema()).rejects.toThrow(/Unexpected task pins index/)
})

test("pins are private, idempotent and consistently paginated", async ({ db }) => {
  await ensureSchema()
  const pins = new TaskPinRepository(db)
  for (let i = 1; i <= 26; i++) {
    const id = `card-${i}`
    await seed(db, id)
    await pins.set("user-a", id, true, i)
  }
  await pins.set("user-b", "card-26", true, 101)
  expect(await pins.get("user-b", "card-25")).toEqual({ id: "card-25", pinned: false, pinned_at: null })
  const retries = await Promise.all([pins.set("user-a", "card-26", true, 200), pins.set("user-a", "card-26", true, 201)])
  expect(retries).toEqual(Array(2).fill({ id: "card-26", pinned: true, pinned_at: 26 }))
  const first = await pins.list("user-a", 1)
  expect(first).toMatchObject({ page: 1, total: 26 })
  expect(first.items).toHaveLength(25)
  expect(first.items[0]).toMatchObject({ id: "card-26", pinned_at: 26 })
  expect(await pins.list("user-a", 10)).toMatchObject({ page: 2, total: 26, items: [{ id: "card-1" }] })
  expect(await pins.list("user-b", 1)).toMatchObject({ page: 1, total: 1, items: [{ id: "card-26" }] })
  expect(await pins.set("user-a", "missing", true)).toBeNull()
  expect(await pins.set("user-a", "card-26", false)).toMatchObject({ pinned: false })
  expect(await pins.get("user-b", "card-26")).toMatchObject({ pinned: true, pinned_at: 101 })
  expect(await pins.list("user-a", 2)).toMatchObject({ page: 1, total: 25 })
})

test("deletion, retention and purge physically cascade for every owner", async ({ db }) => {
  await ensureSchema()
  const pins = new TaskPinRepository(db)
  const tasks = new TaskRepository(db)
  for (const [id, status] of [["normal", "pending"], ["retention", "complete"], ["keep", "pending"]] as const) {
    await seed(db, id, status)
    await pins.set("user-a", id, true)
    await pins.set("user-b", id, true)
  }
  await db.execute("UPDATE tasks SET status = 'active', deferred_at = 5 WHERE id = 'keep'")
  expect(await pins.list("user-a", 1)).toMatchObject({ items: expect.arrayContaining([{ id: "keep", title: "keep", status: "active", ticket_number: null, deferred_at: 5, pinned_at: expect.any(Number) }]) })
  await tasks.deleteTask("normal")
  expect(await tasks.deleteCompletedBefore(2)).toBe(1)
  expect((await db.execute("SELECT task_id FROM task_pins ORDER BY owner_id")).rows).toEqual([{ task_id: "keep" }, { task_id: "keep" }])
  await tasks.purgeAll()
  expect((await db.execute("SELECT task_id FROM task_pins")).rows).toEqual([])
})
