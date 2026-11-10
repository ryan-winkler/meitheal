import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { checkOverdueTaskEvents, OVERDUE_BATCH_LIMIT, OVERDUE_CHECKPOINT_KEY } from "../../apps/web/src/domains/tasks/overdue-task-events"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { SettingsRepository } from "../../apps/web/src/domains/tasks/persistence/settings-repository"
import { resetWebhookCacheForTests } from "../../apps/web/src/lib/webhook-dispatcher"
import { checkDueDates, invalidateSettingsCache, stopDueDateReminders } from "../../apps/web/src/domains/notifications/due-date-reminders"

const START = Date.parse("2026-11-10T12:00:00Z")
let directory: string
let previousDbUrl: string | undefined
const events: Array<{ event: string; task: Record<string, unknown>; requestId: string }> = []
const dispatch = async (event: string, task: Record<string, unknown>, requestId: string) => { events.push({ event, task, requestId }) }

async function addTask(id: string, due: string, status = "pending", updated = START - 10_000) {
  await getPersistenceClient().execute({
    sql: `INSERT INTO tasks (id, title, due_date, status, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, `Task ${id}`, due, status, id, id, updated, updated],
  })
}

async function tick(now: number, delivery = dispatch) {
  return checkOverdueTaskEvents(getPersistenceClient(), delivery, now)
}

async function ledgerCount() {
  return Number((await getPersistenceClient().execute("SELECT count(*) AS count FROM domain_events WHERE event_type = 'task.overdue'")).rows[0]?.count)
}

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-overdue-"))
  previousDbUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  resetPersistenceForTests()
  await ensureSchema()
  events.length = 0
  invalidateSettingsCache()
  resetWebhookCacheForTests()
})

test.afterEach(async () => {
  stopDueDateReminders()
  resetPersistenceForTests()
  if (previousDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDbUrl
  await rm(directory, { recursive: true, force: true })
})

test("fresh schema establishes a durable baseline without replaying historical overdue tasks", async () => {
  await addTask("historical", "2025-01-01")
  expect(await tick(START)).toEqual({ observed: 0, dispatchFailed: 0, baselineCreated: true })
  expect(await tick(START + 300_000)).toMatchObject({ observed: 0 })
  expect(await ledgerCount()).toBe(0)
  expect((await getPersistenceClient().execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [OVERDUE_CHECKPOINT_KEY] })).rows[0]?.value).toBe(String(START + 300_000))
  expect((await getPersistenceClient().execute("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")).rows).toHaveLength(0)
})

test("ISO, date-only, offset and epoch deadlines cross once; terminal and invalid tasks are skipped", async () => {
  const start = Date.parse("2026-11-09T23:59:00Z")
  await addTask("iso", "2026-11-10T00:00:00.000Z")
  await addTask("date", "2026-11-10")
  await addTask("offset", "2026-11-10T01:00:00+01:00")
  await addTask("epoch", String(start + 60_000))
  await addTask("future", "2027-01-01")
  await addTask("invalid", "nonsense")
  for (const status of ["complete", "done", "archived", "cancelled", "canceled"]) await addTask(status, "2026-11-10", status)
  await tick(start)
  expect(await tick(start + 120_000)).toMatchObject({ observed: 4 })
  expect(events.map(entry => entry.task.id).sort()).toEqual(["date", "epoch", "iso", "offset"])
  expect(events.every(entry => entry.event === "task.overdue" && !('overdue_due_ms' in entry.task))).toBe(true)
  expect(await tick(start + 300_000)).toMatchObject({ observed: 0 })
  expect(await ledgerCount()).toBe(4)
})

test("a changed due date gets one new episode, including deadlines moved into the past", async () => {
  await addTask("edited", new Date(START + 1_000).toISOString())
  await tick(START)
  expect(await tick(START + 2_000)).toMatchObject({ observed: 1 })
  await getPersistenceClient().execute({ sql: "UPDATE tasks SET due_date = ?, updated_at = ? WHERE id = 'edited'", args: ["2026-01-01", START + 3_000] })
  expect(await tick(START + 4_000)).toMatchObject({ observed: 1 })
  await getPersistenceClient().execute({ sql: "UPDATE tasks SET status = 'complete', updated_at = ? WHERE id = 'edited'", args: [START + 5_000] })
  await tick(START + 6_000)
  await getPersistenceClient().execute({ sql: "UPDATE tasks SET status = 'pending', updated_at = ? WHERE id = 'edited'", args: [START + 7_000] })
  expect(await tick(START + 8_000)).toMatchObject({ observed: 0 })
  expect(await ledgerCount()).toBe(2)
})

test("bounded backlog drains across subsequent ticks and process restarts without duplicate claims", async () => {
  await tick(START)
  for (let i = 0; i < OVERDUE_BATCH_LIMIT * 2 + 3; i++) await addTask(`backlog-${i}`, new Date(START + 1_000).toISOString())
  expect(await tick(START + 2_000)).toMatchObject({ observed: OVERDUE_BATCH_LIMIT })
  resetPersistenceForTests() // Reopen the same SQLite file, retaining baseline and claims.
  const results = await Promise.all([tick(START + 3_000), tick(START + 3_000)])
  expect(results.reduce((sum, result) => sum + result.observed, 0)).toBeLessThanOrEqual(OVERDUE_BATCH_LIMIT * 2)
  await tick(START + 4_000)
  expect(await ledgerCount()).toBe(OVERDUE_BATCH_LIMIT * 2 + 3)
  expect(new Set(events.map(entry => entry.requestId)).size).toBe(events.length)
  expect(await tick(START + 5_000)).toMatchObject({ observed: 0 })
})

test("a failed best-effort delivery is durably observed and is not falsely retried as a new transition", async () => {
  await addTask("offline", new Date(START + 1_000).toISOString())
  await tick(START)
  expect(await tick(START + 2_000, async () => { throw new Error("HA unavailable") })).toEqual({ observed: 1, dispatchFailed: 1, baselineCreated: false })
  resetPersistenceForTests()
  expect(await tick(START + 3_000)).toMatchObject({ observed: 0 })
  expect(events).toHaveLength(0)
  expect(await ledgerCount()).toBe(1)
})

test("scheduler still produces overdue domain events with reminder notifications disabled and HA unconfigured", async () => {
  const settings = new SettingsRepository(getPersistenceClient())
  await settings.ensureSettingsTable()
  await settings.upsert("notification_preferences", JSON.stringify({ enabled: false, due_date_reminders: false }))
  await addTask("silent", new Date(START + 1_000).toISOString())
  await checkDueDates(START)
  await checkDueDates(START + 2_000)
  expect(await ledgerCount()).toBe(1)
  await checkDueDates(START + 3_000)
  expect(await ledgerCount()).toBe(1)
})


test("the scheduler routes task.overdue to a configured n8n webhook even when reminders are disabled", async () => {
  const received: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", chunk => { body += chunk })
    request.on("end", () => {
      received.push(JSON.parse(body))
      response.writeHead(200).end("OK")
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const settings = new SettingsRepository(getPersistenceClient())
    await settings.ensureSettingsTable()
    await settings.upsert("notification_preferences", JSON.stringify({ due_date_reminders: false }))
    await settings.upsert("n8n_webhook_url", JSON.stringify(`http://127.0.0.1:${(server.address() as AddressInfo).port}/overdue`))
    await settings.upsert("n8n_events", JSON.stringify(["task.overdue"]))
    await addTask("n8n-task", new Date(START + 1_000).toISOString())
    await checkDueDates(START)
    await checkDueDates(START + 2_000)
    await expect.poll(() => received.length).toBe(1)
    expect(received[0]).toMatchObject({ eventType: "task.overdue", payload: { id: "n8n-task", due_date: new Date(START + 1_000).toISOString() } })
    await expect.poll(async () => (await settings.getByKey("n8n_last_delivery")) !== null).toBe(true)
    await checkDueDates(START + 3_000)
    expect(received).toHaveLength(1)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})


test("parallel cold-start callers share one schema bootstrap before the first scheduler baseline", async () => {
  resetPersistenceForTests()
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "cold-start.db")}`
  await Promise.all(Array.from({ length: 8 }, () => ensureSchema()))
  await checkDueDates(START)
  expect((await getPersistenceClient().execute({ sql: "SELECT value FROM app_settings WHERE key = ?", args: [OVERDUE_CHECKPOINT_KEY] })).rows[0]?.value).toBe(String(START))
  expect((await getPersistenceClient().execute("PRAGMA integrity_check")).rows[0]?.integrity_check).toBe("ok")
})


test("explicit empty n8n event selection delivers nothing while absent selection retains defaults", async () => {
  const received: Array<Record<string, unknown>> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", chunk => { body += chunk })
    request.on("end", () => { received.push(JSON.parse(body)); response.writeHead(200).end("OK") })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    const settings = new SettingsRepository(getPersistenceClient())
    await settings.ensureSettingsTable()
    await settings.upsert("notification_preferences", JSON.stringify({ due_date_reminders: false }))
    await settings.upsert("n8n_webhook_url", JSON.stringify(`http://127.0.0.1:${(server.address() as AddressInfo).port}/overdue`))
    await settings.upsert("n8n_events", JSON.stringify([]))
    await addTask("unselected-task", new Date(START + 1000).toISOString())
    await checkDueDates(START)
    await checkDueDates(START + 2000)
    expect(await ledgerCount()).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(received).toHaveLength(0)
    await getPersistenceClient().execute("DELETE FROM settings WHERE key = 'n8n_events'")
    resetWebhookCacheForTests()
    await addTask("default-task", new Date(START + 3000).toISOString())
    await checkDueDates(START + 4000)
    await expect.poll(() => received.length).toBe(1)
    expect(received[0]).toMatchObject({ eventType: "task.overdue", payload: { id: "default-task" } })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
