import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test as base } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  getSchemaVersion,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { applyInboundTodoUpdate } from "../../apps/web/src/domains/todo/todo-inbound-update"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const actor = { id: "household-user", type: "human", requestId: "deferral-spec" } as const
const originalVersion = Date.parse("2026-11-09T20:30:00.123Z")
const initialGuard = { updatedAt: originalVersion, revision: null }
const revisionPattern = /^[a-f0-9]{32}$/

const test = base.extend<{ database: ReturnType<typeof getPersistenceClient> }>({
  database: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const dir = await mkdtemp(join(tmpdir(), "meitheal-deferral-"))
    process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
    resetPersistenceForTests()
    const client = getPersistenceClient()
    try {
      await use(client)
    } finally {
      client.close()
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(dir, { recursive: true, force: true })
    }
  },
})

async function seed(db: ReturnType<typeof getPersistenceClient>, id: string, status = "backlog") {
  await db.execute({
    sql: `INSERT INTO tasks (id, title, request_id, idempotency_key, status, due_date, kanban_position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '2026-12-01', 9, ?, ?)`,
    args: [id, id, id, id, status, originalVersion, "2026-11-09T21:30:00.123+01:00"],
  })
}

function migrate(...args: string[]) {
  return execFileSync(process.execPath, ["scripts/migrate.mjs", ...args], {
    cwd: web, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  })
}

test("runtime bootstrap and CLI converge without changing existing task rows", async ({ database: db }) => {
  await Promise.all([ensureSchema(), ensureSchema()])
  expect(getSchemaVersion()).toBe(17)
  await seed(db, "retained")
  expect(migrate()).toContain("Applied migration: 0004_task_deferral.mjs")
  expect(migrate("--check")).toContain("Migration check passed")
  expect((await new TaskRepository(db).findById("retained"))?.deferred_at).toBeNull()
})

test("runtime validates the CLI-first migration and rejects conflicting schema", async ({ database: db }) => {
  expect(migrate()).toContain("Applied migration: 0004_task_deferral.mjs")
  await ensureSchema()
  expect(getSchemaVersion()).toBe(17)
  await db.execute("DROP INDEX tasks_deferred_order_idx")
  await db.execute("CREATE INDEX tasks_deferred_order_idx ON tasks (deferred_at ASC, id ASC)")
  expect(() => migrate("--check")).toThrow(/Unexpected task deferral index/)
})

test("one concurrent deferral wins without moving the provider clock or duplicating audit", async ({ database: db }) => {
  await ensureSchema()
  await seed(db, "shared")
  const repo = new TaskRepository(db)
  const results = await Promise.all([
    repo.setDeferral("shared", true, initialGuard, actor),
    repo.setDeferral("shared", true, initialGuard, actor),
  ])
  const winner = results.find(result => result.ok)
  expect(results.filter(result => result.ok)).toHaveLength(1)
  expect(results.find(result => !result.ok)).toMatchObject({ errorCode: "conflict" })
  expect(winner?.task).toMatchObject({
    status: "backlog", updated_at: originalVersion, deferred_at: expect.any(Number), deferral_revision: expect.stringMatching(revisionPattern),
  })
  const state = winner!.task
  expect(await repo.findById("shared")).toMatchObject({
    due_date: "2026-12-01", updated_at: "2026-11-09T21:30:00.123+01:00", deferred_at: state.deferred_at,
  })
  expect((await db.execute("SELECT kanban_position FROM tasks WHERE id = 'shared'")).rows[0]?.kanban_position).toBe(9)
  expect(await repo.updateTask("shared", { status: "active" }, { version: { updatedAt: originalVersion, expectedStatus: "backlog" } }))
    .toEqual({ ok: false, errorCode: "conflict", updatedAt: originalVersion })
  const liveGuard = { updatedAt: originalVersion, revision: state.deferral_revision }
  expect(await repo.setDeferral("shared", true, liveGuard, actor)).toEqual(winner)
  const audit = await db.execute("SELECT field, old_value, new_value, actor, actor_type, correlation_id FROM task_activity_log")
  expect(audit.rows).toEqual([{
    field: "deferred_at", old_value: null, new_value: String(state.deferred_at),
    actor: actor.id, actor_type: actor.type, correlation_id: actor.requestId,
  }])
  expect(await repo.setDeferral("shared", false, liveGuard, actor)).toMatchObject({ ok: true, task: { deferred_at: null } })
  expect(await repo.setDeferral("shared", true, initialGuard, actor)).toMatchObject({ errorCode: "conflict" })
})

