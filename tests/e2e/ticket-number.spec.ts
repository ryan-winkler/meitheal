import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { enrollCurrentOwnedLegacyFixture } from "../helpers/current-legacy-fixture"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../helpers/persistence-fixture"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { formatTicketKey, parseTicketKey } from "../../apps/web/src/lib/ticket-key"

type Database = ReturnType<typeof getPersistenceClient>

async function withTicketDatabase(url: string, run: (db: Database) => Promise<void>) {
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = url
  resetPersistenceForTests()
  let db: Database | undefined
  try {
    await ensureSchema()
    db = getPersistenceClient()
    await run(db)
  } finally {
    db?.close()
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
  }
}

const test = base.extend<{ databaseUrl: string; db: Database }>({
  databaseUrl: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-ticket-number-"))
    try {
      await use(`file:${join(directory, "tasks.db")}`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
  db: ({ databaseUrl }, use) => withTicketDatabase(databaseUrl, use),
})

function createTask(db: Database, id: string) {
  return new TaskRepository(db).createTask({
    id, title: id, description: "", status: "pending", priority: 3, due_date: null,
    labels: '["fixture"]', framework_payload: "{}", parent_id: null, area_id: "default",
    custom_fields: "{}", start_date: null, end_date: null, progress: 0, color: null,
    is_favorite: 0, task_type: "task", assigned_to: null,
  })
}

test("ticket_number column exists after ensureSchema", async ({ db }) => {
  const result = await db.execute("SELECT name FROM pragma_table_info('tasks') WHERE name = 'ticket_number'")
  expect(result.rows).toEqual([{ name: "ticket_number" }])
})

test("ticket_number unique index exists", async ({ db }) => {
  const result = await db.execute("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'tasks_ticket_number_idx'")
  expect(result.rows).toEqual([{ name: "tasks_ticket_number_idx" }])
})

test("task creation returns consecutive Household tickets and preserves labels after deletion", async ({ db }) => {
  expect(await createTask(db, "first")).toBe(1)
  await db.execute("DELETE FROM tasks WHERE id = 'first'")
  expect(await createTask(db, "second")).toBe(2)
  const result = await db.execute("SELECT ticket_number, labels FROM tasks WHERE id = 'second'")
  expect(result.rows).toEqual([{ ticket_number: 2, labels: '["fixture"]' }])
})

test("ticket_number is unique across rows", async ({ db }) => {
  const ticket = await createTask(db, "first")
  await expect(db.execute({
    sql: `INSERT INTO tasks (id, title, ticket_number, idempotency_key, request_id, created_at, updated_at)
          VALUES ('duplicate', 'Duplicate', ?, 'duplicate', 'duplicate', 1, 1)`,
    args: [ticket],
  })).rejects.toThrow(/UNIQUE constraint failed: tasks.ticket_number/)
})

test("legacy backfill assigns tickets from rowids before Household issuance starts", async ({ databaseUrl }) => {
  const predecessor = openDatabase(databaseUrl)
  try {
    const schema = await readFile(new URL("../../apps/web/drizzle/migrations/0000_iteration2_init.sql", import.meta.url), "utf8")
    await predecessor.executeMultiple(schema)
    await predecessor.execute(`INSERT INTO tasks (rowid, id, title, idempotency_key, request_id, created_at, updated_at)
      VALUES (4, 'old-first', 'Old first', 'old-first', 'old-first', 1, 1),
             (9, 'old-last', 'Old last', 'old-last', 'old-last', 1, 1)`)
  } finally {
    predecessor.close()
  }
  const database = databaseUrl.slice(5)
  const proof = await enrollCurrentOwnedLegacyFixture({ database, markerPath: database + ".board-grants.json", provenance: "created-in-this-test-and-never-restored" })
  try {
    await withTicketDatabase(databaseUrl, async db => {
      const result = await db.execute("SELECT id, ticket_number FROM tasks ORDER BY rowid")
      expect(result.rows).toEqual([
        { id: "old-first", ticket_number: 4 },
        { id: "old-last", ticket_number: 9 },
      ])
      expect(await createTask(db, "new")).toBe(10)
    })
  } finally { await rm(proof.custodyDirectory, { recursive: true, force: true }) }
})

test("formatTicketKey produces MTH-N format", () => {
  expect(formatTicketKey(1)).toBe("MTH-1")
  expect(formatTicketKey(42)).toBe("MTH-42")
  expect(formatTicketKey(100)).toBe("MTH-100")
  expect(formatTicketKey(null)).toBeNull()
  expect(formatTicketKey(undefined)).toBeNull()
  expect(formatTicketKey(0)).toBeNull()
  expect(formatTicketKey(-1)).toBeNull()
})

test("parseTicketKey extracts number from MTH-N format", () => {
  expect(parseTicketKey("MTH-1")).toBe(1)
  expect(parseTicketKey("MTH-42")).toBe(42)
  expect(parseTicketKey("mth-100")).toBe(100)
  expect(parseTicketKey("INVALID")).toBeNull()
  expect(parseTicketKey("MTH-")).toBeNull()
  expect(parseTicketKey("")).toBeNull()
})
