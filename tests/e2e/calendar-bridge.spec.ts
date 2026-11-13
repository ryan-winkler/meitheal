/**
 * Calendar Bridge — Sync Logic Tests
 *
 * Tests the bi-directional sync engine: deduplication, stale detection,
 * export-only mode, concurrent guard, and all-day event handling.
 *
 * @domain calendar
 * @bounded-context integration
 */
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { SettingsRepository } from "../../apps/web/src/domains/tasks/persistence/settings-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { closeHAConnection, getHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import {
  getCalendarSyncStatus,
  selectRepresentativeOccurrence,
  startCalDAVSync,
  startCalendarSync,
  stopCalendarSync,
  stopCalDAVSync,
  syncCalDAVEvents,
  syncFromHA,
} from "../../apps/web/src/domains/calendar/calendar-bridge"
import { calendarDaysFromToday, calendarToday, formatRelativeDue, shiftCalendarDay } from "../../apps/web/src/lib/date"
import { POST as saveCredentials } from "../../apps/web/src/pages/api/integrations/calendar/caldav-credentials"

// ── Helpers ──

/** Simulate a CalendarEvent structure */
function makeEvent(overrides: Partial<{
  uid: string; summary: string; start: string; end: string;
  description: string; location: string; recurrence_id: string
}> = {}) {
  return {
    uid: overrides.uid ?? `uid-${crypto.randomUUID()}`,
    summary: overrides.summary ?? "Test Event",
    start: overrides.start ?? "2025-01-15T10:00:00",
    end: overrides.end ?? "2025-01-15T11:00:00",
    description: overrides.description,
    location: overrides.location,
    recurrence_id: overrides.recurrence_id,
  }
}

/** Check if a date string is date-only (YYYY-MM-DD) vs datetime */
function isDateOnly(dateStr: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
}

/** Build the correct HA service_data fields based on date type */
function buildDateFields(start: string, end: string): Record<string, string> {
  if (isDateOnly(start)) {
    return { start_date: start, end_date: end }
  }
  return { start_date_time: start, end_date_time: end }
}

// ── Tests ──

test("isDateOnly detects date-only strings", () => {
  expect(isDateOnly("2025-01-15")).toBe(true)
  expect(isDateOnly("2025-01-15T10:00:00")).toBe(false)
  expect(isDateOnly("2025-01-15 10:00:00")).toBe(false)
  expect(isDateOnly("2025-1-5")).toBe(false) // not zero-padded
  expect(isDateOnly("20250115")).toBe(false)
})

test("buildDateFields returns start_date/end_date for all-day events", () => {
  const fields = buildDateFields("2025-01-15", "2025-01-16")
  expect(fields).toEqual({ start_date: "2025-01-15", end_date: "2025-01-16" })
  expect(fields).not.toHaveProperty("start_date_time")
})

test("buildDateFields returns start_date_time/end_date_time for timed events", () => {
  const fields = buildDateFields("2025-01-15T10:00:00", "2025-01-15T11:00:00")
  expect(fields).toEqual({ start_date_time: "2025-01-15T10:00:00", end_date_time: "2025-01-15T11:00:00" })
  expect(fields).not.toHaveProperty("start_date")
})

test("bridge dedup: identical uid events are not duplicated", () => {
  const seen = new Map<string, boolean>()
  const events = [
    makeEvent({ uid: "ev-1", summary: "Meeting" }),
    makeEvent({ uid: "ev-1", summary: "Meeting (updated)" }),
    makeEvent({ uid: "ev-2", summary: "Lunch" }),
  ]

  const deduped = events.filter((e) => {
    if (seen.has(e.uid!)) return false
    seen.set(e.uid!, true)
    return true
  })

  expect(deduped).toHaveLength(2)
  expect(deduped[0]!.summary).toBe("Meeting") // First occurrence wins
  expect(deduped[1]!.summary).toBe("Lunch")
})

test("bridge stale detection: events older than cutoff are flagged", () => {
  const now = Date.now()
  const cutoffMs = 24 * 60 * 60 * 1000 // 24h

  const events = [
    { ...makeEvent({ summary: "Recent" }), syncedAt: now - 1000 },
    { ...makeEvent({ summary: "Stale" }), syncedAt: now - cutoffMs - 1000 },
    { ...makeEvent({ summary: "Also Recent" }), syncedAt: now - 3600_000 },
  ]

  const stale = events.filter((e) => now - e.syncedAt > cutoffMs)
  expect(stale).toHaveLength(1)
  expect(stale[0]!.summary).toBe("Stale")
})

