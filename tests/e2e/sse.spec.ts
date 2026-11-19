import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { getEventListeners, once } from "node:events"
import { createRequire } from "node:module"
import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { getRuntimeCounters } from "../../apps/web/scripts/runtime-counters.mjs"
import {
  closeHAConnection,
  getCalendarEntities,
  getEntity,
  getTodoEntities,
  initEntitySubscription,
  onEntityChange,
  stopEntitySubscription,
} from "../../apps/web/src/domains/ha"
import { GET, HEAD, emitSSE } from "../../apps/web/src/pages/api/sse"
import { currentBoardScope } from "../helpers/current-board-scope"
import { ordinaryTask } from "../helpers/ordinary-sync-fixture"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { createTaskNotificationDoneAction } from "../../apps/web/src/lib/task-notification-action"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { OrganizationAccessRepository } from "../../apps/web/src/domains/tasks/persistence/organization-access-repository"
import { readWorkDestinations } from "../../apps/web/src/domains/tasks/integration-destinations"
import { saveWorkBinding } from "../../apps/web/src/domains/tasks/work-binding-manager"

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocket, WebSocketServer } = require("ws") as typeof import("../../apps/web/node_modules/@types/ws")

let work: string
let marker: string
let originalDb: string | undefined
let taskId: string

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "sse-continuity-"))
  marker = join(work, "grants.json")
  originalDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "meitheal.db")
  await ensureSchema({ markerPath: marker })
  const principal = await runWithIngressTransport(standaloneTransport, () =>
    verifiedBoardRequestPrincipal(requestContext(new Request(url))))
  if (!principal) throw new Error("Current local operator required")
  const scope = await currentBoardScope(getPersistenceClient(), "household", principal)
  taskId = (await ordinaryTask(scope, "SSE fixture task")).task.id
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (originalDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = originalDb
  await rm(work, { force: true, recursive: true })
})

const url = "http://localhost/api/sse?board_id=household"
const decoder = new TextDecoder()
const standaloneTransport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: false, configuredPath: undefined }
const regularStreamTransport = { ...standaloneTransport, sseSocket: { writableLength: 0, destroy() {} } }

function requestContext(request: Request, locals: Partial<App.Locals> = {}) {
  return { request, locals } as Parameters<typeof GET>[0]
}

async function open(signal?: AbortSignal, transport = regularStreamTransport, locals?: Partial<App.Locals>) {
  const request = new Request(url, signal ? { signal } : undefined)
  const response = await runWithIngressTransport(transport, () => GET(requestContext(request, locals)))
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  return { request, reader: response.body!.getReader() }
}

