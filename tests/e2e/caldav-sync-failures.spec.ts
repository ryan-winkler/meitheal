import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { getCalendarSyncStatus, startCalDAVSync, stopCalDAVSync, syncCalDAVEvents } from "../../apps/web/src/domains/calendar/calendar-bridge"
import { validateCalDAVUrl } from "../../apps/web/src/domains/calendar/caldav-client"
import { POST as saveCredentials } from "../../apps/web/src/pages/api/integrations/calendar/caldav-credentials"
import { POST as manualSync } from "../../apps/web/src/pages/api/integrations/calendar/sync"

const origin = "http://caldav-fixture.example"
const xml = (body: string) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`
const calendar = (name: string) => `<d:response><d:href>/${name}/</d:href><d:propstat><d:prop><d:displayname>${name}</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`
const event = (uid: string) => `<d:response><d:href>/${uid}.ics</d:href><d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:${uid}\r\nDTSTART:20261110T100000Z\r\nDTEND:20261110T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR</c:calendar-data></d:prop></d:propstat></d:response>`
type Database = ReturnType<typeof getPersistenceClient>
type WebDAV = { calendars: string[]; events: Record<string, string[]>; failures: Set<string>; propfindStatus: number; propfinds: number; reports: number }
const test = base.extend<{ environment: { db: Database; dav: WebDAV } }>({
  environment: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "meitheal-caldav-failure-"))
    const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_TOKEN"].map(key => [key, process.env[key]]))
    const originalFetch = globalThis.fetch
    const dav: WebDAV = { calendars: ["good", "bad"], events: {}, failures: new Set(), propfindStatus: 207, propfinds: 0, reports: 0 }
    const server = createServer(async (request, response) => {
      for await (const _ of request) { /* consume the real XML request */ }
      if (request.headers.authorization !== "Basic " + Buffer.from("fixture-user:fixture-password").toString("base64")) {
        response.writeHead(401).end()
        return
      }
      response.setHeader("content-type", "application/xml")
      if (request.method === "PROPFIND") {
        dav.propfinds++
        response.writeHead(dav.propfindStatus).end(xml(dav.calendars.map(calendar).join("")))
      } else if (request.method === "REPORT") {
        dav.reports++
        const name = request.url!.split("/")[1]!
        response.writeHead(dav.failures.has(name) ? 503 : 207).end(xml((dav.events[name] ?? []).map(event).join("")))
      } else response.writeHead(405).end()
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address")
    // Transport-only adapter: run the real client/parser against loopback HTTP without relaxing its SSRF policy.
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input)
      if (target.origin !== origin) throw new Error("Unexpected fixture egress")
      target.hostname = "127.0.0.1"
      target.port = String(address.port)
      return originalFetch(target, init)
    }) as typeof fetch
    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_TOKEN = "caldav-fixture-encryption-key"
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    const db = getPersistenceClient()
    try {
      await ensureSchema()
      const saved = await saveCredentials({ locals: { hassIsAdmin: true }, request: new Request("http://localhost/api/integrations/calendar/caldav-credentials", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "save", url: origin, username: "fixture-user", password: "fixture-password" }),
      }) } as unknown as Parameters<typeof saveCredentials>[0])
      expect(saved.status).toBe(200)
      await use({ db, dav })
    } finally {
      stopCalDAVSync()
      globalThis.fetch = originalFetch
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
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

async function ready() {
  startCalDAVSync(origin, 0)
  await expect.poll(() => getCalendarSyncStatus().lastSyncAt).not.toBeNull()
  await expect.poll(async () => (await syncCalDAVEvents()).skipped ?? null).toBeNull()
}

async function retry() {
  return manualSync({ request: new Request("http://localhost/api/integrations/calendar/sync", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync" }),
  }) } as Parameters<typeof manualSync>[0])
}

test("actual CalDAV REPORT failure retains saved imports and returns a partial manual outcome", async ({ environment: { db, dav } }) => {
  expect(validateCalDAVUrl("http://127.0.0.1/calendar").valid).toBe(false)
  await ready()
  dav.events.good = ["saved"]
  dav.failures.add("bad")
  const response = await retry()
  expect(response.status).toBe(502)
  const result = await response.json()
  expect(result).toMatchObject({ ok: false, partial: true, created: 1, updated: 0, total: 1, entities: ["caldav"] })
  expect(result.failures).toEqual([{ entity_id: "caldav", error: "1 CalDAV calendar(s) failed to fetch or import" }])
  expect(getCalendarSyncStatus().lastSyncError).toContain("failed")
  expect((await db.execute("SELECT title FROM tasks")).rows).toEqual([expect.objectContaining({ title: "saved" })])
  expect(JSON.stringify(result)).not.toContain(origin)
  expect(JSON.stringify(getCalendarSyncStatus())).not.toContain(origin)
  dav.failures.clear()
  dav.events.bad = ["repaired"]
  const repaired = await retry()
  expect(repaired.status).toBe(200)
  expect(await repaired.json()).toMatchObject({ ok: true, created: 1, updated: 1, total: 2 })
  expect(getCalendarSyncStatus().lastSyncError).toBeNull()
  expect(dav.reports).toBeGreaterThanOrEqual(6)
})

test("real SQLite import rejection keeps committed counts and clears error only after repaired retry", async ({ environment: { db, dav } }) => {
  await ready()
  await db.execute(`CREATE TRIGGER block_caldav BEFORE INSERT ON calendar_confirmations WHEN NEW.provider_event_id = 'blocked'
    BEGIN SELECT RAISE(ABORT, 'fixture sensitive database detail'); END`)
  dav.events.good = ["saved", "blocked"]
  const response = await retry()
  expect(response.status).toBe(502)
  const result = await response.json()
  expect(result).toMatchObject({ ok: false, partial: true, created: 1, updated: 0, total: 2 })
  expect(JSON.stringify(result)).not.toContain("fixture sensitive")
  expect(getCalendarSyncStatus().lastSyncError).toContain("failed")
  expect((await db.execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count).toBe(1)
  await db.execute("DROP TRIGGER block_caldav")
  const repaired = await retry()
  expect(repaired.status).toBe(200)
  expect(await repaired.json()).toMatchObject({ ok: true, created: 1, updated: 1, total: 2 })
  expect((await db.execute("SELECT COUNT(*) AS count FROM tasks")).rows[0]?.count).toBe(2)
  expect(getCalendarSyncStatus().lastSyncError).toBeNull()
})

test("five failed per-calendar fetch attempts pause background requests; manual retry recovers after server repair", async ({ environment: { dav } }) => {
  dav.failures.add("good")
  dav.failures.add("bad")
  startCalDAVSync(origin, 40)
  await expect.poll(() => dav.propfinds).toBe(5)
  await new Promise(resolve => setTimeout(resolve, 180))
  expect(dav.propfinds).toBe(5)
  expect(dav.reports).toBe(10)
  expect(getCalendarSyncStatus().lastSyncError).toContain("failed")
  dav.failures.clear()
  dav.events.good = ["recovered"]
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(dav.propfinds).toBe(5)
  const response = await retry()
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ ok: true, created: 1, total: 1 })
  expect(getCalendarSyncStatus().lastSyncError).toBeNull()
})

test("unconfigured, missing credentials and empty discovery are distinct from successful empty imports", async ({ environment: { db, dav } }) => {
  expect(await syncCalDAVEvents()).toMatchObject({ skipped: "CalDAV sync is not configured" })
  await ready()
  dav.propfindStatus = 503
  expect(await syncCalDAVEvents()).toMatchObject({ failed: "CalDAV sync failed; check credentials, server access and database health" })
  dav.propfindStatus = 207
  dav.calendars = []
  expect(await syncCalDAVEvents()).toMatchObject({ failed: "No CalDAV calendars found on server" })
  expect(getCalendarSyncStatus().lastSyncError).toContain("No CalDAV calendars")
  await db.execute("DELETE FROM settings WHERE key = 'caldav_password_enc'")
  expect(await syncCalDAVEvents()).toMatchObject({ failed: "CalDAV credentials not configured" })
  expect(getCalendarSyncStatus().lastSyncError).toBe("CalDAV credentials not configured")
})
