import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, resetPersistenceForTests, findTaskById, persistManualCalendarConfirmation, commitSyncMutationChunks, findTasksByExternalSyncIds } from "../helpers/persistence-fixture"
import { ordinaryTask, syncFixture, syncMutation } from "../helpers/ordinary-sync-fixture"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { resolveIntegrationScope, validateIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"

let work: string, marker: string, previousDb: string | undefined
const tables = ["tasks", "calendar_confirmations", "integration_attempts", "domain_events", "audit_trail"]
async function records(db: ReturnType<typeof import("../helpers/persistence-fixture")["getPersistenceClient"]>) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows])))
}
test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "ordinary-continuity-sync-")); marker = join(work, "grants.json")
  previousDb = process.env.MEITHEAL_DB_URL; process.env.MEITHEAL_DB_URL = `file:${join(work, "tasks.db")}`
  await ensureSchema({ markerPath: marker })
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousDb
  await rm(work, { recursive: true, force: true })
})
test("healthy common store helpers retain confirmations; marker loss blocks reads and every writer", async () => {
  const { db, scope, context } = await syncFixture()
  const task = await ordinaryTask(scope, "Current task", "current-key")
  const input = { taskId: task.task.id, requestId: "manual-current", confirmationId: "provider-data" }
  const confirmed = await persistManualCalendarConfirmation(input, context)
  expect(confirmed.alreadyExisted).toBe(false)
  expect(await findTaskById(task.task.id, scope)).toMatchObject({ title: "Current task", calendarSyncState: "confirmed" })
  expect(await persistManualCalendarConfirmation(input, context)).toEqual({ ...confirmed, alreadyExisted: true })
  const before = await records(db)
  await rm(marker)
  for (const operation of [
    () => findTaskById(task.task.id, scope), () => ordinaryTask(scope, "New denied task"),
    () => ordinaryTask(scope, "Current task", "current-key"),
    () => persistManualCalendarConfirmation({ ...input, requestId: "denied-confirmation" }, context),
    () => commitSyncMutationChunks([syncMutation("Denied provider task")], context),
    () => findTasksByExternalSyncIds({ source: "calendar", entityId: "calendar.home", externalIds: ["provider-data"] }, context),
  ]) await expect(operation()).rejects.toBeTruthy()
  expect(await records(db)).toEqual(before)
})
test("a current binding must still be authorized at the provider dispatch boundary", async () => {
  const { db, context } = await syncFixture()
  expect((await validateIntegrationScope(context, db, { resource: "task", action: "edit" })).ok).toBe(true)
  await rm(marker)
  expect((await validateIntegrationScope(context, db, { resource: "task", action: "edit" })).ok).toBe(false)
})
for (const outcome of ["success", "retryable failure", "timeout"] as const) {
  test(`a previously admitted remote ${outcome} cannot commit after marker loss`, async () => {
    const { db, scope, context } = await syncFixture()
    const task = await ordinaryTask(scope, "Do not replace original title")
    let release!: () => void
    const provider = new Promise<void>(resolve => { release = resolve })
    // This explicitly exercises the current persistence boundary after an
    // external wait. Provider transport acceptance has its own HTTP suite.
    const completion = (async () => {
      await provider
      return commitSyncMutationChunks([{ kind: "update", taskId: task.task.id, title: "Denied remote result", confirmation: {
        source: "calendar", entityId: "calendar.home", externalId: "remote-result", payload: JSON.stringify({ outcome }),
      } }], context)
    })()
    const before = await records(db)
    await rm(marker); release()
    await expect(completion).rejects.toBeTruthy()
    expect(await records(db)).toEqual(before)
  })
}
test("a retired Board withholds replay, new imports and confirmation recording", async () => {
  const { db, scope, context, principal, binding } = await syncFixture()
  await ordinaryTask(scope, "Retained original", "replay-key")
  const retired = await new NamedBoardRepository(db).changeLifecycle(principal, "household", "retired", scope.boardRevision)
  expect(retired.status).toBe("committed")
  const before = await records(db)
  await expect(ordinaryTask(scope, "Retained original", "replay-key")).rejects.toBeTruthy()
  await expect(commitSyncMutationChunks([syncMutation("Denied retired import")], context)).rejects.toBeTruthy()
  expect((await resolveIntegrationScope(db, binding.id, 1, { resource: "task", action: "edit" })).ok).toBe(false)
  expect(await records(db)).toEqual(before)
})
test("a changed binding generation cannot redirect an in-flight import", async () => {
  const { db, context, config } = await syncFixture()
  await db.execute({ sql: "UPDATE settings SET value=? WHERE key='work-destinations'", args: [JSON.stringify({ ...config, revision: "replacement", bindings: config.bindings.map(binding => ({ ...binding, generation: 2 })) })] })
  const before = await records(db)
  await expect(commitSyncMutationChunks([syncMutation("Denied stale generation")], context)).rejects.toBeTruthy()
  expect(await records(db)).toEqual(before)
})
test("per-item savepoints roll back a failed task and confirmation without losing valid siblings", async () => {
  const { db, context, scope } = await syncFixture()
  const existing = await ordinaryTask(scope, "Existing row")
  const result = await commitSyncMutationChunks([syncMutation("Valid import"), { ...syncMutation("Duplicate physical task ID"), taskId: existing.task.id }, syncMutation("Second valid import")], context)
  expect(result).toMatchObject({ created: 2, errors: [{ index: 1, message: expect.any(String) }] })
  const tasks = await new TaskRepository(db, scope).findAll({})
  expect(tasks.total).toBe(3)
  expect(tasks.tasks.map(task => task.title)).not.toContain("Duplicate physical task ID")
  expect((await db.execute("SELECT COUNT(*) AS total FROM calendar_confirmations")).rows[0]?.total).toBe(2)
  expect((await db.execute("SELECT ticket_high_water FROM task_boards WHERE id='household'")).rows[0]?.ticket_high_water).toBe(3)
})
