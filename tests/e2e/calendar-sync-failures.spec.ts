import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { closeHAConnection, getHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import { getCalendarSyncStatus, startCalendarSync, stopCalendarSync, syncFromHA } from "../../apps/web/src/domains/calendar/calendar-bridge"
import { POST as manualSync } from "../../apps/web/src/pages/api/integrations/calendar/sync"
import { POST as haManualSync } from "../../apps/web/src/pages/api/ha/calendars"

type Database = ReturnType<typeof getPersistenceClient>
type Fixture = Awaited<ReturnType<typeof startHAWebSocketFixture>>
const entity = "calendar.fixture"
const event = (uid: string) => ({ uid, summary: uid, start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z" })
const test = base.extend<{ environment: { db: Database; ha: Fixture } }>({
  environment: async ({}, use) => {
    const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
    const directory = await mkdtemp(join(tmpdir(), "meitheal-calendar-failure-"))
    const ha = await startHAWebSocketFixture()
    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = "calendar-fixture"
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    const db = getPersistenceClient()
    try {
      await ensureSchema()
      expect(await getHAConnection()).not.toBeNull()
      await use({ db, ha })
    } finally {
      stopCalendarSync()
      stopEntitySubscription()
      closeHAConnection()
      await ha.close()
      db.close()
      resetPersistenceForTests()
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
})

function start(interval = 0) {
  startCalendarSync({ entityId: entity, syncEnabled: true, syncMode: "import", writeBack: false, syncIntervalMs: interval })
}

async function requestSync(route = manualSync) {
  return route({ request: new Request("http://localhost/api/integrations/calendar/sync", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync", entity_id: entity }),
  }) } as Parameters<typeof manualSync>[0])
}

test("five actual failed background merges reach backoff once each, and manual retry recovers after repair", async ({ environment: { db, ha } }) => {
  ha.setCalendarEvents([event("blocked-import")])
  await db.execute("CREATE TABLE merge_attempts (id INTEGER)")
  // FAIL preserves the preceding trigger insert, so attempts are measured at the real SQL failure.
  await db.execute(`CREATE TRIGGER fail_import BEFORE INSERT ON tasks BEGIN
    INSERT INTO merge_attempts VALUES (1); SELECT RAISE(FAIL, 'fixture import blocked'); END`)
  start(40)
  const attempts = async () => Number((await db.execute("SELECT COUNT(*) AS count FROM merge_attempts")).rows[0]?.count)
  await expect.poll(attempts).toBe(5)
  await expect.poll(() => getCalendarSyncStatus().lastSyncError).toContain("failed")
  // Observe several more background ticks. They must not perform a sixth merge.
  await new Promise(resolve => setTimeout(resolve, 180))
  expect(await attempts()).toBe(5)
  expect((await db.execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count).toBe(0)
  await db.execute("DROP TRIGGER fail_import")
  await new Promise(resolve => setTimeout(resolve, 100))
  expect((await db.execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count).toBe(0)
  expect(getCalendarSyncStatus().lastSyncError).toContain("failed")
  const response = await requestSync()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, created: 1, total: 1, failures: [] })
  expect(getCalendarSyncStatus().lastSyncError).toBeNull()
  expect((await db.execute("SELECT title FROM tasks")).rows).toEqual([expect.objectContaining({ title: "blocked-import" })])
})

test("a partial event merge returns 502 with committed counts and retains the entity error", async ({ environment: { db, ha } }) => {
  ha.setCalendarEvents([])
  start()
  await expect.poll(() => getCalendarSyncStatus().lastSyncEventCount).toBe(0)
  await expect.poll(async () => (await syncFromHA(entity)).skipped ?? null).toBeNull()
  await db.execute(`CREATE TRIGGER fail_one_import BEFORE INSERT ON tasks WHEN NEW.title = 'blocked'
    BEGIN SELECT RAISE(ABORT, 'fixture private error must not reach API'); END`)
  ha.setCalendarEvents([event("saved"), event("blocked")])
  const response = await requestSync()
  expect(response.status).toBe(502)
  const result = await response.json()
  expect(result).toMatchObject({ ok: false, partial: true, created: 1, updated: 0, total: 2 })
  expect(result.failures).toHaveLength(1)
  expect(JSON.stringify(result)).not.toContain("fixture private error")
  expect(getCalendarSyncStatus().lastSyncError).toContain("failed")
  expect((await db.execute("SELECT title FROM tasks")).rows).toEqual([expect.objectContaining({ title: "saved" })])
  expect(await syncFromHA()).toMatchObject({ created: 0, updated: 1, total: 2, failed: "1 calendar(s) failed or skipped" })
  await db.execute("DROP TRIGGER fail_one_import")
  const repaired = await syncFromHA(entity)
  expect(repaired).toEqual({ created: 1, updated: 1, total: 2 })
  expect(getCalendarSyncStatus().lastSyncError).toBeNull()
})

test("stale reconciliation failure reports partial committed imports through both manual routes", async ({ environment: { db, ha } }) => {
  ha.setCalendarEvents([event("removed"), event("remaining")])
  start()
  await expect.poll(() => getCalendarSyncStatus().lastSyncEventCount).toBe(2)
  await expect.poll(async () => (await syncFromHA(entity)).skipped ?? null).toBeNull()
  await db.execute(`CREATE TRIGGER fail_stale BEFORE UPDATE OF status ON tasks WHEN OLD.title = 'removed'
    BEGIN SELECT RAISE(ABORT, 'fixture stale update blocked'); END`)
  ha.setCalendarEvents([event("remaining"), event("new-import")])
  const response = await requestSync(haManualSync)
  expect(response.status).toBe(502)
  expect(await response.json()).toMatchObject({ ok: false, partial: true, created: 1, updated: 1, total: 2 })
  expect(getCalendarSyncStatus().lastSyncError).toContain("reconciliation")
  expect((await db.execute("SELECT status FROM tasks WHERE title = 'removed'")).rows[0]?.status).toBe("pending")
  expect((await db.execute("SELECT COUNT(*) AS count FROM tasks WHERE title = 'new-import'")).rows[0]?.count).toBe(1)
  await db.execute("DROP TRIGGER fail_stale")
  const repaired = await requestSync()
  expect(repaired.status).toBe(200)
  expect(await repaired.json()).toMatchObject({ ok: true, created: 0, updated: 2, total: 2 })
  expect((await db.execute("SELECT status FROM tasks WHERE title = 'removed'")).rows[0]?.status).toBe("complete")
  expect(getCalendarSyncStatus().lastSyncError).toBeNull()
})
