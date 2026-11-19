import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { getEventListeners, once } from "node:events"
import { createServer } from "node:http"
import { expect, test } from "@playwright/test"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
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

let work: string
let marker: string
let originalDb: string | undefined

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "sse-continuity-"))
  marker = join(work, "grants.json")
  originalDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "meitheal.db")
  await ensureSchema({ markerPath: marker })
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (originalDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = originalDb
  await rm(work, { force: true, recursive: true })
})

const url = "http://meitheal.test/api/sse"
const decoder = new TextDecoder()

async function open(signal?: AbortSignal) {
  const request = new Request(url, signal ? { signal } : undefined)
  const response = await GET({ request } as Parameters<typeof GET>[0])
  expect(response.headers.get("content-type")).toBe("text/event-stream")
  return { request, reader: response.body!.getReader() }
}

test("starts immediately and cleans up after cancellation or request abort", async () => {
  test.setTimeout(5_000)
  const head = await HEAD({ request: new Request(url, { method: "HEAD" }) } as Parameters<typeof HEAD>[0])
  expect(head.body).toBeNull()

  const { request, reader: first } = await open()
  const abort = new AbortController()
  try {
    expect(decoder.decode((await first.read()).value)).toMatch(/^event: connected\ndata: .*"clients":1}\n\n$/)
    const { request: secondRequest, reader: second } = await open(abort.signal)
    try {
      expect(decoder.decode((await second.read()).value)).toContain('"clients":2')

      await emitSSE("task:updated", { id: "example" })
      for (const reader of [first, second]) {
        expect(decoder.decode((await reader.read()).value)).toBe('event: task:updated\ndata: {"id":"example"}\n\n')
      }

      await first.cancel()
      expect(getEventListeners(request.signal, "abort")).toHaveLength(0)
      abort.abort()
      expect((await second.read()).done).toBe(true)
      expect(getEventListeners(secondRequest.signal, "abort")).toHaveLength(0)
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
      await emitSSE("example", { sequence: i, data: "x".repeat(8 * 1024) })
      expect(decoder.decode((await fast.read()).value)).toContain(`"sequence":${i}`)
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
    GET({ request: new Request("http://meitheal.test/api/%73se") } as Parameters<typeof GET>[0]),
  )
  expect(unsupportedAlias.status).toBe(404)

  let destroyed = false
  const sseSocket = {
    writableLength: 0,
    destroy() { destroyed = true },
  }
  const { request, reader } = await runWithIngressTransport({ ...transport, sseSocket }, () => open())
  try {
    expect(decoder.decode((await reader.read()).value)).toContain('"clients":1')
    sseSocket.writableLength = 64 * 1024 - 20
    await emitSSE("example", { data: "does not fit" })
    expect(destroyed).toBe(true)
    expect((await reader.read()).done).toBe(true)
    expect(getEventListeners(request.signal, "abort")).toHaveLength(0)
  } finally {
    await reader.cancel()
  }
})

