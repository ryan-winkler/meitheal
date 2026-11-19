import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { createServer as createPortReservation } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { createTaskWithFrameworkAndCalendarSync } from "../../packages/domain-tasks/src/index"
import type { CalendarIntegrationAdapter, CalendarResult } from "../../packages/integration-core/src/index"
import { createTaskAndSyncCalendar } from "../../apps/web/src/domains/tasks/task-sync-service"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import {
  ensureSchema, findByIdempotencyKey, findTaskById, getPersistenceClient, persistCalendarIntegrationResult,
  persistInitialPlan, persistManualCalendarConfirmation, resetPersistenceForTests,
} from "../helpers/persistence-fixture"

const web = resolve(import.meta.dirname, "../../apps/web")
const tables = ["tasks", "integration_attempts", "calendar_confirmations", "domain_events", "audit_trail"]
const input = (key: string) => ({ title: key, requestId: "request-" + key, idempotencyKey: key,
  calendarDefaults: { enabled: true, entityId: "calendar.home", defaultDurationMinutes: 15, timezone: "Europe/Dublin" } })
const plan = (key: string) => createTaskWithFrameworkAndCalendarSync({ title: key, requestId: "request-" + key, idempotencyKey: key,
  calendar: { startDateTime: "2026-11-19T10:00:00Z", endDateTime: "2026-11-19T10:15:00Z", timezone: "Europe/Dublin" } })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function records() {
  const db = getPersistenceClient()
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows])))
}

let work: string
let marker: string
let previousDb: string | undefined

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "continuity-store-sync-"))
  marker = join(work, "grants.json")
  previousDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
  resetPersistenceForTests()
  await ensureSchema({ markerPath: marker })
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDb
  await rm(work, { recursive: true, force: true })
})

test("public store helpers preserve healthy confirmations and reject reads and every persistence outcome after marker loss", async () => {
  const currentPlan = plan("direct-current")
  await persistInitialPlan(currentPlan, "Retained description")
  const taskId = currentPlan.aggregate.task.id
  const result = { taskId, requestId: currentPlan.aggregate.requestId, idempotencyKey: currentPlan.aggregate.idempotencyKey,
    result: { ok: true, confirmationId: "provider-confirmation", providerEventId: "remote-event", raw: { accepted: true } } as CalendarResult }
  expect((await persistCalendarIntegrationResult(result)).integration).toMatchObject({ calendarSyncState: "confirmed", confirmationId: "provider-confirmation" })
  expect(await findTaskById(taskId)).toMatchObject({ id: taskId, title: "direct-current" })
  expect(await findByIdempotencyKey("direct-current")).toMatchObject({ task: { id: taskId } })
  const manual = { taskId, requestId: "manual-current", confirmationId: "manual-current" }
  expect(await persistManualCalendarConfirmation(manual)).toEqual({ confirmationId: "manual-current", alreadyExisted: false })
  expect(await persistManualCalendarConfirmation(manual)).toEqual({ confirmationId: "manual-current", alreadyExisted: true })
  const before = await records()
  await rm(marker)
  for (const operation of [
    () => findTaskById(taskId), () => findByIdempotencyKey("direct-current"),
    () => persistInitialPlan(plan("denied-plan"), null),
    () => persistCalendarIntegrationResult({ ...result, result: { ok: true, confirmationId: "denied-confirmation" } }),
    () => persistCalendarIntegrationResult({ ...result, result: { ok: false, errorCode: "timeout", retryable: true } }),
    () => persistManualCalendarConfirmation({ ...manual, confirmationId: "denied-manual" }),
  ]) await expect(operation()).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
  expect(await records()).toEqual(before)
})

test("markerless initial sync and assigned idempotent replay neither dispatch nor change saved records", async () => {
  let calls = 0
  const adapter: CalendarIntegrationAdapter = { async createEvent() { calls++; return { ok: true, confirmationId: "current-sync" } } }
  const current = await createTaskAndSyncCalendar(input("current-sync"), adapter)
  expect(current.integration.calendarSyncState).toBe("confirmed")
  expect((await createTaskAndSyncCalendar(input("current-sync"), adapter)).idempotentReplay).toBe(true)
  expect(calls).toBe(1)
  const before = await records()
  await rm(marker)
  for (const request of [input("denied-sync"), { ...input("current-sync"), assignedTo: "custom_denied" }]) {
    await expect(createTaskAndSyncCalendar(request, adapter)).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
  }
  expect(calls).toBe(1)
  expect(await records()).toEqual(before)
})

test("authority is checked again at Calendar dispatch after initial plan commit", async () => {
  const db = getPersistenceClient()
  const transaction = db.transaction.bind(db)
  const batch = db.batch.bind(db)
  let before: Awaited<ReturnType<typeof records>> | undefined
  let removed = false
  const loseAuthority = async () => {
    if (removed) return
    removed = true
    await rm(marker)
    before = await records()
  }
  db.batch = async (...args) => {
    const result = await batch(...args)
    await loseAuthority()
    return result
  }
  db.transaction = async (mode?: "read" | "write" | "deferred") => {
    const tx = await transaction(mode)
    const commit = tx.commit.bind(tx)
    tx.commit = async () => {
      await commit()
      await loseAuthority()
    }
    return tx
  }
  let calls = 0
  try {
    await expect(createTaskAndSyncCalendar(input("lost-before-dispatch"), {
      async createEvent() { calls++; return { ok: true, confirmationId: "must-not-dispatch" } },
    })).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
    expect(removed).toBe(true)
    expect(calls).toBe(0)
    expect(before).toBeDefined()
    expect(await records()).toEqual(before)
  } finally { db.transaction = transaction; db.batch = batch }
})

