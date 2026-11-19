import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { GET as listBindings } from "../../apps/web/src/pages/api/todo/index"
import { POST as createTodoTask } from "../../apps/web/src/pages/api/todo/items"
import { POST as syncTodoBinding } from "../../apps/web/src/pages/api/todo/sync"
import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import {
  BoardAccessService, BoardRepository, HierarchyRepository, TaskRepository, resolveIntegrationScope, readWorkDestinations,
  prepareTaskCreation, type VerifiedPrincipal, type WorkBinding, type IntegrationScope,
} from "../../apps/web/src/domains/tasks"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { recoverTodoAdd } from "../../apps/web/src/domains/todo/todo-bridge"
import { mergeHATodoItems, stopTodoSync, startTodoSync, getTodoSyncStatus } from "../../apps/web/src/domains/todo"

type APIContext = Parameters<typeof listBindings>[0]

let directory: string
let previousUrl: string | undefined
let owner: VerifiedPrincipal
let workBoard: string
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }

test.beforeEach(async () => {
  previousUrl = process.env.MEITHEAL_DB_URL
  directory = await mkdtemp(join(tmpdir(), "meitheal-todo-bindings-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  await ensureSchema()
  await runWithIngressTransport(transport, async () => {
    const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://127.0.0.1/boards"), locals: {} as App.Locals })
    if (!principal || principal.kind !== "local_operator") throw new Error("Actual admitted local operator required")
    owner = principal
    const created = await new BoardRepository(getPersistenceClient()).create(owner, "Work")
    if (created.status !== "committed") throw new Error("Board creation failed")
    workBoard = created.result.id
  })
})
test.afterEach(async () => {
  stopTodoSync()
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})

async function installBinding(boardId: string, options: { complete?: boolean, readOnly?: boolean } = {}): Promise<WorkBinding> {
  const db = getPersistenceClient()
  const configuration = await readWorkDestinations(db)
  if (!configuration) throw new Error("Admitted binding metadata missing")
  const binding: WorkBinding = { id: randomUUID(), generation: 1, enabled: true, integration: "todo", sourceId: "todo.shared", purpose: "todo.sync", destination: { boardId },
    allowedOperations: [{ resource: "task", action: "read" }, ...(!options.readOnly ? [{ resource: "task", action: "create" }, { resource: "task", action: "edit" }] as const : []),
      ...(options.complete ? [{ resource: "task", action: "complete" }, { resource: "task", action: "reopen" }] as const : [])] }
  const enrolled = await changeBoardGrants(db, async tx => {
    await tx.execute({ sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'service',?,'service',?)", args: [boardId, binding.id, JSON.stringify({ operations: binding.allowedOperations, purpose: binding.purpose })] })
    await tx.execute({ sql: "UPDATE settings SET value=? WHERE key='work-destinations'", args: [JSON.stringify({ ...configuration, revision: randomUUID(), bindings: [...configuration.bindings, binding] })] })
    return { next: true }
  })
  expect(enrolled.status).toBe("committed")
  return binding
}
async function admitted(binding: WorkBinding): Promise<IntegrationScope> {
  const result = await resolveIntegrationScope(getPersistenceClient(), binding.id, binding.generation, { resource: "task", action: "read" })
  if (!result.ok) throw new Error(result.errorCode)
  return result.value
}

test("same HA source and UID remain independent on original and ordinary Boards", async () => {
  const original = await installBinding("household", { complete: true })
  const work = await installBinding(workBoard, { complete: true })
  for (const binding of [original, work]) await mergeHATodoItems(await admitted(binding), [{ uid: "shared-uid", summary: "Same external task", status: "needs_action" }])
  const rows = []
  for (const binding of [original, work]) {
    const context = await admitted(binding)
    const repo = new TaskRepository(getPersistenceClient(), context.scope)
    const listed = await repo.findAll({})
    expect(listed.total).toBe(1)
    expect(listed.tasks[0]?.area_id).toBe(null)
    rows.push(listed.tasks[0]!)
    await mergeHATodoItems(context, [{ uid: "shared-uid", summary: "Same external task updated", status: "completed" }])
    expect((await repo.findById(listed.tasks[0]!.id))?.status).toBe("complete")
  }
  expect(rows[0]!.id).not.toBe(rows[1]!.id)
  expect(rows[0]!.ticket_ref).not.toBe(rows[1]!.ticket_ref)
  const confirmations = await getPersistenceClient().execute("SELECT binding_id,ha_todo_uid,task_id FROM todo_sync_confirmations")
  expect(confirmations.rows).toHaveLength(2)
})

test("completion denied by the binding writes no status or confirmation change", async () => {
  const binding = await installBinding(workBoard)
  const context = await admitted(binding)
  await mergeHATodoItems(context, [{ uid: "one", summary: "Pending", status: "needs_action" }])
  await expect(mergeHATodoItems(context, [{ uid: "one", summary: "Must remain pending", status: "completed" }])).rejects.toThrow(/permissions/)
  const listed = await new TaskRepository(getPersistenceClient(), context.scope).findAll({})
  expect(listed.tasks).toHaveLength(1)
  expect(listed.tasks[0]).toMatchObject({ title: "Pending", status: "pending" })
})

test("stale generation cannot create an external task or adopt another destination", async () => {
  const binding = await installBinding(workBoard)
  const oldContext = await admitted(binding)
  const db = getPersistenceClient()
  const config = await readWorkDestinations(db)
  const changed = await changeBoardGrants(db, async tx => {
    await tx.execute({ sql: "UPDATE settings SET value=? WHERE key='work-destinations'", args: [JSON.stringify({ ...config, revision: randomUUID(), bindings: config!.bindings.map(value => value.id === binding.id ? { ...value, generation: 2 } : value) })] })
    return { next: true }
  })
  expect(changed.status).toBe("committed")
  await expect(mergeHATodoItems(oldContext, [{ uid: "stale", summary: "Never written" }])).rejects.toThrow(/unavailable/)
  expect(Number((await db.execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(0)
})

test("read-only outbound confirmation records pending and exact provider UID without editing Task", async () => {
  const binding = await installBinding(workBoard, { readOnly: true })
  const db = getPersistenceClient()
  const actor = await new BoardAccessService(db).resolve(owner, workBoard, { resource: "task", action: "create" })
  if (!actor.ok) throw new Error(actor.errorCode)
  const repo = new TaskRepository(db, actor.scope)
  const prepared = await prepareTaskCreation(repo, { title: "Authoritative task" })
  if (!prepared.ok) throw new Error(prepared.error)
  const task = await repo.createWorkCommand(prepared.task, {})
  if (!task.ok) throw new Error(task.errorCode)
  const context = await admitted(binding)
  const writer = new TaskRepository(db, context.scope)
  const first = await writer.findSyncConfirmation(task.task.id, context)
  if (!first) throw new Error("Task snapshot required")
  const claims = await Promise.all(["pending:opaque", "pending:other-event"].map(externalId => writer.saveSyncConfirmationForTask(task.task.id,
    { source: "ha_todo", entityId: binding.sourceId, externalId, syncDirection: "outbound", payload: '{"state":"pending","correlationMarker":"unique task reference"}' }, context, first.taskVersion)))
  expect(claims.sort()).toEqual([false, true])
  const pending = await writer.findSyncConfirmation(task.task.id, context)
  if (!pending?.confirmation) throw new Error("Pending receipt required")
  expect(await writer.saveSyncConfirmationForTask(task.task.id, { source: "ha_todo", entityId: binding.sourceId, externalId: "real-provider-uid", confirmationId: pending.confirmation.confirmationId, syncDirection: "outbound", payload: '{"state":"confirmed"}' }, context, pending.taskVersion)).toBe(true)
  const final = await writer.findSyncConfirmation(task.task.id, context)
  expect(final?.taskVersion).toBe(first.taskVersion)
  expect(final?.confirmation).toMatchObject({ confirmationId: pending.confirmation.confirmationId, externalId: "real-provider-uid" })
  expect(Number((await db.execute("SELECT COUNT(*) AS count FROM todo_sync_confirmations")).rows[0]?.count)).toBe(1)
})

function http(path: string, method: string, boardId: string, body?: unknown): APIContext {
  const url = new URL(`http://127.0.0.1/api/todo${path}`)
  const request = new Request(url, { method, headers: { "Content-Type": "application/json", "X-Meitheal-Board-Id": boardId, "X-Meitheal-Board-Session": boardSessionProof(owner.id) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { request, url, params: {}, locals: {} } as APIContext
}

test("Todo HTTP lists only selected Board bindings and rejects implicit source writes", async () => {
  const original = await installBinding("household")
  const work = await installBinding(workBoard)
  await runWithIngressTransport(transport, async () => {
    const response = await listBindings(http("", "GET", workBoard))
    expect(response.status, await response.clone().text()).toBe(200)
    const data = await response.json()
    expect(data.entities.map((entity: any) => entity.binding_id)).toEqual([work.id])
    expect(JSON.stringify(data)).not.toContain(original.id)
    const denied = await createTodoTask(http("/items", "POST", workBoard, { entity_id: "todo.shared", summary: "No implicit destination" }))
    expect(denied.status).toBe(404)
    expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(0)
  })
})

test("Todo HTTP creation uses canonical Task writer and manual sync never auto-starts", async () => {
  const work = await installBinding(workBoard, { readOnly: true })
  await runWithIngressTransport(transport, async () => {
    const response = await createTodoTask(http("/items", "POST", workBoard, { binding_id: work.id, generation: 1, summary: "Normal task command", description: "From Todo compatibility" }))
    expect(response.status, await response.clone().text()).toBe(201)
    expect(await response.json()).toMatchObject({ board_id: workBoard, title: "Normal task command", task_kind: "standard_action", area_id: null })
    const stale = await createTodoTask(http("/items", "POST", workBoard, { binding_id: work.id, generation: 99, summary: "No stale destination" }))
    expect(stale.status).toBe(404)
    const sync = await syncTodoBinding(http("/sync", "POST", workBoard, { binding_id: work.id, generation: 1, action: "sync" }))
    expect(sync.status, await sync.clone().text()).toBe(409)
    expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(1)
  })
})

test("Todo add recovery requires the exact unique provider correlation and never adopts a title match", () => {
  const marker = "Meitheal ticket WORK-1 · reference 1601544a-7856-43f9-b5ce-b65aa8427f1e"
  const description = `User description\n\n${marker}\n\nAdded from Meitheal`
  const expected = { summary: "Same title", description, due: null }
  const unrelated = { uid: "someone-else", summary: "Same title", description: "User description", status: "needs_action" as const }
  const own = { uid: "ours", summary: "Same title", description, status: "needs_action" as const }
  expect(recoverTodoAdd([unrelated], [], expected, marker)).toBe(null)
  expect(recoverTodoAdd([unrelated, own], [], expected, marker)).toEqual(own)
  expect(recoverTodoAdd([own], ["ours"], expected, marker)).toBe(null)
  expect(recoverTodoAdd([own, { ...own, uid: "ambiguous-copy" }], [], expected, marker)).toBe(null)
  expect(recoverTodoAdd([own], [], expected, null)).toBe(null)
})

test("inbound echoes strip only their stored marker and retain correlation through later snapshots", async () => {
  const binding = await installBinding(workBoard)
  const context = await admitted(binding)
  const note = "My note says Open in Meitheal: https://example.invalid/keep"
  await mergeHATodoItems(context, [{ uid: "echo", summary: "Task", description: note }])
  const repo = new TaskRepository(getPersistenceClient(), context.scope)
  const task = (await repo.findAll({})).tasks[0]!
  const snapshot = await repo.findSyncConfirmation(task.id, context)
  if (!snapshot?.confirmation) throw new Error("Initial exact confirmation required")
  const marker = "Meitheal ticket WORK-1 · reference stored-own-correlation"
  expect(await repo.saveSyncConfirmationForTask(task.id, { source: "ha_todo", entityId: binding.sourceId, externalId: "echo", confirmationId: snapshot.confirmation.confirmationId,
    payload: JSON.stringify({ correlationMarker: marker, correlation: "stored-own-correlation", state: "confirmed" }) }, context, snapshot.taskVersion)).toBe(true)
  for (let iteration = 0; iteration < 2; iteration++) {
    await mergeHATodoItems(context, [{ uid: "echo", summary: `Updated ${iteration}`, description: `${note}\n\n${marker}\n\nAdded from Meitheal` }])
    expect((await repo.findById(task.id))?.description).toBe(note)
    const saved = await repo.findSyncConfirmation(task.id, context)
    expect(JSON.parse(saved!.confirmation!.payload!).correlationMarker).toBe(marker)
  }
  expect((await repo.findAll({})).total).toBe(1)
})

test("a deleted linked Todo task is not recreated by a delayed provider snapshot", async () => {
  const binding = await installBinding(workBoard)
  const context = await admitted(binding)
  const item = { uid: "late-item", summary: "Delete once", status: "needs_action" as const }
  await mergeHATodoItems(context, [item])
  const service = new TaskRepository(getPersistenceClient(), context.scope)
  const task = (await service.findAll({})).tasks[0]!
  const actor = await new BoardAccessService(getPersistenceClient()).resolve(owner, workBoard, { resource: "task", action: "delete" })
  if (!actor.ok) throw new Error(actor.errorCode)
  expect((await new TaskRepository(getPersistenceClient(), actor.scope).deleteWorkCommand(task.id)).ok).toBe(true)
  await mergeHATodoItems(context, [item])
  expect((await service.findAll({})).total).toBe(0)
  expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM todo_sync_confirmations")).rows[0]?.count)).toBe(1)
})


test("Todo registration cannot replace current origin management with a wider service grant", async () => {
  const binding = await installBinding(workBoard, { readOnly: true })
  const db = getPersistenceClient()
  const manager = await new BoardAccessService(db).resolve(owner, workBoard, { resource: "board", action: "manage" })
  if (!manager.ok) throw new Error("Actual manager proof required")
  const resolved = await resolveIntegrationScope(db, binding.id, binding.generation, { resource: "task", action: "read" }, manager.scope, { resource: "board", action: "manage" })
  if (!resolved.ok) throw new Error(resolved.errorCode)
  const changed = await changeBoardGrants(db, async tx => {
    await tx.execute({ sql: "UPDATE board_access_grants SET role='viewer' WHERE board_id=? AND principal_type=? AND principal_id=?", args: [workBoard, owner.kind, owner.id] })
    return { next: true }
  })
  expect(changed.status).toBe("committed")
  expect((await admitted(binding)).binding.id).toBe(binding.id)
  await expect(startTodoSync({ bindingId: binding.id, generation: binding.generation, entityId: binding.sourceId, syncEnabled: true, syncDirection: "outbound", writeBack: true }, resolved.value)).rejects.toThrow(/unavailable/)
  expect(getTodoSyncStatus(binding.id)).toBe(null)
})