test("audit failure rolls back and raw workflow changes retire a deferral revision", async ({ database: db }) => {
  await ensureSchema()
  await seed(db, "edited")
  const repo = new TaskRepository(db)
  await db.execute(`CREATE TRIGGER reject_test_activity BEFORE INSERT ON task_activity_log
    BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`)
  await expect(repo.setDeferral("edited", true, initialGuard, actor)).rejects.toThrow(/test audit failure/)
  expect(await repo.findById("edited")).toMatchObject({ deferred_at: null, deferral_revision: null })
  await db.execute("DROP TRIGGER reject_test_activity")
  const deferred = await repo.setDeferral("edited", true, initialGuard, actor)
  expect(deferred.ok).toBe(true)
  if (!deferred.ok) throw new Error("Deferral failed")
  const guard = { updatedAt: originalVersion, revision: deferred.task.deferral_revision }
  await db.execute("UPDATE tasks SET status = 'ACTIVE' WHERE id = 'edited'")
  expect(await repo.setDeferral("edited", false, guard, actor)).toMatchObject({ errorCode: "conflict" })
  const active = await repo.findById("edited")
  expect(active?.deferred_at).toBe(deferred.task.deferred_at)
  expect(active?.deferral_revision).not.toBe(guard.revision)

  await seed(db, "dependency")
  await repo.createLink("link", "edited", "dependency", "blocked_by")
  const activeGuard = { updatedAt: originalVersion, revision: active!.deferral_revision }
  expect(await repo.setDeferral("edited", false, activeGuard, actor)).toMatchObject({
    errorCode: "blocked", blockers: [{ id: "dependency" }],
  })
  await db.execute("UPDATE tasks SET status = 'DONE' WHERE id = 'edited'")
  const done = await repo.findById("edited")
  expect(done).toMatchObject({ status: "DONE", deferred_at: null, deferral_revision: expect.stringMatching(revisionPattern) })
  expect(await repo.setDeferral("edited", true, { updatedAt: originalVersion, revision: done!.deferral_revision }, actor))
    .toMatchObject({ errorCode: "terminal" })
  await db.execute("UPDATE tasks SET status = 'pending' WHERE id = 'edited'")
  expect(await repo.findById("edited")).toMatchObject({ status: "pending", deferred_at: null, deferral_revision: expect.stringMatching(revisionPattern) })
  expect((await db.execute("SELECT id FROM task_activity_log")).rows).toHaveLength(1)
})

