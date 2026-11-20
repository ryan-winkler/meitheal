import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, resetPersistenceForTests, commitSyncMutationChunks, findTasksByExternalSyncIds, persistManualCalendarConfirmation } from "../helpers/persistence-fixture"
import { ordinaryTask, syncFixture, syncMutation } from "../helpers/ordinary-sync-fixture"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"

let work: string, previousUrl: string | undefined

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "ordinary-task-sync-")); previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(work, "tasks.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(work, { recursive: true, force: true })
})
test("provider import commits rich task, scoped ticket and bound confirmation atomically", async () => {
  const { db, context, scope, binding } = await syncFixture()
  const result = await commitSyncMutationChunks([syncMutation("Pay bills")], context)
  expect(result).toMatchObject({ created: 1, errors: [] })
  const matches = await findTasksByExternalSyncIds({ source: "calendar", entityId: "calendar.home", externalIds: ["provider-Pay bills"] }, context)
  const task = await new TaskRepository(db, scope).findById(matches.get("provider-Pay bills")!.taskId)
  expect(task).toMatchObject({ title: "Pay bills", task_kind: "calendar_event", calendar_sync_state: "synced", ticket_number: 1 })
  expect((await db.execute("SELECT binding_id FROM calendar_confirmations")).rows).toEqual([{ binding_id: binding.id }])
})
test("manual Board management retains readable existing provider references without becoming task mutation authority", async () => {
  const { db, context, binding, principal } = await syncFixture()
  expect(await commitSyncMutationChunks([syncMutation("An existing manual-sync event", "manual-existing")], context)).toMatchObject({ created: 1 })
  const manager = await new BoardAccessService(db).resolve(principal, binding.destination.boardId, { resource: "board", action: "manage" })
  if (!manager.ok) throw new Error(manager.errorCode)
  const manual = await resolveIntegrationScope(db, binding.id, binding.generation, { resource: "task", action: "read" }, manager.scope, { resource: "board", action: "manage" })
  if (!manual.ok) throw new Error(manual.errorCode)
  const matches = await findTasksByExternalSyncIds({ source: "calendar", entityId: binding.sourceId, externalIds: ["provider-manual-existing"] }, manual.value)
  const existing = matches.get("provider-manual-existing")!
  expect(existing.taskId).toBeTruthy()
  expect(existing.suppressed).not.toBe(true)
  const service = new TaskRepository(db, manual.value.scope)
  expect(await service.findSyncConfirmation(existing.taskId, manual.value)).toMatchObject({ confirmation: { confirmationId: existing.confirmationId, externalId: "provider-manual-existing" } })
  expect((await service.listCalendarSyncReferences(manual.value, binding.sourceId)).map(ref => ref.taskId)).toEqual([existing.taskId])
})
test("same-owner retry creates one task and does not allocate another ticket", async () => {
  const { db, scope } = await syncFixture()
  const first = await ordinaryTask(scope, "Idempotent task", "same-client-key")
  const second = await ordinaryTask(scope, "Idempotent task", "same-client-key")
  expect(second).toMatchObject({ replayed: true, task: { id: first.task.id }, ticketNumber: first.ticketNumber })
  expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(1)
  expect((await db.execute("SELECT ticket_high_water FROM task_boards WHERE id='household'")).rows[0]?.ticket_high_water).toBe(1)
})
test("the current provider UID deduplicates different transport keys before allocating a task or ticket", async () => {
  const { db, context } = await syncFixture()
  const original = syncMutation("One provider occurrence", "first-transport")
  expect(await commitSyncMutationChunks([original], context)).toMatchObject({ created: 1 })
  const duplicate = { ...syncMutation("Do not replace the existing body", "second-transport"), confirmation: original.confirmation }
  expect(await commitSyncMutationChunks([duplicate], context)).toMatchObject({ created: 0, skipped: 1, errors: [], ticketNumbers: [] })
  const race = syncMutation("Concurrent occurrence", "race-one")
  const results = await Promise.all([
    commitSyncMutationChunks([race], context),
    commitSyncMutationChunks([{ ...race, idempotencyKey: "race-two" }], context),
  ])
  expect(results.reduce((total, result) => total + result.created, 0)).toBe(1)
  expect(results.reduce((total, result) => total + result.skipped, 0)).toBe(1)
  expect((await db.execute("SELECT title,ticket_number FROM tasks ORDER BY ticket_number")).rows).toEqual([
    { title: "One provider occurrence", ticket_number: 1 }, { title: "Concurrent occurrence", ticket_number: 2 },
  ])
  expect((await db.execute("SELECT count(*) AS n FROM calendar_confirmations")).rows[0]?.n).toBe(2)
  expect((await db.execute("SELECT ticket_high_water FROM task_boards WHERE id='household'")).rows[0]?.ticket_high_water).toBe(2)
})
test("manual confirmation uses an opaque internal ID and replay leaves task and audit unchanged", async () => {
  const { db, scope, context } = await syncFixture()
  const task = await ordinaryTask(scope, "Retain after provider failure")
  expect(task.task.calendar_sync_state).toBe("pending")
  const input = { taskId: task.task.id, requestId: "manual-request", confirmationId: "caller-controlled-ID", providerEventId: "provider-data" }
  const first = await persistManualCalendarConfirmation(input, context)
  expect(first.alreadyExisted).toBe(false)
  expect(first.confirmationId).not.toBe(input.confirmationId)
  const before = (await db.execute("SELECT * FROM audit_trail")).rows
  expect(await persistManualCalendarConfirmation(input, context)).toEqual({ ...first, alreadyExisted: true })
  expect((await db.execute("SELECT * FROM audit_trail")).rows).toEqual(before)
  expect((await new TaskRepository(db, scope).findById(task.task.id))?.calendar_sync_state).toBe("confirmed")
})
test("manual confirmation rejects an unknown task without recording foreign identifiers", async () => {
  const { db, context } = await syncFixture()
  await expect(persistManualCalendarConfirmation({ taskId: crypto.randomUUID(), requestId: "unknown", confirmationId: "foreign" }, context)).rejects.toBeTruthy()
  expect((await db.execute("SELECT COUNT(*) AS total FROM calendar_confirmations")).rows[0]?.total).toBe(0)
})
test("concurrent common retries retain one task and one binding confirmation", async () => {
  const { db, context } = await syncFixture()
  const [first, second] = await Promise.all([commitSyncMutationChunks([syncMutation("Concurrent")], context), commitSyncMutationChunks([syncMutation("Concurrent")], context)])
  expect(first.created + second.created).toBe(1)
  expect(first.errors.concat(second.errors)).toEqual([])
  expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(1)
  expect((await db.execute("SELECT COUNT(*) AS total FROM calendar_confirmations")).rows[0]?.total).toBe(1)
})
test("retention rolls back dependent deletes and deletion receipts if task removal fails", async () => {
  const { db, scope } = await syncFixture()
  const task = await ordinaryTask(scope, "Retained completion")
  const repo = new TaskRepository(db, scope)
  expect((await repo.updateTask(task.task.id, { status: "complete" })).ok).toBe(true)
  await db.execute({ sql: "INSERT INTO comments(id,task_id,content,author,created_at) VALUES (1,?,'Keep comment','parent',1)", args: [task.task.id] })
  await db.execute("CREATE TRIGGER fixture_reject_retention BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT, 'fixture task delete rejection'); END")
  const before = (await db.execute("SELECT * FROM domain_events")).rows
  await expect(repo.deleteCompletedBefore(Date.now() + 60_000)).rejects.toThrow("fixture task delete rejection")
  expect(await repo.findById(task.task.id)).toBeTruthy()
  expect((await db.execute("SELECT content FROM comments")).rows).toEqual([{ content: "Keep comment" }])
  expect((await db.execute("SELECT * FROM domain_events")).rows).toEqual(before)
})
test("a read-only outbound Todo binding replaces its pending correlation in the same row without editing the task", async () => {
  const { db, scope, config } = await syncFixture()
  const task = await ordinaryTask(scope, "Outbound task")
  const binding = { ...config.bindings[0]!, purpose: "todo.sync", integration: "todo", sourceId: "todo.home", allowedOperations: [{ resource: "task" as const, action: "read" as const }] }
  await db.execute({ sql: "UPDATE settings SET value=? WHERE key='work-destinations'", args: [JSON.stringify({ ...config, bindings: [binding] })] })
  await db.execute({ sql: "UPDATE board_access_grants SET authority_limits=? WHERE principal_type='service' AND principal_id=?", args: [JSON.stringify({ purpose: "todo.sync", operations: binding.allowedOperations }), binding.id] })
  const { resolveIntegrationScope } = await import("../../apps/web/src/domains/tasks/board-automation")
  const resolved = await resolveIntegrationScope(db, binding.id, 1, { resource: "task", action: "read" }, scope, { resource: "task", action: "create" })
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) throw new Error(resolved.errorCode)
  const repo = new TaskRepository(db, resolved.value.scope)
  const snapshot = await repo.findSyncConfirmation(task.task.id, resolved.value)
  expect(snapshot?.confirmation).toBeNull()
  const before = (await db.execute({ sql: "SELECT * FROM tasks WHERE id=?", args: [task.task.id] })).rows
  const pending = { source: "ha_todo" as const, entityId: "todo.home", externalId: "pending-correlation", payload: JSON.stringify({ pending: true }), syncDirection: "outbound" as const }
  expect(await repo.saveSyncConfirmationForTask(task.task.id, pending, resolved.value, snapshot!.taskVersion)).toBe(true)
  const correlated = await repo.findSyncConfirmation(task.task.id, resolved.value)
  expect(correlated?.confirmation?.externalId).toBe("pending-correlation")
  expect(await repo.saveSyncConfirmationForTask(task.task.id, { ...pending, confirmationId: correlated!.confirmation!.confirmationId, externalId: "actual-uid", payload: JSON.stringify({ summary: "Outbound task" }) }, resolved.value, snapshot!.taskVersion)).toBe(true)
  expect((await db.execute("SELECT confirmation_id, ha_todo_uid FROM todo_sync_confirmations")).rows).toEqual([{ confirmation_id: correlated!.confirmation!.confirmationId, ha_todo_uid: "actual-uid" }])
  expect((await db.execute({ sql: "SELECT * FROM tasks WHERE id=?", args: [task.task.id] })).rows).toEqual(before)
  expect(await repo.saveSyncConfirmationForTask(task.task.id, { ...pending, confirmationId: "unknown-private-receipt" }, resolved.value, snapshot!.taskVersion)).toBe(false)
  expect(await repo.saveSyncConfirmationForTask(task.task.id, pending, resolved.value, 0)).toBe(false)
  expect(await repo.saveSyncConfirmationForTask(task.task.id, { ...pending, externalId: "another-pending-correlation" }, resolved.value, snapshot!.taskVersion)).toBe(false)
  expect((await db.execute("SELECT COUNT(*) AS total FROM todo_sync_confirmations")).rows[0]?.total).toBe(1)
})
test("Calendar tombstones retain a proven binding receipt and suppress unproven private payloads", async () => {
  const { db, scope, context } = await syncFixture()
  await commitSyncMutationChunks([syncMutation("Deleted provider event", "deleted"), syncMutation("Unproven provider mapping", "unproven")], context)
  const before = await findTasksByExternalSyncIds({ source: "calendar", entityId: "calendar.home", externalIds: ["provider-deleted", "provider-unproven"] }, context)
  const repo = new TaskRepository(db, scope)
  const deleted = before.get("provider-deleted")!
  expect((await repo.deleteWorkCommand(deleted.taskId)).ok).toBe(true)
  const unproven = before.get("provider-unproven")!
  // Synthetic predecessor deletion without a receipt. Its retained private
  // provider payload cannot become readable merely because the task is gone.
  await db.execute({ sql: "DELETE FROM tasks WHERE id=?", args: [unproven.taskId] })
  const service = new TaskRepository(db, context.scope)
  const refs = await service.listCalendarSyncReferences(context, "calendar.home")
  expect(refs.find(row => row.externalId === "provider-deleted")).toMatchObject({ taskId: deleted.taskId, taskDeleted: true, payload: expect.stringContaining("Deleted provider event") })
  expect(refs.find(row => row.externalId === "provider-unproven")).toMatchObject({ taskId: "", taskDeleted: true, suppressed: true, payload: null })
  const matches = await findTasksByExternalSyncIds({ source: "calendar", entityId: "calendar.home", externalIds: ["provider-deleted", "provider-unproven"] }, context)
  expect(matches.get("provider-deleted")).toMatchObject({ taskId: deleted.taskId, taskDeleted: true })
  expect(matches.get("provider-unproven")).toMatchObject({ taskId: "", suppressed: true, payload: null })
  expect(await service.releaseSyncCalendarReferences(context, [unproven])).toBe(0)
  const successor = await commitSyncMutationChunks([{ ...syncMutation("Next recurring provider occurrence", "next-occurrence"),
    confirmation: { source: "calendar", entityId: "calendar.home", externalId: "provider-deleted", payload: JSON.stringify({ entity_id: "calendar.home", start: "2026-12-01", rrule: "FREQ=MONTHLY" }) },
    replacedCalendarLinks: [{ confirmationId: deleted.confirmationId, taskId: deleted.taskId, externalId: deleted.externalId }],
  }], context)
  expect(successor).toMatchObject({ created: 1, errors: [] })
  expect((await db.execute("SELECT provider_event_id FROM calendar_confirmations ORDER BY provider_event_id")).rows).toEqual([{ provider_event_id: "provider-deleted" }, { provider_event_id: "provider-unproven" }])
  expect((await db.execute({ sql: "SELECT confirmation_id FROM calendar_confirmations WHERE confirmation_id=?", args: [deleted.confirmationId] })).rows).toEqual([])
})
test("unbound predecessor tombstones suppress only their exact source UID and disclose no old task identity", async () => {
  const { db, context } = await syncFixture()
  await db.execute({ sql: "INSERT INTO calendar_confirmations(confirmation_id,task_id,request_id,provider_event_id,source,payload,created_at,binding_id) VALUES ('old-private-confirmation','old-private-task','old-request','old-source-uid','ha.calendar_sync',?,1,NULL)", args: [JSON.stringify({ entity_id: "calendar.home", summary: "Private predecessor description", start: "2026-11-01", rrule: "FREQ=DAILY" })] })
  const matches = await findTasksByExternalSyncIds({ source: "calendar", entityId: "calendar.home", externalIds: ["old-source-uid", "different-uid"] }, context)
  expect(matches.get("old-source-uid")).toEqual({ confirmationId: "", taskId: "", externalId: "old-source-uid", syncUpdatedAt: 0, taskUpdatedAt: 0, payload: null, taskDeleted: true, suppressed: true })
  expect(matches.has("different-uid")).toBe(false)
  expect(JSON.stringify([...matches.values()])).not.toContain("private")
  expect((await db.execute("SELECT binding_id FROM calendar_confirmations WHERE confirmation_id='old-private-confirmation'")).rows).toEqual([{ binding_id: null }])
})
test("Todo lookup retains a proven deleted-task receipt so inbound snapshots do not recreate it", async () => {
  const { db, scope, config } = await syncFixture()
  const task = await ordinaryTask(scope, "Deleted Todo task")
  const binding = { ...config.bindings[0]!, purpose: "todo.sync", integration: "todo", sourceId: "todo.home", allowedOperations: [{ resource: "task" as const, action: "read" as const }] }
  await db.execute({ sql: "UPDATE settings SET value=? WHERE key='work-destinations'", args: [JSON.stringify({ ...config, bindings: [binding] })] })
  await db.execute({ sql: "UPDATE board_access_grants SET authority_limits=? WHERE principal_type='service' AND principal_id=?", args: [JSON.stringify({ purpose: "todo.sync", operations: binding.allowedOperations }), binding.id] })
  const { resolveIntegrationScope } = await import("../../apps/web/src/domains/tasks/board-automation")
  const resolved = await resolveIntegrationScope(db, binding.id, 1, { resource: "task", action: "read" }, scope, { resource: "task", action: "create" })
  if (!resolved.ok) throw new Error(resolved.errorCode)
  const service = new TaskRepository(db, resolved.value.scope)
  const snapshot = await service.findSyncConfirmation(task.task.id, resolved.value)
  expect(await service.saveSyncConfirmationForTask(task.task.id, { source: "ha_todo", entityId: "todo.home", externalId: "uid-to-suppress", payload: JSON.stringify({ summary: "Deleted Todo task" }) }, resolved.value, snapshot!.taskVersion)).toBe(true)
  expect((await new TaskRepository(db, scope).deleteWorkCommand(task.task.id)).ok).toBe(true)
  const matches = await findTasksByExternalSyncIds({ source: "ha_todo", entityId: "todo.home", externalIds: ["uid-to-suppress"] }, resolved.value)
  expect(matches.get("uid-to-suppress")).toMatchObject({ taskId: task.task.id, taskDeleted: true })
  expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(0)
})