test("keeps calendar, todo and mobile notification delivery on scoped HA subscriptions", async () => {
  test.setTimeout(5_000)
  let socket: EntitySocket | undefined
  class EntitySocket extends EventTarget {
    readonly OPEN = 1
    readyState = this.OPEN
    entitySubscription = 0
    eventSubscriptions = new Map<string, number>()

    constructor() {
      super()
      socket = this
      queueMicrotask(() => this.dispatchEvent(new Event("open")))
    }

    send(raw: string) {
      const { id, type, event_type } = JSON.parse(raw) as { id: number; type: string; event_type?: string }
      if (type === "subscribe_entities") this.entitySubscription = id
      if (type === "subscribe_events" && event_type) this.eventSubscriptions.set(event_type, id)
      queueMicrotask(() => this.receive(type === "auth"
        ? { type: "auth_ok", ha_version: "2026.10.4" }
        : { type: "result", id, success: true }))
    }

    receive(data: unknown) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }))
    }

    publish(eventType: string, data: unknown): number {
      const id = this.eventSubscriptions.get(eventType)
      if (id === undefined) return 0
      this.receive({ type: "event", id, event: { data } })
      return 1
    }

    close() {
      this.readyState = 3
      this.dispatchEvent(new Event("close"))
    }
  }

  const priorWebSocket = globalThis.WebSocket
  const priorToken = process.env.SUPERVISOR_TOKEN
  const priorPort = process.env.PORT
  const write = process.stdout.write
  const completionErrors: string[] = []
  const completions: { method: string | undefined; url: string | undefined; body: string }[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", chunk => { body += chunk })
    request.once("end", () => {
      completions.push({ method: request.method, url: request.url, body })
      if (request.url === "/api/tasks/busy-task") response.writeHead(503, { "Retry-After": "10" }).end()
      else response.writeHead(204).end()
    })
  }).listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a loopback TCP server")
  globalThis.WebSocket = EntitySocket as unknown as typeof WebSocket
  process.stdout.write = ((chunk: string | Uint8Array) => {
    if (String(chunk).includes('"event":"ha.notification.action_failed"')) {
      completionErrors.push(String(chunk))
      return true
    }
    return write.call(process.stdout, chunk)
  }) as typeof process.stdout.write
  process.env.SUPERVISOR_TOKEN = "test-token"
  process.env.PORT = String(address.port)
  try {
    await initEntitySubscription()
    let unrelatedFrames = 0
    for (let index = 0; index < 32; index++) {
      unrelatedFrames += socket!.publish("state_changed", { entity_id: "sensor.unrelated" })
      unrelatedFrames += socket!.publish("call_service", { domain: "light", service: "turn_on" })
    }
    expect(unrelatedFrames).toBe(0)
    expect([...socket!.eventSubscriptions.keys()].sort()).toEqual([
      "component_loaded",
      "entity_registry_updated",
      "meitheal_area_updated",
      "meitheal_task_completed",
      "meitheal_task_created",
      "meitheal_task_deleted",
      "meitheal_task_updated",
      "mobile_app_notification_action",
    ])
    expect(socket!.publish("mobile_app_notification_action", { action: "MEITHEAL_TASK_DONE_sample-task" })).toBe(1)
    await expect.poll(() => completions).toEqual([
      { method: "PUT", url: "/api/tasks/sample-task", body: '{"status":"complete"}' },
    ])
    expect(socket!.publish("mobile_app_notification_action", { action: "MEITHEAL_TASK_DONE_busy-task" })).toBe(1)
    await expect.poll(() => completionErrors).toEqual([
      expect.stringContaining("Task completion returned HTTP 503 (Retry-After: 10)"),
    ])
    expect(completions.at(-1)).toEqual(
      { method: "PUT", url: "/api/tasks/busy-task", body: '{"status":"complete"}' },
    )
    const delivered: string[] = []
    const unsubscribe = onEntityChange("sensor.resubscribe", entity => {
      delivered.push(entity.state)
      unsubscribe()
      onEntityChange("sensor.resubscribe", next => { delivered.push(next.state) })
    })

    socket!.receive({
      type: "event",
      id: socket!.entitySubscription,
      event: { a: {
        "calendar.test": { s: "off", a: {}, lc: 1, c: "seed" },
        "todo.test": { s: "1", a: {}, lc: 1, c: "seed" },
        "sensor.unwatched": { s: "off", a: {}, lc: 1, c: "seed" },
        "sensor.resubscribe": { s: "off", a: {}, lc: 1, c: "seed" },
      } },
    })
    expect(getCalendarEntities()).toHaveLength(1)
    expect(getTodoEntities()).toHaveLength(1)
    expect(getEntity("sensor.unwatched")).toBeUndefined()
    expect(delivered).toEqual(["off"])
    delivered.length = 0

    const { reader: first } = await open()
    const { reader: second } = await open()
    try {
      await Promise.all([first.read(), second.read()])
      socket!.receive({
        type: "event",
        id: socket!.entitySubscription,
        event: { c: {
          "calendar.test": { "+": { s: "on", lu: 2 } },
          "todo.test": { "+": { lu: 2 } },
          "sensor.unwatched": { "+": { s: "on", lu: 2 } },
          "sensor.resubscribe": { "+": { s: "on", lu: 2 } },
        } },
      })
      expect(delivered).toEqual(["on"])
      expect(getEntity("sensor.unwatched")).toBeUndefined()
      await emitSSE("probe", {})
      for (const reader of [first, second]) {
        expect(decoder.decode((await reader.read()).value)).toMatch(/^event: ha:entity_changed\ndata: .*"entity_id":"calendar.test","state":"on"/)
        expect(decoder.decode((await reader.read()).value)).toMatch(/^event: ha:entity_changed\ndata: .*"entity_id":"todo.test","state":"1".*"last_updated":"1970-01-01T00:00:02.000Z"/)
        expect(decoder.decode((await reader.read()).value)).toBe("event: probe\ndata: {}\n\n")
      }

      socket!.receive({
        type: "event",
        id: socket!.entitySubscription,
        event: {
          c: {
            "todo.test": { "+": { s: "1", lu: 2 } },
            "sensor.resubscribe": { "+": { s: "off", lu: 3 } },
          },
          r: ["calendar.test"],
        },
      })
      expect(delivered).toEqual(["on", "off"])
      expect(getCalendarEntities()).toHaveLength(0)
      await emitSSE("probe", {})
      for (const reader of [first, second]) {
        expect(decoder.decode((await reader.read()).value)).toBe("event: probe\ndata: {}\n\n")
      }

      socket!.receive({
        type: "event",
        id: socket!.entitySubscription,
        event: { a: { "calendar.test": { s: "off", a: {}, lc: 4, c: "seed" } } },
      })
      expect(getCalendarEntities()).toHaveLength(1)
      for (const reader of [first, second]) {
        expect(decoder.decode((await reader.read()).value)).toMatch(/^event: ha:entity_changed\ndata: .*"entity_id":"calendar.test","state":"off"/)
      }
    } finally {
      await Promise.all([first.cancel(), second.cancel()])
    }
  } finally {
    stopEntitySubscription()
    closeHAConnection()
    process.stdout.write = write
    globalThis.WebSocket = priorWebSocket
    if (priorToken === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = priorToken
    if (priorPort === undefined) delete process.env.PORT
    else process.env.PORT = priorPort
    const closed = once(server, "close")
    server.close()
    server.closeAllConnections()
    await closed
  }
})

