import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"

test("Backlog page clamps its range and orders current and legacy tasks in one read", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-intake-query-"))
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(work, "tasks.db")}`
  resetPersistenceForTests()
  const client = getPersistenceClient()
  const repo = new TaskRepository(client)
  const start = Date.parse("2026-11-09T20:30:00Z")
  async function add(id: string, created: number | string, status = "backlog") {
    await client.execute({
      sql: `INSERT INTO tasks (id, title, request_id, idempotency_key, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, id, id, id, status, created, created],
    })
  }
  try {
    await ensureSchema()
    expect(await repo.findBacklogPage(99)).toEqual({ page: 1, total: 0, tasks: [] })
    await add("numeric-b", start)
    await add("numeric-a", start)
    await add("legacy", "2026-11-09T21:29:59.123+01:00")
    await add("invalid", "2026-02-31")
    await add("pending", start - 2000, "pending")
    for (let index = 0; index < 23; index++) await add(`later-${index}`, start + index + 1)
    const first = await repo.findBacklogPage(0)
    expect(first).toMatchObject({ page: 1, total: 27 })
    expect(first.tasks).toHaveLength(25)
    expect(first.tasks.slice(0, 4).map(task => task.id)).toEqual(["invalid", "legacy", "numeric-a", "numeric-b"])
    expect(first.tasks[1]?.updated_at).toBe(start - 877)
    const last = await repo.findBacklogPage(Number.MAX_SAFE_INTEGER)
    expect(last).toMatchObject({ page: 2, total: 27 })
    expect(last.tasks.map(task => task.id)).toEqual(["later-21", "later-22"])
    await repo.updateTask("later-21", { status: "pending" })
    await repo.updateTask("later-22", { status: "pending" })
    const clamped = await repo.findBacklogPage(2)
    expect(clamped).toMatchObject({ page: 1, total: 25 })
    expect(clamped.tasks).toHaveLength(25)
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(work, { recursive: true, force: true })
  }
})
