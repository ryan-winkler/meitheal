import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import {
  BoardRepository, BoardAccessService, TaskRepository, TemplateRepository, prepareTaskCreation,
  readWorkDestinations, resolveIntegrationScope, resolveIntegrationRecipient, boardOperationClient, BoardOperationError,
  type BoardScope, type WorkBinding,
} from "../../apps/web/src/domains/tasks"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { createTaskNotificationDoneAction, handleTaskNotificationAction } from "../../apps/web/src/lib/task-notification-action"
import { getHAConnection, closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocket, WebSocketServer } = require("ws") as typeof import("../../apps/web/node_modules/@types/ws")
let server: InstanceType<typeof WebSocketServer>
let originalSocket: typeof globalThis.WebSocket
let directory: string, board: string, taskId: string
let owner: BoardScope, delivery: WorkBinding, actionBinding: WorkBinding
let recipients: string[]
let heldUserReply: (() => void) | undefined
let holdNextUserReply: boolean
let subscribed: Array<{ socket: InstanceType<typeof WebSocket>, id: number, type: string }>
const previousDb = process.env.MEITHEAL_DB_URL
const previousSupervisor = process.env.SUPERVISOR_TOKEN
const target = "notify.mobile_app_fixture"
const read = { resource: "task", action: "read" } as const

async function install(recipients = ["parent"]) {
  const db = getPersistenceClient()
  const current = await readWorkDestinations(db)
  if (!current) throw new Error("Admitted binding metadata required")
  delivery = { id: crypto.randomUUID(), generation: 1, enabled: true, integration: "notification", purpose: "notify.delivery", sourceId: target,
    destination: { boardId: board }, allowedOperations: [read], recipientUserIds: recipients }
  actionBinding = { id: crypto.randomUUID(), generation: 1, enabled: true, integration: "notification_action", purpose: "notify.task.complete", sourceId: target,
    destination: { boardId: board }, allowedOperations: [read, { resource: "task", action: "complete" }], recipientUserIds: ["parent", "child"] }
  const installed = await changeBoardGrants(db, owner.principal, async tx => {
    for (const binding of [delivery, actionBinding]) await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'service',?,'service',?)",
      args: [board, binding.id, JSON.stringify({ operations: binding.allowedOperations, purpose: binding.purpose })],
    })
    await tx.execute({ sql: "UPDATE settings SET value=? WHERE key='work-destinations'", args: [JSON.stringify({ ...current, revision: crypto.randomUUID(), bindings: [...current.bindings, delivery, actionBinding] })] })
    return { next: true }
  })
  expect(installed.status).toBe("committed")
}
async function modifyBinding(id: string) {
  const db = getPersistenceClient()
  const config = await readWorkDestinations(db)
  const changed = await changeBoardGrants(db, owner.principal, async tx => {
    await tx.execute({ sql: "UPDATE settings SET value=? WHERE key='work-destinations'", args: [JSON.stringify({ ...config, revision: crypto.randomUUID(), bindings: config!.bindings.map(binding => binding.id === id ? { ...binding, enabled: false, generation: binding.generation + 1 } : binding) })] })
    return { next: true }
  })
  expect(changed.status).toBe("committed")
}
async function state(id = taskId) {
  return (await getPersistenceClient().execute({ sql: "SELECT status, title, updated_at FROM tasks WHERE id=?", args: [id] })).rows[0]
}
const event = (action: string, user: string | null = "parent", extra: Record<string, unknown> = {}) => ({
  event_type: "mobile_app_notification_action", context: { user_id: user, id: crypto.randomUUID() }, data: { action, ...extra },
})
async function recipient() {
  const service = await resolveIntegrationScope(getPersistenceClient(), delivery.id, delivery.generation, read)
  if (!service.ok) throw new Error(service.errorCode)
  const actor = await resolveIntegrationRecipient(getPersistenceClient(), service.value, "parent")
  if (!actor.ok) throw new Error(actor.errorCode)
  return actor.scope
}

