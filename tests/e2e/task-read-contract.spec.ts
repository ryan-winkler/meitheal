import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { GET as listTasks, POST as createTask } from "../../apps/web/src/pages/api/tasks/index"
import { GET as getTask, PUT as updateTask } from "../../apps/web/src/pages/api/tasks/[id]"

type Database = ReturnType<typeof getPersistenceClient>
const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const work = await mkdtemp(join(tmpdir(), "meitheal-task-read-contract-"))
    process.env.MEITHEAL_DB_URL = `file:${join(work, "tasks.db")}`
    resetPersistenceForTests()
    const db = getPersistenceClient()
    try {
      await ensureSchema()
      await use(db)
    } finally {
      db.close()
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(work, { recursive: true, force: true })
    }
  },
})

async function seed(db: Database, id: string, position: number | null = null, created = 1) {
  await db.execute({
    sql: `INSERT INTO tasks (id, title, description, request_id, idempotency_key, created_at, updated_at, kanban_position)
          VALUES (?, ?, 'Saved description', ?, ?, ?, ?, ?)`,
    args: [id, id, id, id, created, created, position],
  })
}

function list(query = "") {
  return listTasks({ url: new URL(`http://localhost/api/tasks?${query}`) } as Parameters<typeof listTasks>[0])
}

function detail(id: string) {
  return getTask({ params: { id }, url: new URL(`http://localhost/api/tasks/${id}`) } as unknown as Parameters<typeof getTask>[0])
}

function write(body: unknown, id?: string) {
  const request = new Request(`http://localhost/api/tasks${id ? `/${id}` : ""}`, {
    method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })
  return id
    ? updateTask({ params: { id }, request, locals: {} } as unknown as Parameters<typeof updateTask>[0])
    : createTask({ request, locals: {} } as unknown as Parameters<typeof createTask>[0])
}

test("stored planning, effort, NFC and ordering fields survive canonical reads", async ({ db }) => {
  await seed(db, "saved", 2.5)
  await seed(db, "defaults")
  await db.execute({
    sql: `UPDATE tasks SET urgency = 0, importance = 5, eisenhower_override = 1,
          effort_minutes = 45, effort_type = 'deep', blocked_by = 'waiting for delivery', nfc_tag_id = 'fixture-tag' WHERE id = 'saved'`,
    args: [],
  })
  const expected = {
    id: "saved", urgency: 0, importance: 5, eisenhower_override: 1,
    effort_minutes: 45, effort_type: "deep", blocked_by: "waiting for delivery", nfc_tag_id: "fixture-tag", kanban_position: 2.5,
  }
  const repo = new TaskRepository(db)
  expect(await repo.findById("saved")).toMatchObject(expected)
  expect((await repo.findAll({})).tasks).toEqual(expect.arrayContaining([expect.objectContaining(expected)]))
  expect(await repo.getKanbanCards(["saved"], 0, db)).toEqual([expect.objectContaining(expected)])
  expect(await (await detail("saved")).json()).toMatchObject(expected)
  const response = await list("sort=kanban_position&order=asc&limit=100&offset=0")
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.tasks).toEqual(expect.arrayContaining([expect.objectContaining(expected), expect.objectContaining({
    id: "defaults", urgency: 0, importance: 0, eisenhower_override: 0,
    effort_minutes: null, effort_type: null, blocked_by: null, nfc_tag_id: null, kanban_position: null,
  })]))
})

test("native board-position sorting has stable ID ties, nulls last and consistent pagination", async ({ db }) => {
  // Insert out of ID and board order, with creation timestamps contradicting both.
  for (const [id, position, created] of [["e", null, 500], ["b", 2, 400], ["c", 1, 300], ["d", null, 200], ["a", 2, 100]] as const) {
    await seed(db, id, position, created)
  }
  for (const [order, ids] of [["asc", ["c", "a", "b", "d", "e"]], ["desc", ["a", "b", "c", "d", "e"]]] as const) {
    const body = await (await list(`sort=kanban_position&order=${order}&limit=100&offset=0`)).json()
    expect(body.tasks.map((row: { id: string }) => row.id)).toEqual(ids)
    expect(body).toMatchObject({ total: 5, limit: 100, offset: 0 })
  }
  const page = await (await list("sort=kanban_position&order=asc&limit=2&offset=1")).json()
  expect(page.tasks.map((row: { id: string }) => row.id)).toEqual(["a", "b"])
  expect(page).toMatchObject({ total: 5, limit: 2, offset: 1 })
})

test("task creation rejects oversized descriptions and stores the exact accepted boundary", async ({ db }) => {
  const tooLong = await write({ title: "Too long", description: "x".repeat(10001) })
  expect(tooLong.status).toBe(400)
  expect(await tooLong.json()).toEqual({ error: "description must be 10000 characters or less" })
  expect((await db.execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count).toBe(0)
  const description = "x".repeat(10000)
  const accepted = await write({ title: "Boundary", description })
  expect(accepted.status).toBe(201)
  const task = await accepted.json()
  expect(task.description).toBe(description)
  expect(await (await detail(task.id)).json()).toMatchObject({ title: "Boundary", description })
})

test("an oversized description rejects the entire update without losing prior text or version", async ({ db }) => {
  await seed(db, "preserve")
  const repo = new TaskRepository(db)
  const before = await repo.findById("preserve")
  const rejected = await write({ title: "Must not save", description: "x".repeat(10001) }, "preserve")
  expect(rejected.status).toBe(400)
  expect(await rejected.json()).toMatchObject({ error: "description must be 10000 characters or less", status: 400 })
  expect(await repo.findById("preserve")).toEqual(before)
  const description = "y".repeat(10000)
  expect((await write({ description }, "preserve")).status).toBe(200)
  expect(await (await detail("preserve")).json()).toMatchObject({ title: "preserve", description })
})
