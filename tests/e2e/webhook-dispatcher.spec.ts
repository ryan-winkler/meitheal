import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { TaskRepository, readWorkDestinations, saveWorkBinding } from "../../apps/web/src/domains/tasks"
import { dispatchTaskEvent } from "../../apps/web/src/lib/webhook-dispatcher"
import dns from "node:dns"
import { once } from "node:events"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, test } from "@playwright/test"
import { emitWebhook } from "../../packages/integration-core/src/webhook-emitter"

test("the development webhook dispatcher reaches the configured internal host", async () => {
  const server = createServer((_request, response) => response.writeHead(204).end())
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo

  const lookup = dns.lookup
  const originalEnv = process.env.NODE_ENV
  process.env.NODE_ENV = "development"
  dns.lookup = ((hostname: string, options: dns.LookupOptions, callback: (...args: unknown[]) => void) => {
    if (hostname !== "webhook.internal") throw new Error("Unexpected DNS lookup")
    if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }])
    else callback(null, "127.0.0.1", 4)
  }) as typeof dns.lookup

  try {
    const result = await emitWebhook(
      { eventId: "event", eventType: "task.created", occurredAt: "2026-01-01T00:00:00Z", requestId: "request", payload: {} },
      { id: "subscriber", url: `http://webhook.internal:${port}/`, secret: "fixture", enabled: true, events: ["task.created"] }
    )
    expect(result).toMatchObject({ ok: true, statusCode: 204, attempts: 1 })
  } finally {
    dns.lookup = lookup
    if (originalEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalEnv
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
})

test("queued webhook retry rechecks live delivery authority", async () => {
  let requests = 0
  let allowed = true
  const server = createServer((_request, response) => {
    requests++
    allowed = false
    response.writeHead(503).end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  const originalEnv = process.env.NODE_ENV
  process.env.NODE_ENV = "development"
  try {
    const result = await emitWebhook(
      { eventId: "retry", eventType: "task.created", occurredAt: "2026-01-01T00:00:00Z", requestId: "retry", payload: {} },
      { id: "subscriber", url: `http://127.0.0.1:${port}/`, secret: "fixture", enabled: true, events: ["task.created"] },
      { operationAllowed: () => allowed },
    )
    expect(result.ok).toBe(false)
    expect(result.finalError).toBe("Delivery authority is unavailable")
    expect(requests).toBe(1)
  } finally {
    if (originalEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalEnv
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("cached webhook settings cannot deliver Household payloads after marker loss", async () => {
  const work = await mkdtemp(join(tmpdir(), "webhook-continuity-"))
  const marker = join(work, "grants.json")
  const originalDb = process.env.MEITHEAL_DB_URL
  const originalEnv = process.env.NODE_ENV
  const originalSupervisor = process.env.SUPERVISOR_TOKEN
  let requests = 0
  const server = createServer((_request, response) => { requests++; response.writeHead(204).end() })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const { port } = server.address() as AddressInfo
  try {
    process.env.MEITHEAL_DB_URL = "file:" + join(work, "meitheal.db")
    process.env.NODE_ENV = "development"
    delete process.env.SUPERVISOR_TOKEN
    await ensureSchema({ markerPath: marker })
    await getPersistenceClient().execute({ sql: "INSERT INTO settings(key, value, updated_at) VALUES ('webhook_endpoint', ?, 1)", args: [JSON.stringify(`http://127.0.0.1:${port}/`)] })
    const db = getPersistenceClient()
    const initial = await currentBoardScope(db)
    const config = await readWorkDestinations(db)
    if (!config) throw new Error("Current configuration required")
    const approved = await saveWorkBinding(db, initial.principal, config.revision, { id: crypto.randomUUID(), generation: 1, enabled: true, integration: "webhook", sourceId: "generic-webhook", purpose: "webhook.delivery", destination: { boardId: initial.boardId }, allowedOperations: [{ resource: "task", action: "read" }] })
    if (!approved.ok) throw new Error("Explicit webhook approval required")
    const scope = await currentBoardScope(db)
    const now = Date.now()
    await getPersistenceClient().execute({ sql: "INSERT INTO tasks(id,title,status,idempotency_key,request_id,created_at,updated_at) VALUES (?,?,'pending',?,?,?,?)", args: ["current", "Current", "current", "current", now, now] })
    const task = await new TaskRepository(getPersistenceClient(), scope).findById("current")
    if (!task) throw new Error("Current owned Task required")
    await dispatchTaskEvent("task.created", task, undefined, undefined, undefined, undefined, scope)
    await expect.poll(() => requests).toBe(1)
    await rm(marker)
    await dispatchTaskEvent("task.created", task, undefined, undefined, undefined, undefined, scope)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(requests).toBe(1)
  } finally {
    resetPersistenceForTests()
    for (const [key, value] of [["MEITHEAL_DB_URL", originalDb], ["NODE_ENV", originalEnv], ["SUPERVISOR_TOKEN", originalSupervisor]]) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(work, { recursive: true, force: true })
  }
})
