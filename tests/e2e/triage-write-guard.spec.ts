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

test("an intake decision uses the live version and status inside the write transaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meitheal-intake-write-"))
  const dbUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
  resetPersistenceForTests()
  const client = getPersistenceClient()
  const repo = new TaskRepository(client)
  const clock = Date.now
  const now = Date.parse("2026-11-09T20:30:00.123Z")

  async function add(id: string, version: number | string = now, parent: string | null = null) {
    await client.execute({
      sql: `INSERT INTO tasks (id, title, request_id, idempotency_key, status, created_at, updated_at, parent_id)
            VALUES (?, ?, ?, ?, 'backlog', ?, ?, ?)`,
      args: [id, id, id, id, now, version, parent],
    })
  }

  try {
    await ensureSchema()
    Date.now = () => now
    const guard = { updatedAt: now, expectedStatus: "backlog" } as const

    await add("concurrent")
    const competing = await Promise.all([
      repo.updateTask("concurrent", { status: "pending", title: "first choice" }, { version: guard }),
      repo.updateTask("concurrent", { status: "active", title: "second choice" }, { version: guard }),
    ])
    const winner = competing.find(item => item.ok)
    expect(competing.filter(item => item.ok)).toHaveLength(1)
    expect(competing.find(item => !item.ok)).toEqual({ ok: false, errorCode: "conflict", updatedAt: now + 1 })
    expect(await repo.findById("concurrent")).toMatchObject({
      title: winner?.task.title, status: winner?.task.status, updated_at: now + 1,
    })

    await add("legacy", "2026-11-09T21:30:00.123+01:00")
    expect(await repo.resolveTaskId("legacy")).toMatchObject({ updated_at: now })
    await expect(repo.updateTask("legacy", { status: "pending" }, { version: guard })).resolves.toMatchObject({
      ok: true, task: { status: "pending", updated_at: now + 1 },
    })

    for (const [id, stamp] of [["invalid-day", "2026-02-31"], ["invalid-keyword", "now"]] as const) {
      await add(id, stamp)
      expect(await repo.resolveTaskId(id)).toMatchObject({ updated_at: 0 })
    }

    await add("blocked")
    await add("prerequisite")
    await repo.createLink("depends", "blocked", "prerequisite", "blocked_by")
    await expect(repo.updateTask("blocked", { title: "another session" })).resolves.toMatchObject({ ok: true })
    await expect(repo.updateTask("blocked", { status: "active" }, { version: guard })).resolves.toEqual({
      ok: false, errorCode: "conflict", updatedAt: now + 1,
    })
    await expect(repo.updateTask("blocked", { status: "active" }, { version: { ...guard, updatedAt: now + 1 } })).resolves.toMatchObject({
      ok: false, errorCode: "blocked", blockers: [{ id: "prerequisite" }],
    })
    expect(await repo.findById("blocked")).toMatchObject({ title: "another session", status: "backlog" })

    await add("combined-guards")
    const updatedChecklist = JSON.stringify([{ text: "Check the latch", done: true }])
    await expect(repo.updateTask("combined-guards", {
      status: "pending", checklists: updatedChecklist,
    }, { version: guard, expectedChecklists: updatedChecklist })).resolves.toEqual({
      ok: false, errorCode: "checklist_conflict", checklists: "[]",
    })
    expect(await repo.findById("combined-guards")).toMatchObject({ status: "backlog", updated_at: now, checklists: "[]" })
    await expect(repo.updateTask("combined-guards", {
      status: "pending", checklists: updatedChecklist,
    }, { version: guard, expectedChecklists: "[]" })).resolves.toMatchObject({
      ok: true, task: { status: "pending", updated_at: now + 1, checklists: updatedChecklist },
    })

    await add("parent")
    await add("child", now, "parent")
    expect(await repo.cascadeComplete("parent")).toBe(1)
    expect(await repo.findById("child")).toMatchObject({ updated_at: now, status: "complete" })
    await expect(repo.updateTask("child", { status: "pending" }, { version: guard })).resolves.toEqual({
      ok: false, errorCode: "conflict", updatedAt: now,
    })

    const lastVersion = Number.MAX_SAFE_INTEGER
    await add("last-version", lastVersion - 1)
    await expect(repo.updateTask("last-version", { title: "last safe write" }, { version: { updatedAt: lastVersion - 1 } }))
      .resolves.toMatchObject({ ok: true, task: { updated_at: lastVersion } })
    expect(await repo.resolveTaskId("last-version")).toMatchObject({ updated_at: lastVersion })
    await expect(repo.updateTask("last-version", { status: "pending" }, { version: { ...guard, updatedAt: lastVersion } }))
      .resolves.toEqual({ ok: false, errorCode: "conflict", updatedAt: lastVersion })
    expect(await repo.findById("last-version")).toMatchObject({ status: "backlog" })

    await add("future")
    await expect(repo.updateTask("future", { status: "pending" }, { version: { ...guard, updatedAt: now + 100 } })).resolves.toEqual({
      ok: false, errorCode: "conflict", updatedAt: now,
    })
    await expect(repo.updateTask("future", { title: "legacy future version" }, { version: { updatedAt: now + 100 } })).resolves.toMatchObject({ ok: true })
    await expect(repo.updateTask("missing", { status: "pending" }, { version: guard })).resolves.toEqual({
      ok: false, errorCode: "unavailable",
    })
    await add("project")
    await expect(repo.updateTask("project", { project_id: "missing-project" }, { version: guard })).resolves.toEqual({
      ok: false, errorCode: "unavailable",
    })
  } finally {
    Date.now = clock
    resetPersistenceForTests()
    if (dbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = dbUrl
    await rm(dir, { recursive: true, force: true })
  }
})
