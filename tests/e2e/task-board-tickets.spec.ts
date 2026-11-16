import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { applyTaskDeferralMigration } from "../../apps/web/drizzle/migrations/0004_task_deferral.mjs"
import { applyTaskBoardStorage } from "../../apps/web/drizzle/migrations/0009_task_boards.mjs"
import {
  applyTaskBoardTicketAllocator,
  nextHouseholdTicketNumberSql,
  taskBoardTicketTriggerNames,
  validateTaskBoardTicketAllocator,
} from "../../apps/web/drizzle/migrations/task-board-tickets.mjs"
import { reconcileTaskSchemaPrerequisites } from "../../apps/web/drizzle/migrations/task-schema-prerequisites.mjs"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"

type Client = ReturnType<typeof openDatabase>

const baseSchema = await readFile(new URL("../../apps/web/drizzle/migrations/0000_iteration2_init.sql", import.meta.url), "utf8")
const test = base.extend<{ ticketDb: { db: Client, url: string } }>({
  ticketDb: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-board-tickets-"))
    const url = `file:${join(directory, "meitheal.db")}`
    const db = openDatabase(url)
    try {
      await db.execute("PRAGMA journal_mode = WAL")
      await db.executeMultiple(baseSchema)
      await reconcileTaskSchemaPrerequisites(db)
      const upgrade = await db.transaction("write")
      try {
        await applyTaskDeferralMigration(upgrade)
        await applyTaskBoardStorage(upgrade)
        await upgrade.commit()
      } finally {
        upgrade.close()
      }
      await use({ db, url })
    } finally {
      db.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
})

async function install(db: Client) {
  const migration = await db.transaction("write")
  try {
    await applyTaskBoardTicketAllocator(migration)
    await migration.commit()
  } finally {
    migration.close()
  }
}

async function highWater(db: Pick<Client, "execute">) {
  const { rows: [board] } = await db.execute("SELECT ticket_high_water FROM task_boards WHERE id = 'household'")
  return board?.ticket_high_water
}

function legacyTask(id: string, number: number | bigint | string | null) {
  return {
    sql: `INSERT INTO tasks (id, title, idempotency_key, request_id, ticket_number, created_at, updated_at)
      VALUES (?, 'Ticket fixture', ?, 'fixture', ?, 1, 1)`,
    args: [id, id, number],
  }
}

function createTask(id: string, allowed = true) {
  return {
    sql: `INSERT INTO tasks (id, title, idempotency_key, request_id, ticket_number, created_at, updated_at)
      SELECT ?, 'Ticket fixture', ?, 'fixture', ${nextHouseholdTicketNumberSql}, 1, 1
      WHERE ? RETURNING ticket_number`,
    args: [id, id, allowed],
  }
}

function assignTicket(id: string) {
  return {
    sql: `UPDATE tasks SET ticket_number = ${nextHouseholdTicketNumberSql}
      WHERE id = ? AND task_board_id IS NULL AND ticket_number IS NULL RETURNING ticket_number`,
    args: [id],
  }
}

function event(id: string, payload: string, type = "task.created") {
  return {
    sql: `INSERT INTO domain_events (event_id, event_type, task_id, request_id, idempotency_key, payload, created_at)
      VALUES (?, ?, 'deleted-task', 'fixture', ?, ?, 1)`,
    args: [id, type, id, payload],
  }
}

for (const [label, evidence] of [["integer", '{"ticket_number":71}'], ["canonical key", '{"ticket_key":"MTH-71"}']] as const) {
  test(`Household seed accepts retained ${label} evidence and ignores malformed or unsafe values`, async ({ ticketDb: { db } }) => {
    await db.batch([
      legacyTask("legacy", 35),
      legacyTask("unsafe", 9007199254740993n),
      legacyTask("non-integer", 9000.125),
      legacyTask("text", "9000tail"),
      event("retained", evidence),
      event("malformed", '{"ticket_number":9999'),
      event("string", '{"ticket_number":"9999"}'),
      event("fraction", '{"ticket_number":9999.5}'),
      event("unsafe-number", '{"ticket_number":9007199254740992}'),
      event("outside-sqlite", '{"ticket_number":99999999999999999999}'),
      event("unsafe-key", '{"ticket_key":"MTH-9007199254740992"}'),
      event("lower-case", '{"ticket_key":"mth-9999"}'),
      event("leading-zero", '{"ticket_key":"MTH-09999"}'),
      event("plus-sign", '{"ticket_key":"MTH-+9999"}'),
      event("suffix", '{"ticket_key":"MTH-9999tail"}'),
      event("null-byte", JSON.stringify({ ticket_key: "MTH-9999\u0000" })),
      event("other-event", '{"ticket_number":9999}', "task.updated"),
    ], "write")

    await install(db)
    expect(await highWater(db)).toBe(71)
    const created = await db.execute(createTask("first"))
    expect(created.rows).toEqual([{ ticket_number: 72 }])
    expect(await highWater(db)).toBe(72)
    expect((await db.execute("SELECT CAST(ticket_number AS TEXT) AS number FROM tasks WHERE id = 'unsafe'")).rows)
      .toEqual([{ number: "9007199254740993" }])
  })
}

test("boolean creation-event values do not consume a Household ticket", async ({ ticketDb: { db } }) => {
  await db.batch([
    event("true", '{"ticket_number":true}'),
    event("false", '{"ticket_number":false}'),
  ], "write")
  await install(db)
  expect((await db.execute(createTask("first"))).rows).toEqual([{ ticket_number: 1 }])
})

test("Household allocator preserves the counter across rollback, deletion and restart", async ({ ticketDb: { db, url } }) => {
  await db.execute(legacyTask("legacy", 19))
  const migration = await db.transaction("write")
  try {
    await applyTaskBoardTicketAllocator(migration)
    expect(await highWater(migration)).toBe(19)
    await migration.rollback()
  } finally {
    migration.close()
  }
  expect(await highWater(db)).toBe(0)
  await expect(validateTaskBoardTicketAllocator(db)).rejects.toThrow(/Unexpected Household ticket trigger/)

  await install(db)
  await db.execute("DELETE FROM tasks WHERE id = 'legacy'")
  await expect(db.execute(legacyTask("reused", 19))).rejects.toThrow(/Expected the next Household ticket number/)

  const writer = await db.transaction("write")
  try {
    expect((await writer.execute(createTask("rolled-back"))).rows).toEqual([{ ticket_number: 20 }])
    expect(await highWater(writer)).toBe(20)
    await writer.rollback()
  } finally {
    writer.close()
  }
  expect(await highWater(db)).toBe(19)
  db.close()

  const reopened = openDatabase(url)
  try {
    await validateTaskBoardTicketAllocator(reopened)
    expect((await reopened.execute(createTask("committed"))).rows).toEqual([{ ticket_number: 20 }])
    await reopened.execute(legacyTask("unnumbered", null))
    expect(await highWater(reopened)).toBe(20)
    expect((await reopened.execute(assignTicket("unnumbered"))).rows).toEqual([{ ticket_number: 21 }])
    expect((await reopened.execute(assignTicket("unnumbered"))).rows).toEqual([])
    expect(await highWater(reopened)).toBe(21)
  } finally {
    reopened.close()
  }
})

test("the final safe ticket returns and guarded zero-row writes still succeed after exhaustion", async ({ ticketDb: { db } }) => {
  await db.batch([
    legacyTask("unnumbered", null),
    event("near-limit", '{"ticket_key":"MTH-9007199254740990"}'),
  ], "write")
  await install(db)
  expect((await db.execute(createTask("last"))).rows).toEqual([{ ticket_number: Number.MAX_SAFE_INTEGER }])
  expect((await db.execute(createTask("no-draft", false))).rows).toEqual([])
  expect((await db.execute(assignTicket("missing"))).rows).toEqual([])
  await expect(db.execute(createTask("overflow"))).rejects.toThrow(/Household ticket number limit reached/)
  await expect(db.execute(assignTicket("unnumbered"))).rejects.toThrow(/Household ticket number limit reached/)
  expect(await highWater(db)).toBe(Number.MAX_SAFE_INTEGER)
  expect((await db.execute("SELECT id, ticket_number FROM tasks ORDER BY id")).rows).toEqual([
    { id: "last", ticket_number: Number.MAX_SAFE_INTEGER }, { id: "unnumbered", ticket_number: null },
  ])
})

test("competing SQLite writers cannot consume the same Household ticket", async ({ ticketDb: { db, url } }) => {
  await install(db)
  const competitor = openDatabase(url)
  try {
    const writer = await db.transaction("write")
    try {
      expect((await writer.execute(createTask("first"))).rows).toEqual([{ ticket_number: 1 }])
      expect(await highWater(competitor)).toBe(0)
      await expect(competitor.execute(createTask("second"))).rejects.toMatchObject({ code: "SQLITE_BUSY" })
      await writer.commit()
    } finally {
      writer.close()
    }
    expect((await competitor.execute(createTask("second"))).rows).toEqual([{ ticket_number: 2 }])
    expect(await highWater(db)).toBe(2)
  } finally {
    competitor.close()
  }
})

test("a suppressed counter update rolls back the task write", async ({ ticketDb: { db } }) => {
  await install(db)
  await db.execute(`CREATE TRIGGER installed_ticket_guard BEFORE UPDATE OF ticket_high_water ON task_boards
    BEGIN SELECT RAISE(IGNORE); END`)
  await expect(db.execute(createTask("blocked"))).rejects.toThrow(/high-water did not advance/)
  expect(await highWater(db)).toBe(0)
  expect((await db.execute("SELECT id FROM tasks")).rows).toEqual([])
})

test("Household validation rejects stale counters and altered triggers", async ({ ticketDb: { db } }) => {
  await db.execute(event("retained-deleted", '{"ticket_number":19}'))
  await install(db)
  await validateTaskBoardTicketAllocator(db)
  const reset = "UPDATE task_boards SET ticket_high_water = 0 WHERE id = 'household'"
  await expect(db.execute(reset)).rejects.toThrow(/high-water cannot decrease/)
  await expect(db.execute(`INSERT OR REPLACE INTO task_boards
    (id, name, ticket_prefix, ticket_high_water, created_at, updated_at)
    VALUES ('household', 'Household', 'MTH', 0, 1, 1)`)).rejects.toThrow(/high-water cannot decrease/)
  const damaged = await db.transaction("write")
  try {
    await damaged.execute("DROP TRIGGER task_boards_ticket_high_water_guard")
    await damaged.execute(reset)
    await expect(validateTaskBoardTicketAllocator(damaged)).rejects.toThrow(/Invalid Household ticket high-water mark/)
  } finally {
    await damaged.rollback()
    damaged.close()
  }
  const [trigger] = taskBoardTicketTriggerNames
  await db.execute(`DROP TRIGGER ${trigger}`)
  await db.execute(`CREATE TRIGGER ${trigger} AFTER INSERT ON tasks BEGIN SELECT 1; END`)
  await expect(validateTaskBoardTicketAllocator(db)).rejects.toThrow(/Unexpected Household ticket trigger/)
})