for (const outcome of ["success", "failure"] as const) {
  test(`an admitted remote ${outcome} cannot persist completion after marker loss`, async () => {
    const entered = deferred()
    const release = deferred()
    let calls = 0
    const completion = createTaskAndSyncCalendar(input("inflight-" + outcome), {
      async createEvent() {
        calls++
        entered.resolve()
        await release.promise
        return outcome === "success" ? { ok: true, confirmationId: "remote-completed" }
          : { ok: false, errorCode: "timeout", retryable: true }
      },
    })
    // Attach the expected rejection before releasing the provider to avoid an unhandled rejection.
    const denied = expect(completion).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
    try {
      await entered.promise
      const before = await records()
      expect((before.tasks as unknown[])).toHaveLength(1)
      await rm(marker)
      release.resolve()
      await denied
      expect(calls).toBe(1)
      expect(await records()).toEqual(before)
    } finally { release.resolve(); await completion.catch(() => {}) }
  })
}

test("retired Household helpers withhold task replay and Calendar delivery", async () => {
  const currentPlan = plan("retired-current")
  await persistInitialPlan(currentPlan, null)
  expect(await new NamedBoardRepository(getPersistenceClient()).changeLifecycle({ kind: "ha_user", id: "operator" }, "household", "retired", 1, true))
    .toMatchObject({ status: "committed", result: "saved" })
  const before = await records()
  expect(await findTaskById(currentPlan.aggregate.task.id)).toBeNull()
  expect(await findByIdempotencyKey("retired-current")).toBeNull()
  let calls = 0
  await expect(createTaskAndSyncCalendar(input("retired-current"), {
    async createEvent() { calls++; return { ok: true, confirmationId: "denied" } },
  })).rejects.toMatchObject({ status: 409 })
  expect(calls).toBe(0)
  expect(await records()).toEqual(before)
})

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const ended = once(child, "exit")
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000)
  try { await ended } finally { clearTimeout(timer) }
}
function diskRecords(database: string) {
  const db = new DatabaseSync(database, { readOnly: true })
  try { return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) }
  finally { db.close() }
}

// The real shipped route resolves its content config and constructs the real HA HTTP
// adapter. Its provider response is event-gated; no handler or fetch is substituted.
test("real task-sync HTTP route withholds an in-flight provider result and blocks subsequent markerless capture", async ({}, info) => {
  test.setTimeout(60_000)
  const data = join(work, "http")
  await mkdir(data)
  const database = join(data, "tasks.db")
  const routeMarker = join(data, "grants.json")
  const entered = deferred()
  const release = deferred()
  let requests = 0
  const provider = createServer(async (_request, response) => {
    requests++
    if (requests === 2) { entered.resolve(); await release.promise }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ event_id: "route-event-" + requests }]))
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  const providerAddress = provider.address()
  if (!providerAddress || typeof providerAddress === "string") throw new Error("Provider did not bind")
  const reservation = createPortReservation()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const address = reservation.address()
  if (!address || typeof address === "string") throw new Error("App reservation did not bind")
  const port = address.port
  await new Promise<void>(done => reservation.close(() => done()))
  const env: NodeJS.ProcessEnv = { ...process.env, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production",
    MEITHEAL_DB_URL: "file:" + database, MEITHEAL_BOARD_GRANT_PATH: routeMarker,
    HA_BASE_URL: `http://127.0.0.1:${providerAddress.port}`, HA_TOKEN: "isolated-synthetic-route-token" }
  delete env.SUPERVISOR_TOKEN
  delete env.MEITHEAL_STARTUP_BACKUP_HANDLED
  delete env.INGRESS_PATH
  const child = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: web, env, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  child.stdout!.on("data", bytes => { log = (log + bytes.toString()).slice(-16_384) })
  child.stderr!.on("data", bytes => { log = (log + bytes.toString()).slice(-16_384) })
  const origin = `http://127.0.0.1:${port}`
  const create = (title: string) => fetch(origin + "/api/tasks/create", { method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ title, assigned_to: "custom_route" }) })
  try {
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => finish(new Error("App startup timed out\n" + log)), 15_000)
      const onExit = () => finish(new Error("App exited during startup\n" + log))
      const onData = () => { if (log.includes("Meitheal server listening on")) finish() }
      const finish = (error?: Error) => { clearTimeout(timeout); child.off("exit", onExit); child.stdout!.off("data", onData); error ? reject(error) : done() }
      child.once("exit", onExit)
      child.stdout!.on("data", onData)
      onData()
    })
    const current = await create("Healthy route capture")
    expect(current.status, await current.clone().text()).toBe(201)
    expect((await current.json()).integration.calendarSyncState).toBe("confirmed")
    const completion = create("In-flight route capture")
    await entered.promise
    const before = diskRecords(database)
    await rm(routeMarker)
    release.resolve()
    const denied = await completion
    expect(denied.status).toBe(503)
    expect(await denied.text()).toContain("continuity is locked")
    expect(diskRecords(database)).toEqual(before)
    const after = await create("Denied route capture")
    expect(after.status).toBe(503)
    expect(requests).toBe(2)
    expect(diskRecords(database)).toEqual(before)
    await info.attach("real-task-sync-continuity.json", { body: JSON.stringify({ healthyStatus: current.status, inflightStatus: denied.status,
      lockedStatus: after.status, providerRequests: requests, recordsUnchangedAfterMarkerLoss: true }), contentType: "application/json" })
  } finally {
    release.resolve()
    await stop(child)
    provider.closeAllConnections()
    await new Promise<void>(done => provider.close(() => done()))
  }
})