test.beforeEach(async ({}, testInfo) => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-notification-action-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  delete process.env.SUPERVISOR_TOKEN
  await ensureSchema()
  await runWithIngressTransport({ peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }, async () => {
    const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://127.0.0.1/boards"), locals: {} as App.Locals })
    if (!principal) throw new Error("Actual standalone operator required")
    const created = await new BoardRepository(getPersistenceClient()).create(principal, "Work")
    if (created.status !== "committed") throw new Error("Board fixture failed")
    board = testInfo.title.endsWith(": legacy") ? "household" : created.result.id
    const scoped = await new BoardAccessService(getPersistenceClient()).resolve(principal, board, read)
    if (!scoped.ok) throw new Error(scoped.errorCode)
    owner = scoped.scope
    const repo = new TaskRepository(getPersistenceClient(), owner)
    const prepared = await prepareTaskCreation(repo, { title: "Notification work", area_id: null }, { useDefaultAssignee: false })
    if (!prepared.ok) throw new Error(prepared.error)
    const task = await repo.createWorkCommand(prepared.task)
    if (!task.ok) throw new Error(task.errorCode)
    taskId = task.task.id
  })
  const enrolled = await changeBoardGrants(getPersistenceClient(), owner.principal, async tx => {
    for (const user of ["parent", "child"]) await tx.execute({ sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role) VALUES (?,'ha_user',?,?)", args: [board, user, user === "parent" ? "owner" : "member"] })
    return { next: true }
  })
  expect(enrolled.status).toBe("committed")
  await install()
  recipients = ["parent", "child", "outsider"]
  holdNextUserReply = false
  heldUserReply = undefined
  subscribed = []
  server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>(resolve => server.once("listening", resolve))
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.1" }))
    socket.on("message", bytes => {
      const command = JSON.parse(bytes.toString())
      if (command.type === "auth") socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.1" }))
      else {
        if (command.type === "subscribe_events") subscribed.push({ socket, id: command.id, type: command.event_type })
        const reply = () => socket.send(JSON.stringify({ type: "result", id: command.id, success: true,
          result: command.type === "config/auth/list" ? recipients.map(id => ({ id, is_active: true, system_generated: false, is_owner: id === "parent", group_ids: [] })) : [] }))
        if (command.type === "config/auth/list" && holdNextUserReply) { holdNextUserReply = false; heldUserReply = reply }
        else reply()
      }
    })
  })
  originalSocket = globalThis.WebSocket
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected loopback WebSocket address")
  const corePort = address.port
  globalThis.WebSocket = class extends WebSocket {
    constructor(url: string | URL, options?: import("../../apps/web/node_modules/@types/ws").ClientOptions) {
      if (String(url) !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected Core endpoint")
      super(`ws://127.0.0.1:${corePort}`, options)
    }
  } as unknown as typeof globalThis.WebSocket
  process.env.SUPERVISOR_TOKEN = "fixture-current-core"
})
test.afterEach(async () => {
  closeHAConnection()
  globalThis.WebSocket = originalSocket
  for (const socket of server.clients) socket.terminate()
  await new Promise<void>(resolve => server.close(() => resolve()))
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDb
  if (previousSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN
  else process.env.SUPERVISOR_TOKEN = previousSupervisor
  await rm(directory, { recursive: true, force: true })
})

test("a current trusted HA notification event completes through the common writer", async () => {
  const value = await createTaskNotificationDoneAction(board, target, taskId)
  expect(value).toMatch(/^MEITHEAL_DONE_V1:/)
  expect(await getHAConnection()).not.toBeNull()
  await expect.poll(() => subscribed.some(item => item.type === "mobile_app_notification_action")).toBe(true)
  const subscription = subscribed.find(item => item.type === "mobile_app_notification_action")!
  subscription.socket.send(JSON.stringify({ type: "event", id: subscription.id, event: event(value!) }))
  await expect.poll(async () => (await state())?.status).toBe("complete")
  expect(await handleTaskNotificationAction(event(value!), () => true)).toBe(false)
  expect(Number((await getPersistenceClient().execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count)).toBe(1)
})

for (const encoding of ["legacy", "scoped"] as const) {
  test(`legacy ISO timestamps support completion and still reject stale notification versions: ${encoding}`, async () => {
    const db = getPersistenceClient()
    const timestamp = "2026-11-18T12:34:56.789Z"
    await db.execute({ sql: "UPDATE tasks SET updated_at=? WHERE id=?", args: [timestamp, taskId] })
    const actor = await recipient()
    const normalized = await new TaskRepository(db, actor).findById(taskId)
    expect(normalized?.task_version).toBe(Date.parse(timestamp))
    const stale = await createTaskNotificationDoneAction(board, target, taskId, Date.parse(timestamp))
    expect(stale).not.toBeNull()
    expect(await createTaskNotificationDoneAction(board, target, taskId, Date.parse(timestamp) - 1)).toBeNull()
    expect((await new TaskRepository(db, actor).updateTask(taskId, { title: "Edited after notification" })).ok).toBe(true)
    expect(await handleTaskNotificationAction(event(stale!), () => true)).toBe(false)
    expect((await state())?.status).toBe("pending")
    const current = await new TaskRepository(db, actor).findById(taskId)
    const fresh = await createTaskNotificationDoneAction(board, target, taskId, current?.task_version)
    expect(fresh).not.toBeNull()
    expect(await handleTaskNotificationAction(event(fresh!), () => true)).toBe(true)
    expect((await state())?.status).toBe("complete")
  })
}

test("the top-level Core context controls identity and old unscoped actions are ignored", async () => {
  const value = await createTaskNotificationDoneAction(board, target, taskId)
  expect(value).not.toBeNull()
  for (const candidate of [event(value!, null, { user_id: "parent" }), event(value!, "outsider", { user_id: "parent" }), event("MEITHEAL_TASK_DONE_" + taskId)]) {
    expect(await handleTaskNotificationAction(candidate, () => true)).toBe(false)
  }
  expect((await state())?.status).toBe("pending")
})

test("a child cannot use a broader completion binding after their completion grant is removed", async () => {
  await modifyBinding(delivery.id)
  await install(["child"])
  const value = await createTaskNotificationDoneAction(board, target, taskId)
  expect(value).not.toBeNull()
  const changed = await changeBoardGrants(getPersistenceClient(), owner.principal, async tx => {
    await tx.execute({ sql: "UPDATE board_access_grants SET deny_completion=1 WHERE board_id=? AND principal_type='ha_user' AND principal_id='child'", args: [board] })
    return { next: true }
  })
  expect(changed.status).toBe("committed")
  expect(await createTaskNotificationDoneAction(board, target, taskId)).toBeNull()
  expect(await handleTaskNotificationAction(event(value!, "child"), () => true)).toBe(false)
  expect((await state())?.status).toBe("pending")
})

for (const revoke of ["action", "delivery", "connection"] as const) {
  test(`held callback cannot complete after its ${revoke} authority is lost`, async () => {
    const value = await createTaskNotificationDoneAction(board, target, taskId)
    expect(value).not.toBeNull()
    let connected = true
    holdNextUserReply = true
    const pending = handleTaskNotificationAction(event(value!), () => connected)
    await expect.poll(() => Boolean(heldUserReply)).toBe(true)
    if (revoke === "connection") connected = false
    else await modifyBinding(revoke === "action" ? actionBinding.id : delivery.id)
    heldUserReply!()
    expect(await pending).toBe(false)
    expect((await state())?.status).toBe("pending")
  })
}

test("nested common writer checks remain restrictive through actual precommit rollback", async () => {
  const actor = await recipient()
  let first = 0, second = 0, entered: (() => void) | undefined, release: (() => void) | undefined
  const reached = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  let connected = true
  const outer = boardOperationClient(getPersistenceClient(), actor, { resource: "task", action: "edit" }, [taskId], undefined, async () => {
    first++
    if (first === 2) { entered!(); await held }
    if (!connected) throw new BoardOperationError("denied")
  })
  const nested = boardOperationClient(outer, actor, { resource: "task", action: "edit" }, [taskId], undefined, async () => { second++ })
  const pending = new TaskRepository(nested, actor).updateTask(taskId, { title: "Must roll back" })
  await reached
  connected = false
  release!()
  await expect(pending).rejects.toThrow(/unavailable/)
  expect((await state())?.title).toBe("Notification work")
  expect(first).toBe(2)
  expect(second).toBe(1)
})

test("completion replay cannot create another Routine occurrence", async () => {
  // Create through the existing Routine engine before enabling the Supervisor-only transport.
  delete process.env.SUPERVISOR_TOKEN
  const principal = await runWithIngressTransport({ peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }, () =>
    verifiedBoardRequestPrincipal({ request: new Request("http://127.0.0.1/boards"), locals: {} as App.Locals }))
  if (!principal) throw new Error("Actual operator required")
  const result = await new BoardAccessService(getPersistenceClient()).resolve(principal, board, read)
  if (!result.ok) throw new Error(result.errorCode)
  const templates = new TemplateRepository(getPersistenceClient(), result.scope)
  const id = crypto.randomUUID()
  expect(await templates.create({ id, name: "Daily check", icon: "", position: 0, templateJson: JSON.stringify({ title: "Daily check" }), isRoutine: true, cadence: "daily" })).toBe(true)
  taskId = (await templates.instantiateRoutineTask(id)).taskId
  process.env.SUPERVISOR_TOKEN = "fixture-current-core"
  const value = await createTaskNotificationDoneAction(board, target, taskId)
  expect(value).not.toBeNull()
  expect(await handleTaskNotificationAction(event(value!), () => true)).toBe(true)
  expect(await handleTaskNotificationAction(event(value!), () => true)).toBe(false)
  const rows = await getPersistenceClient().execute("SELECT id,status FROM tasks WHERE task_kind='routine_instance'")
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]?.status).toBe("complete")
})