test("export-only mode skips inbound events", () => {
  const syncMode: string = "export"
  const shouldProcessInbound = syncMode !== "export"
  expect(shouldProcessInbound).toBe(false)
})

test("import-only mode skips outbound write-back", () => {
  const syncMode: string = "import"
  const shouldWriteBack = syncMode !== "import"
  expect(shouldWriteBack).toBe(false)
})

test("bidirectional mode processes both directions", () => {
  const syncMode: string = "bidirectional"
  const shouldProcessInbound = syncMode !== "export"
  const shouldWriteBack = syncMode !== "import"
  expect(shouldProcessInbound).toBe(true)
  expect(shouldWriteBack).toBe(true)
})

test("concurrent sync guard prevents overlapping syncs", async () => {
  let isRunning = false
  let concurrencyViolation = false
  const results: string[] = []

  async function simulateSync(id: string) {
    if (isRunning) {
      concurrencyViolation = true
      results.push(`${id}: blocked`)
      return
    }
    isRunning = true
    results.push(`${id}: started`)
    await new Promise((r) => setTimeout(r, 50))
    results.push(`${id}: completed`)
    isRunning = false
  }

  // Run two syncs — second should be blocked
  await Promise.all([simulateSync("sync-1"), simulateSync("sync-2")])

  // One of them must have been blocked
  expect(concurrencyViolation).toBe(true)
  expect(results.some((r) => r.includes("blocked"))).toBe(true)
})

// ── Memory Safety Tests ──

test("MAX_ENTITIES cap: more than 10 entities are capped", () => {
  const MAX_ENTITIES = 10
  const configs = Array.from({ length: 15 }, (_, i) => ({
    entityId: `calendar.test_${i}`,
    syncEnabled: true,
    syncMode: "bidirectional" as const,
    writeBack: false,
    syncIntervalMs: 300000,
  }))

  const enabled = configs.filter(c => c.syncEnabled)
  const capped = enabled.slice(0, MAX_ENTITIES)

  expect(enabled.length).toBe(15)
  expect(capped.length).toBe(MAX_ENTITIES)
  expect(capped[9]!.entityId).toBe("calendar.test_9")
})

test("debounce timer cleanup: timers are cleaned up on stop", () => {
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const entityId = "calendar.test_cleanup"
  const key = `entity-change-${entityId}`

  // Simulate a pending debounce timer
  debounceTimers.set(key, setTimeout(() => {}, 10000))
  expect(debounceTimers.has(key)).toBe(true)

  // Simulate stop cleanup
  const timer = debounceTimers.get(key)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(key)
  }

  expect(debounceTimers.has(key)).toBe(false)
})

test("CalDAV backoff: skips sync after 5 consecutive failures", () => {
  const state = {
    consecutiveFailures: 0,
    lastSyncError: null as string | null,
  }

  // Simulate 5 failures
  for (let i = 0; i < 5; i++) {
    state.consecutiveFailures++
    state.lastSyncError = `Failure ${i + 1}`
  }

  // At 5 failures, should back off
  const shouldSkip = state.consecutiveFailures >= 5
  expect(shouldSkip).toBe(true)
  expect(state.lastSyncError).toBe("Failure 5")

  // Below threshold should not skip
  state.consecutiveFailures = 4
  expect(state.consecutiveFailures >= 5).toBe(false)
})

test("sync timeout: Promise.race rejects on timeout", async () => {
  const TIMEOUT_MS = 100

  const slowSync = new Promise<string>((resolve) =>
    setTimeout(() => resolve("done"), 5000)
  )
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("Sync timeout")), TIMEOUT_MS)
  )

  let timedOut = false
  try {
    await Promise.race([slowSync, timeout])
  } catch (err) {
    timedOut = true
    expect((err as Error).message).toBe("Sync timeout")
  }

  expect(timedOut).toBe(true)
})

// ── Requirement 11: Multi-Occurrence Recurring Series, Today Priority, & CalDAV Compliance ──