test("closes new and cached SSE delivery after continuity is lost", async () => {
  const { reader } = await open()
  try {
    await reader.read()
    const current = await readFile(marker)
    await rm(marker)
    const head = await HEAD({ request: new Request(url, { method: "HEAD" }) } as Parameters<typeof HEAD>[0])
    const get = await GET({ request: new Request(url) } as Parameters<typeof GET>[0])
    expect(head.status).toBe(503)
    expect(get.status).toBe(503)
    await emitSSE("task:updated", { id: "must-not-leak" })
    await writeFile(marker, current)
    await emitSSE("task:updated", { id: "current-only" })
    expect(decoder.decode((await reader.read()).value)).toBe('event: task:updated\ndata: {"id":"current-only"}\n\n')
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
    const sends = [emitSSE("held", { private: "old" })]
    try {
      await held.ready
      for (let index = 0; index < 257; index++) {
        sends.push(emitSSE("queued", pressure === "bytes" ? { data: "x".repeat(4096), index } : { index }))
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
      await emitSSE("fresh", { id: "current-only" })
      expect(decoder.decode((await current.reader.read()).value)).toBe('event: fresh\ndata: {"id":"current-only"}\n\n')
    } finally { await current.reader.cancel() }
  })
}

test("last-client cancellation releases queued SSE frames before authority resumes", async () => {
  const { reader } = await open()
  await reader.read()
  const held = holdNextAuthorityRead()
  try {
    const first = emitSSE("held", { private: "old" })
    await held.ready
    const second = emitSSE("queued", { private: "also-old" })
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
    await emitSSE("fresh", {})
    expect(decoder.decode((await current.reader.read()).value)).toBe("event: fresh\ndata: {}\n\n")
  } finally { await current.reader.cancel() }
})

test("a stalled SSE authority check disconnects and releases retained payloads", async () => {
  const { reader } = await open()
  await reader.read()
  const held = holdNextAuthorityRead()
  try {
    const pending = emitSSE("held", { private: "old" })
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
    await emitSSE("fresh", {})
    expect(decoder.decode((await current.reader.read()).value)).toBe("event: fresh\ndata: {}\n\n")
  } finally { await current.reader.cancel() }
})

test("a failed SSE authority read withholds its frame and leaves delivery usable", async () => {
  const { reader } = await open()
  await reader.read()
  const db = getPersistenceClient()
  const execute = db.execute.bind(db)
  try {
    db.execute = async () => { throw new Error("Authority storage unavailable") }
    await emitSSE("withheld", { private: "old" })
    db.execute = execute
    await emitSSE("fresh", {})
    expect(decoder.decode((await reader.read()).value)).toBe("event: fresh\ndata: {}\n\n")
  } finally {
    db.execute = execute
    await reader.cancel()
  }
})
