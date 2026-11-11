import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import {
  ensureSchema, getPersistenceClient, resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { GET } from "../../apps/web/src/pages/api/tasks/index"

type Database = ReturnType<typeof getPersistenceClient>

const scores = [
  { id: "a-do-first", urgency: 3, importance: 5, eisenhower_override: 1, eisenhower_quadrant: "do-first" },
  { id: "b-schedule", urgency: 2, importance: 3, eisenhower_override: 0, eisenhower_quadrant: "schedule" },
  { id: "c-delegate", urgency: 4, importance: 2, eisenhower_override: 1, eisenhower_quadrant: "delegate" },
  { id: "d-not-now", urgency: 1, importance: 2, eisenhower_override: 0, eisenhower_quadrant: "not-now" },
  { id: "e-defaults", urgency: 0, importance: 0, eisenhower_override: 0, eisenhower_quadrant: "not-now" },
]

const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const work = await mkdtemp(join(tmpdir(), "meitheal-task-list-eisenhower-"))
    process.env.MEITHEAL_DB_URL = `file:${join(work, "tasks.db")}`
    resetPersistenceForTests()
    const db = getPersistenceClient()
    try {
      await ensureSchema()
      for (const row of scores) {
        await db.execute({
          sql: `INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, 1, 1)`,
          args: [row.id, row.id, row.id, row.id],
        })
        // Leave the last row's NOT NULL columns at their actual schema defaults.
        if (row.id !== "e-defaults") {
          await db.execute({
            sql: "UPDATE tasks SET urgency = ?, importance = ?, eisenhower_override = ? WHERE id = ?",
            args: [row.urgency, row.importance, row.eisenhower_override, row.id],
          })
        }
      }
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

test("findAll preserves stored Eisenhower scores, overrides, and schema defaults", async ({ db }) => {
  const { tasks, total } = await new TaskRepository(db).findAll({ sort: "title", order: "ASC" })
  expect(total).toBe(scores.length)
  expect(tasks.map(({ id, urgency, importance, eisenhower_override }) => ({
    id, urgency, importance, eisenhower_override,
  }))).toEqual(scores.map(({ eisenhower_quadrant, ...row }) => row))
})

test("task list API derives each quadrant from stored scores across pages", async ({ db }) => {
  expect(db.closed).toBe(false)
  for (let offset = 0; offset < scores.length; offset += 2) {
    const response = await GET({
      url: new URL(`http://localhost/api/tasks?sort=title&order=asc&limit=2&offset=${offset}`),
    } as Parameters<typeof GET>[0])
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ total: scores.length, limit: 2, offset })
    expect(body.tasks).toHaveLength(scores.slice(offset, offset + 2).length)
    expect(body.tasks).toEqual(scores.slice(offset, offset + 2).map(row => expect.objectContaining(row)))
  }
})