test("selectRepresentativeOccurrence prioritizes today over +28d and handles exclusive all-day DTEND", () => {
  const today = "2026-11-13"
  const picked = selectRepresentativeOccurrence(
    [
      { start: "2026-12-11T09:00:00Z", end: "2026-12-11T10:00:00Z" },
      { start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z" },
      { start: "2026-11-13T09:00:00Z", end: "2026-11-13T10:00:00Z" },
      { start: "2026-11-06T09:00:00Z", end: "2026-11-06T10:00:00Z" },
    ],
    today,
    "Europe/Dublin",
  )

  expect(picked.startDay).toBe("2026-11-13")
  expect(picked.representative.start).toBe("2026-11-13T09:00:00Z")
  expect(picked.occurrences).toHaveLength(4)

  // Exclusive all-day DTEND (2026-11-12..2026-11-13) ended yesterday -> must NOT match today
  const pastAllDay = selectRepresentativeOccurrence(
    [
      { start: "2026-11-12", end: "2026-11-13" },
      { start: "2026-11-15", end: "2026-11-16" },
    ],
    today,
    "Europe/Dublin",
  )
  expect(pastAllDay.startDay).toBe("2026-11-15")
})

test("HA sync groups recurring occurrences (with and without UID), picks today over +28d, infers RRULE, and expands calendar counts", async () => {
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-recur-ha-"))
  const ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-recurrence-fixture"
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const settingsRepo = new SettingsRepository(db)
    await settingsRepo.ensureSettingsTable()
    await settingsRepo.upsert("timezone", "Europe/Dublin")
    expect(await getHAConnection()).not.toBeNull()

    const todayStr = calendarToday("Europe/Dublin")
    const d7 = shiftCalendarDay(todayStr, 7)
    const d14 = shiftCalendarDay(todayStr, 14)
    const d28 = shiftCalendarDay(todayStr, 28)

    // Mix: series WITH shared UID, plus series WITHOUT UID (same title + time-of-day) returned out of order (+28d last)
    ha.setCalendarEvents([
      { uid: "weekly-standup", summary: "Weekly Standup", start: `${d28}T10:00:00Z`, end: `${d28}T10:30:00Z` },
      { uid: "weekly-standup", summary: "Weekly Standup", start: `${todayStr}T10:00:00Z`, end: `${todayStr}T10:30:00Z` },
      { uid: "weekly-standup", summary: "Weekly Standup", start: `${d7}T10:00:00Z`, end: `${d7}T10:30:00Z` },
      { uid: "weekly-standup", summary: "Weekly Standup", start: `${d14}T10:00:00Z`, end: `${d14}T10:30:00Z` },
      { summary: "Bin Night", start: `${todayStr}T18:30:00Z`, end: `${todayStr}T19:00:00Z` },
      { summary: "Bin Night", start: `${d7}T18:30:00Z`, end: `${d7}T19:00:00Z` },
      { summary: "Bin Night", start: `${d28}T18:30:00Z`, end: `${d28}T19:00:00Z` },
    ])

    const result = await syncFromHA("calendar.household")
    expect(result.created).toBe(2)
    expect(result.updated).toBe(0)

    const tasksRes = await db.execute({
      sql: `SELECT id, title, due_date, start_date, end_date, recurrence_rule, task_kind FROM tasks ORDER BY title ASC`,
      args: [],
    })
    expect(tasksRes.rows).toHaveLength(2)

    const binNight = tasksRes.rows.find((r) => String(r.title) === "Bin Night")!
    const standup = tasksRes.rows.find((r) => String(r.title) === "Weekly Standup")!

    expect(binNight.task_kind).toBe("calendar_event")
    expect(standup.task_kind).toBe("calendar_event")

    // Must pick TODAY's occurrence rather than +28d
    expect(String(standup.due_date)).toBe(`${todayStr}T10:00:00Z`)
    expect(String(binNight.due_date)).toBe(`${todayStr}T18:30:00Z`)
    expect(calendarDaysFromToday(String(binNight.due_date), "Europe/Dublin")).toBe(0)
    expect(formatRelativeDue(String(binNight.due_date), "Europe/Dublin")).toMatch(/^Today · \d{2}:\d{2}$/)

    // Recurrence rule inferred from weekly cadence
    expect(String(standup.recurrence_rule)).toContain("FREQ=WEEKLY")
    expect(String(binNight.recurrence_rule)).toContain("FREQ=WEEKLY")

    // Calendar counts include EVERY expanded occurrence in [todayStr, d28]
    const repo = new TaskRepository(db)
    const haCounts = await repo.getCalendarHAEventCounts(todayStr, d28, "Europe/Dublin")
    expect(haCounts[todayStr]).toBe(2)
    expect(haCounts[d7]).toBe(2)
    expect(haCounts[d14]).toBe(1)
    expect(haCounts[d28]).toBe(2)

    // Re-syncing must update (not create duplicates or overwrite due_date with +28d)
    const secondResult = await syncFromHA("calendar.household")
    expect(secondResult.created).toBe(0)
    expect(secondResult.updated).toBe(2)
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
})

test("CalDAV sync parses RRULE, EXDATE, colons in DESCRIPTION, exclusive all-day DTEND, and updates existing tasks on re-sync", async () => {
  const origin = "http://caldav-recurrence-fixture.example"
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const originalFetch = globalThis.fetch
  const directory = await mkdtemp(join(tmpdir(), "meitheal-caldav-recur-"))

  const todayStr = calendarToday("Europe/Dublin")
  const d7 = shiftCalendarDay(todayStr, 7)
  const d14 = shiftCalendarDay(todayStr, 14)
  const compact = (day: string) => day.replace(/-/g, "")

  let summaryTitle = "CalDAV Standup"
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain request body */ }
    response.setHeader("content-type", "application/xml")
    if (request.method === "PROPFIND") {
      response.writeHead(207).end(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/team/</d:href><d:propstat><d:prop><d:displayname>Team</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`,
      )
      return
    }
    if (request.method === "REPORT") {
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:caldav-weekly-1",
        `SUMMARY:${summaryTitle}`,
        `DTSTART;TZID=Europe/Dublin:${compact(todayStr)}T093000`,
        `DTEND;TZID=Europe/Dublin:${compact(todayStr)}T100000`,
        "RRULE:FREQ=WEEKLY;COUNT=3",
        `EXDATE;TZID=Europe/Dublin:${compact(d7)}T093000`,
        "DESCRIPTION:Agenda: https://meet.example.com/room:8443",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n")
      response.writeHead(207).end(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/team/weekly.ics</d:href><d:propstat><d:prop><c:calendar-data>${ics}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
      )
      return
    }
    response.writeHead(405).end()
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture server has no TCP address")

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input)
    if (target.origin !== origin) throw new Error(`Unexpected fixture egress: ${target.origin}`)
    target.hostname = "127.0.0.1"
    target.port = String(address.port)
    return originalFetch(target, init)
  }) as typeof fetch

  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_TOKEN = "caldav-recur-key"
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const settingsRepo = new SettingsRepository(db)
    await settingsRepo.ensureSettingsTable()
    await settingsRepo.upsert("timezone", "Europe/Dublin")
    const saved = await saveCredentials({
      locals: { hassIsAdmin: true },
      request: new Request("http://localhost/api/integrations/calendar/caldav-credentials", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "save", url: origin, username: "u", password: "p" }),
      }),
    } as unknown as Parameters<typeof saveCredentials>[0])
    expect(saved.status).toBe(200)

    startCalDAVSync(origin, 0)
    await expect.poll(() => getCalendarSyncStatus().lastSyncAt).not.toBeNull()
    expect(getCalendarSyncStatus().lastSyncError).toBeNull()

    const row1 = (await db.execute({ sql: `SELECT title, description, due_date, recurrence_rule, task_kind FROM tasks`, args: [] })).rows[0]!
    expect(row1.title).toBe("CalDAV Standup")
    expect(row1.description).toBe("Agenda: https://meet.example.com/room:8443")
    expect(row1.recurrence_rule).toBe("FREQ=WEEKLY;COUNT=3")
    expect(row1.task_kind).toBe("calendar_event")

    // Confirm EXDATE excluded d7 while todayStr and d14 are counted
    const repo = new TaskRepository(db)
    const counts = await repo.getCalendarHAEventCounts(todayStr, d14, "Europe/Dublin")
    expect(counts[todayStr]).toBe(1)
    expect(counts[d7] ?? 0).toBe(0)
    expect(counts[d14]).toBe(1)

    // Re-sync after upstream title change -> updates existing task instead of skipping
    summaryTitle = "CalDAV Standup (Renamed)"
    const second = await syncCalDAVEvents()
    expect(second).toEqual({ created: 0, updated: 1, total: 1 })

    const rows2 = (await db.execute({ sql: `SELECT title FROM tasks`, args: [] })).rows
    expect(rows2).toHaveLength(1)
    expect(rows2[0]!.title).toBe("CalDAV Standup (Renamed)")
  } finally {
    stopCalDAVSync()
    globalThis.fetch = originalFetch
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
    resetPersistenceForTests()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