test("linked HA sync preserves deferred workflow on an open echo and commits completion with confirmation", async ({ database: db }) => {
  migrate()
  await ensureSchema()
  await seed(db, "linked", "backlog")
  const repo = new TaskRepository(db)
  const deferred = await repo.setDeferral("linked", true, initialGuard, actor)
  expect(deferred.ok).toBe(true)
  if (!deferred.ok) throw new Error("Deferral failed")
  const inbound = {
    confirmationId: "confirmation", taskId: "linked", entityId: "todo.house", uid: "remote",
    title: "Remote title", status: "pending", openEcho: true, due: null, description: null, payload: "open",
  } as const
  await db.execute({
    sql: `INSERT INTO todo_sync_confirmations
            (confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid, created_at, updated_at)
          VALUES (?, ?, 'test', ?, ?, ?, ?)`,
    args: [inbound.confirmationId, inbound.taskId, inbound.entityId, inbound.uid, originalVersion, originalVersion - 1],
  })
  expect(await applyInboundTodoUpdate(db, inbound)).toBe(false)
  expect(await repo.findById("linked")).toMatchObject({ title: "linked", deferred_at: deferred.task.deferred_at })
  await db.execute({ sql: "UPDATE todo_sync_confirmations SET updated_at = ?", args: [originalVersion] })
  expect(await applyInboundTodoUpdate(db, inbound)).toBe(true)
  const echoed = await repo.findById("linked")
  expect(echoed).toMatchObject({ status: "backlog", deferred_at: deferred.task.deferred_at, title: inbound.title })
  expect(echoed?.updated_at).toBeGreaterThan(originalVersion)

  await db.execute(`CREATE TRIGGER reject_test_confirmation BEFORE UPDATE ON todo_sync_confirmations
    BEGIN SELECT RAISE(ABORT, 'test confirmation failure'); END`)
  const completion = { ...inbound, status: "complete", openEcho: false, payload: "completed" } as const
  await expect(applyInboundTodoUpdate(db, completion)).rejects.toThrow(/test confirmation failure/)
  expect(await repo.findById("linked")).toMatchObject({
    status: "backlog", deferred_at: echoed?.deferred_at, updated_at: echoed?.updated_at,
  })
  await db.execute("DROP TRIGGER reject_test_confirmation")
  expect(await applyInboundTodoUpdate(db, completion)).toBe(true)
  const completed = await repo.findById("linked")
  expect(completed).toMatchObject({ status: "complete", deferred_at: null })
  expect(completed?.deferral_revision).not.toBe(echoed?.deferral_revision)
  expect((await db.execute("SELECT payload, updated_at FROM todo_sync_confirmations")).rows[0]).toMatchObject({
    payload: "completed", updated_at: completed?.updated_at,
  })
  expect(await applyInboundTodoUpdate(db, inbound)).toBe(true)
  expect(await repo.findById("linked")).toMatchObject({ status: "pending", deferred_at: null })
})

test("bulk reorder preserves hidden slots and never regresses the submitted workflow clock", async ({ database: db }) => {
  await ensureSchema()
  const repo = new TaskRepository(db)
  for (const id of ["left", "hidden", "right"]) await seed(db, id)
  await db.execute("UPDATE tasks SET kanban_position = CASE id WHEN 'left' THEN 1 WHEN 'hidden' THEN 2 ELSE 3 END")
  expect(await repo.setDeferral("hidden", true, initialGuard, actor)).toMatchObject({ ok: true })
  const clock = Date.now
  try {
    Date.now = () => originalVersion
    expect(await repo.updateTask("left", { title: "edited with frozen clock" })).toMatchObject({
      ok: true, task: { updated_at: originalVersion + 1 },
    })
    expect(await repo.reorderTasks(["right", "left"])).toBe(true)
    expect(await repo.setDeferral("left", true, initialGuard, actor)).toMatchObject({ errorCode: "conflict" })
  } finally {
    Date.now = clock
  }
  const rows = (await db.execute("SELECT id, updated_at FROM tasks ORDER BY kanban_position")).rows
  expect(rows.map(row => row.id)).toEqual(["right", "hidden", "left"])
  expect(rows[1]?.updated_at).toBe("2026-11-09T21:30:00.123+01:00")
  expect(rows[2]?.updated_at).toBe(originalVersion + 2)
})

test("project active counts cover rows beyond the previous 500-task limit", async ({ database: db }) => {
  await ensureSchema()
  await db.execute(`
    WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 501)
    INSERT INTO tasks (id, title, status, project_id, request_id, idempotency_key, created_at, updated_at, deferred_at)
    SELECT 't' || n, 'test', 'pending', 'counts', 'r' || n, 'i' || n, n, n, CASE WHEN n > 1 THEN n ELSE NULL END FROM seq
  `)
  const repo = new HierarchyRepository(db)
  expect(await repo.getProjectTaskCounts("counts")).toEqual({ active_open: 1, total: 501, complete: 0 })
  await db.execute("UPDATE tasks SET status = 'complete' WHERE id = 't1'")
  expect(await repo.getProjectTaskCounts("counts")).toEqual({ active_open: 0, total: 501, complete: 1 })
})