test("a public notification action cannot complete an edited or reopened task snapshot", async () => {
  const originalVersion = Number((await state())?.updated_at)
  const old = await createTaskNotificationDoneAction(board, target, taskId, originalVersion)
  const actor = await recipient()
  expect((await new TaskRepository(getPersistenceClient(), actor).updateTask(taskId, { title: "Changed after notification" })).ok).toBe(true)
  expect(await handleTaskNotificationAction(event(old!), () => true)).toBe(false)
  expect(await createTaskNotificationDoneAction(board, target, taskId, originalVersion)).toBeNull()
  const current = await createTaskNotificationDoneAction(board, target, taskId)
  expect(current).not.toBeNull()
  expect(await handleTaskNotificationAction(event(current!), () => true)).toBe(true)
  expect((await new TaskRepository(getPersistenceClient(), actor).updateTask(taskId, { status: "pending" })).ok).toBe(true)
  expect(await handleTaskNotificationAction(event(current!), () => true)).toBe(false)
  expect((await state())?.status).toBe("pending")
})

test("a restrictive writer callback cannot grant a child completion permission", async () => {
  await modifyBinding(delivery.id)
  await install(["child"])
  const changed = await changeBoardGrants(getPersistenceClient(), owner.principal, async tx => {
    await tx.execute({ sql: "UPDATE board_access_grants SET deny_completion=1 WHERE board_id=? AND principal_type='ha_user' AND principal_id='child'", args: [board] })
    return { next: true }
  })
  expect(changed.status).toBe("committed")
  const service = await resolveIntegrationScope(getPersistenceClient(), delivery.id, delivery.generation, read)
  if (!service.ok) throw new Error(service.errorCode)
  const child = await resolveIntegrationRecipient(getPersistenceClient(), service.value, "child")
  if (!child.ok) throw new Error(child.errorCode)
  let called = 0
  const guarded = boardOperationClient(getPersistenceClient(), child.scope, { resource: "task", action: "complete" }, [taskId], undefined, async () => { called++ })
  await expect(new TaskRepository(guarded, child.scope).updateTask(taskId, { status: "complete" })).rejects.toThrow(/unavailable/)
  expect(called).toBe(0)
  expect((await state())?.status).toBe("pending")
})


test("a deferred writer cannot bypass an additional restrictive check", async () => {
  const actor = await recipient()
  let checked = 0
  const guarded = boardOperationClient(getPersistenceClient(), actor, { resource: "task", action: "edit" }, [taskId], undefined, async () => {
    checked++
    throw new BoardOperationError("denied")
  })
  await expect(guarded.transaction("deferred")).rejects.toThrow(/unavailable/)
  expect(checked).toBe(1)
  expect((await state())?.status).toBe("pending")
})