test("starts immediately and cleans up after cancellation or request abort", async () => {
  test.setTimeout(5_000)
  const head = await runWithIngressTransport(standaloneTransport, () =>
    HEAD(requestContext(new Request(url, { method: "HEAD" }))))
  expect(head.status).toBe(200)
  expect(head.body).toBeNull()

  const { request, reader: first } = await open()
  const abort = new AbortController()
  try {
    expect(getRuntimeCounters().sseClientsActive).toBe(1)
    expect(decoder.decode((await first.read()).value)).toMatch(/^event: connected\ndata: {"ts":"[^"]+"}\n\n$/)
    const { request: secondRequest, reader: second } = await open(abort.signal)
    try {
      expect(getRuntimeCounters().sseClientsActive).toBe(2)
      expect(decoder.decode((await second.read()).value)).toMatch(/^event: connected\ndata: {"ts":"[^"]+"}\n\n$/)

      await emitSSE("task:updated", { id: taskId })
      for (const reader of [first, second]) {
        expect(decoder.decode((await reader.read()).value)).toBe(`event: task:updated\ndata: ${JSON.stringify({ id: taskId })}\n\n`)
      }

      await first.cancel()
      expect(getEventListeners(request.signal, "abort")).toHaveLength(0)
      abort.abort()
      expect((await second.read()).done).toBe(true)
      expect(getEventListeners(secondRequest.signal, "abort")).toHaveLength(0)
      expect(getRuntimeCounters().sseClientsActive).toBe(0)
    } finally {
      await second.cancel()
    }
  } finally {
    await first.cancel()
  }
})

test("disconnects only the client whose stream exceeds its byte budget", async () => {
  test.setTimeout(5_000)
  const { reader: slow } = await open()
  const { reader: fast } = await open()
  try {
    await fast.read()
    for (let i = 0; i < 12; i++) {
      await emitSSE("example", { id: taskId, title: String(i), description: "x".repeat(8 * 1024) })
      expect(decoder.decode((await fast.read()).value)).toContain(`"title":"${i}"`)
    }

    let bytes = 0
    while (true) {
      const next = await slow.read()
      if (next.done) break
      bytes += next.value.byteLength
    }
    expect(bytes).toBeGreaterThan(0)
    expect(bytes).toBeLessThanOrEqual(64 * 1024)
  } finally {
    await Promise.all([slow.cancel(), fast.cancel()])
  }
})

test("counts the wrapper's pending HTTP bytes and terminates a backed-up socket", async () => {
  test.setTimeout(5_000)
  const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: false, configuredPath: undefined }
  const unsupportedAlias = await runWithIngressTransport(transport, () =>
    GET(requestContext(new Request("http://localhost/api/%73se"))),
  )
  expect(unsupportedAlias.status).toBe(404)

  let destroyed = false
  const sseSocket = {
    writableLength: 0,
    destroy() { destroyed = true },
  }
  const { request, reader } = await open(undefined, { ...transport, sseSocket })
  try {
    expect(decoder.decode((await reader.read()).value)).toMatch(/^event: connected\ndata: {"ts":"[^"]+"}\n\n$/)
    sseSocket.writableLength = 64 * 1024 - 20
    await emitSSE("example", { id: taskId, title: "Does not fit" })
    expect(destroyed).toBe(true)
    expect((await reader.read()).done).toBe(true)
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0)
  } finally {
    await reader.cancel()
  }
})

test("keeps calendar, todo and mobile notification delivery on scoped HA subscriptions", async () => {
  const db = getPersistenceClient()
  const principal = await runWithIngressTransport(standaloneTransport, () =>
    verifiedBoardRequestPrincipal(requestContext(new Request(url))))
  if (!principal) throw new Error("Current local operator required")
  const scope = await currentBoardScope(db, "household", principal)
  const legacyTask = (await ordinaryTask(scope, "Legacy action sentinel")).task.id
  const areaId = crypto.randomUUID()
  const projectId = crypto.randomUUID()
  const hierarchy = new HierarchyRepository(db, scope, marker)
  await hierarchy.createArea({ id: areaId, name: "Calendar audience" })
  expect(await hierarchy.createProject({ id: projectId, title: "Calendar destination", area_id: areaId })).toBe(true)
  const policies = new OrganizationAccessRepository(db, marker)
  const feature = await policies.change(
    { scope: "feature", id: "home_assistant_area", boardId: "" }, null, { audience: "everyone", users: [] }, principal,
  )
  expect(feature.status).toBe("committed")
  const haUser = "fixture-sse-owner"
  const haMember = "fixture-sse-member"
  const target = "notify.mobile_app_sse_fixture"
  const read = { resource: "task", action: "read" } as const
  for (const { projectId: destinationProject, ...binding } of [
    { integration: "calendar", sourceId: "calendar.test", purpose: "calendar.sync", allowedOperations: [read], projectId },
    { integration: "todo", sourceId: "todo.test", purpose: "todo.sync", allowedOperations: [read] },
    { integration: "notification", sourceId: target, purpose: "notify.delivery", allowedOperations: [read], recipientUserIds: [haUser] },
    { integration: "notification_action", sourceId: target, purpose: "notify.task.complete",
      allowedOperations: [read, { resource: "task", action: "complete" } as const], recipientUserIds: [haUser] },
  ]) {
    const current = await readWorkDestinations(db)
    if (!current) throw new Error("Current work destinations required")
    expect((await saveWorkBinding(db, principal, current.revision, {
      ...binding, id: crypto.randomUUID(), enabled: true, generation: 1,
      destination: { boardId: "household", ...(destinationProject ? { projectId: destinationProject } : {}) },
    })).ok).toBe(true)
  }
  expect((await policies.change(
    { scope: "group", id: areaId, boardId: "household" }, null, { audience: "selected", users: [haUser] }, principal,
  )).status).toBe("committed")

  const priorWebSocket = globalThis.WebSocket
  const priorToken = process.env.SUPERVISOR_TOKEN
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  type Subscription = { socket: InstanceType<typeof WebSocket>; id: number }
  const subscriptions = new Map<string, Subscription>()
  let entitySubscription: Subscription | undefined
  let active = true
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback Core fixture")
  const corePort = address.port
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.10.4" }))
    socket.on("message", raw => {
      const { id, type, event_type } = JSON.parse(raw.toString()) as { id: number; type: string; event_type?: string }
      if (type === "auth") {
        socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.10.4" }))
        return
      }
      if (type === "subscribe_entities") entitySubscription = { socket, id }
      if (type === "subscribe_events" && event_type) subscriptions.set(event_type, { socket, id })
      const result = type === "config/auth/list"
        ? [
            { id: haUser, is_active: active, system_generated: false, is_owner: true, group_ids: [] },
            { id: haMember, is_active: active, system_generated: false, is_owner: false, group_ids: [] },
          ] : []
      socket.send(JSON.stringify({ type: "result", id, success: true, result }))
    })
  })
  globalThis.WebSocket = class extends WebSocket {
    constructor(endpoint: string | URL, options?: import("../../apps/web/node_modules/@types/ws").ClientOptions) {
      if (String(endpoint) !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected Core endpoint")
      super(`ws://127.0.0.1:${corePort}`, options)
    }
  } as unknown as typeof globalThis.WebSocket
  process.env.SUPERVISOR_TOKEN = "synthetic-sse-core"
  function send(subscription: Subscription, event: unknown) {
    subscription.socket.send(JSON.stringify({ type: "event", id: subscription.id, event }))
  }
  async function taskStatus(id: string) {
    const { rows: [row] } = await db.execute({ sql: "SELECT status FROM tasks WHERE id=?", args: [id] })
    return row?.status
  }
  try {
    await initEntitySubscription()
    await expect.poll(() => subscriptions.size).toBe(8)
    expect([...subscriptions.keys()].sort()).toEqual([
      "component_loaded",
      "entity_registry_updated",
      "meitheal_area_updated",
      "meitheal_task_completed",
      "meitheal_task_created",
      "meitheal_task_deleted",
      "meitheal_task_updated",
      "mobile_app_notification_action",
    ])
    const notification = subscriptions.get("mobile_app_notification_action")!
    const action = await createTaskNotificationDoneAction("household", target, taskId)
    expect(action).toMatch(/^MEITHEAL_DONE_V1:/)
    for (const value of [`MEITHEAL_TASK_DONE_${legacyTask}`, action]) {
      send(notification, {
        event_type: "mobile_app_notification_action",
        context: { user_id: haUser, id: crypto.randomUUID() },
        data: { action: value },
      })
    }
    await expect.poll(() => taskStatus(taskId)).toBe("complete")
    expect(await taskStatus(legacyTask)).toBe("pending")

    const delivered: string[] = []
    const unsubscribe = onEntityChange("sensor.resubscribe", entity => {
      delivered.push(entity.state)
      unsubscribe()
      onEntityChange("sensor.resubscribe", next => { delivered.push(next.state) })
    })
    await expect.poll(() => Boolean(entitySubscription)).toBe(true)
    send(entitySubscription!, { a: {
      "calendar.test": { s: "off", a: {}, lc: 1, c: "seed" },
      "todo.test": { s: "1", a: {}, lc: 1, c: "seed" },
      "todo.unapproved": { s: "2", a: {}, lc: 1, c: "seed" },
      "sensor.unwatched": { s: "off", a: {}, lc: 1, c: "seed" },
      "sensor.resubscribe": { s: "off", a: {}, lc: 1, c: "seed" },
    } })
    await expect.poll(() => delivered).toEqual(["off"])
    expect(getCalendarEntities()).toHaveLength(1)
    expect(getTodoEntities()).toHaveLength(2)
    expect(getEntity("sensor.unwatched")).toBeUndefined()
    delivered.length = 0

    const transport = { ...regularStreamTransport, fromSupervisor: true, identityHeadersSafe: true }
    const locals = { behindIngress: true, hassUserId: haUser, hassIsAdmin: true }
    const { reader: first } = await open(undefined, transport, locals)
    const { reader: second } = await open(undefined, transport, locals)
    const { reader: member } = await open(undefined, transport, { ...locals, hassUserId: haMember, hassIsAdmin: false })
    try {
      await Promise.all([first.read(), second.read(), member.read()])
      send(entitySubscription!, { c: {
        "calendar.test": { "+": { s: "on", lu: 2 } },
        "todo.test": { "+": { lu: 2 } },
        "todo.unapproved": { "+": { s: "3", lu: 2 } },
        "sensor.unwatched": { "+": { s: "on", lu: 2 } },
        "sensor.resubscribe": { "+": { s: "on", lu: 2 } },
      } })
      await expect.poll(() => delivered).toEqual(["on"])
      expect(getEntity("sensor.unwatched")).toBeUndefined()
      await emitSSE("probe", { id: taskId })
      for (const reader of [first, second]) {
        expect(decoder.decode((await reader.read()).value)).toMatch(/^event: ha:entity_changed\ndata: .*"entity_id":"calendar.test","state":"on"/)
        expect(decoder.decode((await reader.read()).value)).toMatch(/^event: ha:entity_changed\ndata: .*"entity_id":"todo.test","state":"1".*"last_updated":"1970-01-01T00:00:02.000Z"/)
        expect(decoder.decode((await reader.read()).value)).toBe(`event: probe\ndata: ${JSON.stringify({ id: taskId })}\n\n`)
      }
      expect(decoder.decode((await member.read()).value)).toMatch(/^event: ha:entity_changed\ndata: .*"entity_id":"todo.test"/)
      expect(decoder.decode((await member.read()).value)).toBe(`event: probe\ndata: ${JSON.stringify({ id: taskId })}\n\n`)

      send(entitySubscription!, {
        c: {
          "todo.test": { "+": { s: "1", lu: 2 } },
          "sensor.resubscribe": { "+": { s: "off", lu: 3 } },
        },
        r: ["calendar.test"],
      })
      await expect.poll(() => delivered).toEqual(["on", "off"])
      expect(getCalendarEntities()).toHaveLength(0)
      await emitSSE("probe", { id: taskId })
      for (const reader of [first, second, member]) {
        expect(decoder.decode((await reader.read()).value)).toBe(`event: probe\ndata: ${JSON.stringify({ id: taskId })}\n\n`)
      }

      send(entitySubscription!, { a: { "calendar.test": { s: "off", a: {}, lc: 4, c: "seed" } } })
      await expect.poll(() => getCalendarEntities().length).toBe(1)
      for (const reader of [first, second]) {
        expect(decoder.decode((await reader.read()).value)).toMatch(/^event: ha:entity_changed\ndata: .*"entity_id":"calendar.test","state":"off"/)
      }

      const owner = await runWithIngressTransport(transport, () => verifiedBoardRequestPrincipal(requestContext(new Request(url), locals)))
      if (!owner) throw new Error("Current Home Assistant owner required")
      const ownerScope = await currentBoardScope(db, "household", owner)
      expect(await new HierarchyRepository(db, ownerScope, marker).deleteProject(projectId)).toBe(true)
      await emitSSE("ha:entity_changed", { entity_id: "calendar.test", state: "on" })
      await emitSSE("probe", { id: taskId })
      for (const reader of [first, second, member]) {
        expect(decoder.decode((await reader.read()).value)).toBe(`event: probe\ndata: ${JSON.stringify({ id: taskId })}\n\n`)
      }

      active = false
      await emitSSE("probe", { id: taskId, title: "Withheld from inactive user" })
      for (const reader of [first, second, member]) expect((await reader.read()).done).toBe(true)
    } finally {
      await Promise.all([first.cancel(), second.cancel(), member.cancel()])
    }
  } finally {
    stopEntitySubscription()
    closeHAConnection()
    globalThis.WebSocket = priorWebSocket
    if (priorToken === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = priorToken
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("closes new and cached SSE delivery after continuity is lost", async () => {
  const { reader } = await open()
  try {
    await reader.read()
    const current = await readFile(marker)
    await rm(marker)
    const head = await runWithIngressTransport(standaloneTransport, () =>
      HEAD(requestContext(new Request(url, { method: "HEAD" }))))
    const get = await runWithIngressTransport(regularStreamTransport, () => GET(requestContext(new Request(url))))
    expect(head.status).toBe(503)
    expect(get.status).toBe(503)
    for (const response of [head, get]) expect(response.headers.get("cache-control")).toBe("private, no-store")
    await emitSSE("task:updated", { id: taskId, title: "must-not-leak" })
    await writeFile(marker, current)
    await emitSSE("task:updated", { id: taskId, title: "current-only" })
    expect(decoder.decode((await reader.read()).value)).toBe(`event: task:updated\ndata: ${JSON.stringify({ id: taskId, title: "current-only" })}\n\n`)
  } finally {
    await reader.cancel()
  }
})

function holdNextAuthorityRead() {
  const db = getPersistenceClient()
  const execute = db.execute.bind(db)
  let release!: () => void
  let admitted!: () => void
  let held = false
  const ready = new Promise<void>(resolve => { admitted = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  db.execute = async statement => {
    const sql = typeof statement === "string" ? statement : statement.sql
    if (!held && sql === "SELECT revision FROM board_access_epoch WHERE singleton = 1") {
      held = true
      admitted()
      await gate
    }
    return execute(statement)
  }
  return { ready, release: () => release(), restore: () => { db.execute = execute } }
}

for (const pressure of ["bytes", "frames"]) {
  test(`bounds pending SSE ${pressure} while authority is held and reconnects without old frames`, async () => {
    const { reader } = await open()
    await reader.read()
    const held = holdNextAuthorityRead()
    const sends = [emitSSE("held", { id: taskId, title: "old" })]
    try {
      await held.ready
      for (let index = 0; index < 257; index++) {
        sends.push(emitSSE("queued", pressure === "bytes" ? { id: taskId, description: "x".repeat(4096), title: String(index) } : { id: taskId, title: String(index) }))
      }
      expect((await reader.read()).done).toBe(true)
      // Overflow releases every caller even before the held authority resolves.
      await Promise.all(sends)
    } finally {
      held.restore()
      held.release()
      await reader.cancel()
    }
    const current = await open()
    try {
      await current.reader.read()
      await emitSSE("fresh", { id: taskId, title: "current-only" })
      expect(decoder.decode((await current.reader.read()).value)).toBe(`event: fresh\ndata: ${JSON.stringify({ id: taskId, title: "current-only" })}\n\n`)
    } finally { await current.reader.cancel() }
  })
}

test("last-client cancellation releases queued SSE frames before authority resumes", async () => {
  const { reader } = await open()
  await reader.read()
  const held = holdNextAuthorityRead()
  try {
    const first = emitSSE("held", { id: taskId, title: "old" })
    await held.ready
    const second = emitSSE("queued", { id: taskId, title: "also-old" })
    await reader.cancel()
    await Promise.all([first, second])
  } finally {
    held.restore()
    held.release()
    await reader.cancel()
  }
  const current = await open()
  try {
    await current.reader.read()
    await emitSSE("fresh", { id: taskId })
    expect(decoder.decode((await current.reader.read()).value)).toBe(`event: fresh\ndata: ${JSON.stringify({ id: taskId })}\n\n`)
  } finally { await current.reader.cancel() }
})

test("a stalled SSE authority check disconnects and releases retained payloads", async () => {
  const { reader } = await open()
  await reader.read()
  const held = holdNextAuthorityRead()
  try {
    const pending = emitSSE("held", { id: taskId, title: "old" })
    await held.ready
    await pending
    expect((await reader.read()).done).toBe(true)
  } finally {
    held.restore()
    held.release()
    await reader.cancel()
  }
  const current = await open()
  try {
    await current.reader.read()
    await emitSSE("fresh", { id: taskId })
    expect(decoder.decode((await current.reader.read()).value)).toBe(`event: fresh\ndata: ${JSON.stringify({ id: taskId })}\n\n`)
  } finally { await current.reader.cancel() }
})

test("a failed SSE authority read withholds its frame until clients reconnect", async () => {
  const { reader } = await open()
  await reader.read()
  const db = getPersistenceClient()
  const execute = db.execute.bind(db)
  try {
    db.execute = async () => { throw new Error("Authority storage unavailable") }
    await emitSSE("withheld", { id: taskId, title: "old" })
    expect((await reader.read()).done).toBe(true)
    db.execute = execute
    const current = await open()
    try {
      await current.reader.read()
      await emitSSE("fresh", { id: taskId })
      expect(decoder.decode((await current.reader.read()).value)).toBe(`event: fresh\ndata: ${JSON.stringify({ id: taskId })}\n\n`)
    } finally { await current.reader.cancel() }
  } finally {
    db.execute = execute
    await reader.cancel()
  }
})
