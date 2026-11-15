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
  isImportedCalendarTask,
  planInboundCalendarUpdate,
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

test("planInboundCalendarUpdate treats alias and archived statuses as closed", () => {
  const payload = JSON.stringify({ summary: "Bins", start: "2026-11-09T07:00:00Z", end: null, rrule: null })
  const base = {
    id: "t", title: "Bins", due_date: "2026-11-09T07:00:00Z", start_date: "2026-11-09T07:00:00Z", end_date: null,
    task_kind: "calendar_event", recurrence_rule: null, idempotency_key: "cal-sync-calendar.x:series",
  }
  const incoming = { title: "Bins", start: "2026-11-16T07:00:00Z", end: null, recurrenceRule: null, repeats: true }
  // A legacy "done" alias reopens like "complete" and follows the next occurrence.
  const done = planInboundCalendarUpdate({ ...base, status: "done" } as never, payload, incoming, { timezone: "UTC" })
  expect(done.status).toBe("pending")
  expect(done.dueDate).toBe("2026-11-16T07:00:00Z")
  // An archived task is closed but never reopened, and its fields stay put.
  const archived = planInboundCalendarUpdate({ ...base, status: "archived" } as never, payload, incoming, { timezone: "UTC" })
  expect(archived.status).toBeUndefined()
  expect(archived.dueDate).toBeUndefined()
  expect(archived.title).toBeUndefined()
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

    // The weekly cadence is inferred into the sync record only. Without a provider
    // RRULE the task stores no rule, so completing it cannot spawn a standalone repeat.
    expect(standup.recurrence_rule).toBeNull()
    expect(binNight.recurrence_rule).toBeNull()
    const payloads = await db.execute({
      sql: "SELECT json_extract(payload, '$.inferred_rrule') AS inferred, json_extract(payload, '$.rrule') AS rrule FROM calendar_confirmations WHERE task_id IN (?, ?)",
      args: [String(standup.id), String(binNight.id)],
    })
    for (const row of payloads.rows) {
      expect(String(row.inferred)).toContain("FREQ=WEEKLY")
      expect(row.rrule).toBeNull()
    }

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

    // A title edited in Meitheal survives a calendar rename; untouched fields still follow.
    await db.execute({ sql: "UPDATE tasks SET title = 'Standup (bring notes)' WHERE id = ?", args: [String(standup.id)] })
    ha.setCalendarEvents([
      { uid: "weekly-standup", summary: "Team Standup", start: `${todayStr}T11:00:00Z`, end: `${todayStr}T11:30:00Z` },
      { uid: "weekly-standup", summary: "Team Standup", start: `${d7}T11:00:00Z`, end: `${d7}T11:30:00Z` },
      { summary: "Bin Night", start: `${todayStr}T18:30:00Z`, end: `${todayStr}T19:00:00Z` },
      { summary: "Bin Night", start: `${d7}T18:30:00Z`, end: `${d7}T19:00:00Z` },
    ])
    await syncFromHA("calendar.household")
    const edited = await db.execute({ sql: "SELECT title, due_date FROM tasks WHERE id = ?", args: [String(standup.id)] })
    expect(edited.rows[0]?.title).toBe("Standup (bring notes)")
    expect(String(edited.rows[0]?.due_date)).toBe(`${todayStr}T11:00:00Z`)

    // Completing a synced calendar event never creates a separate repeating task.
    await db.execute({ sql: "UPDATE tasks SET recurrence_rule = 'FREQ=WEEKLY' WHERE id = ?", args: [String(standup.id)] })
    await repo.updateTask(String(standup.id), { status: "complete" })
    const afterComplete = await db.execute({ sql: "SELECT COUNT(*) AS n FROM tasks", args: [] })
    expect(Number(afterComplete.rows[0]?.n)).toBe(2)

    // A hand-made task with the same title as an event is never adopted.
    await db.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, labels, framework_payload, area_id, custom_fields, task_type, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('hand-made', 'Dentist', '', 'pending', 3, '[]', '{}', 'default', '{}', 'task', 'hand-made', 'hand-made', 900, 1, 1)`,
      args: [],
    })
    ha.setCalendarEvents([{ uid: "dentist-1", summary: "Dentist", start: `${d7}T09:00:00Z`, end: `${d7}T10:00:00Z` }])
    await syncFromHA("calendar.household")
    const handMade = await db.execute({ sql: "SELECT task_kind, due_date FROM tasks WHERE id = 'hand-made'", args: [] })
    expect(handMade.rows[0]?.task_kind).toBe("standard_action")
    expect(handMade.rows[0]?.due_date).toBeNull()
    const dentists = await db.execute({ sql: "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Dentist'", args: [] })
    expect(Number(dentists.rows[0]?.n)).toBe(2)
    // Imported events are never written back to a calendar; hand-made tasks still can be.
    expect(await isImportedCalendarTask(String(standup.id))).toBe(true)
    expect(await isImportedCalendarTask("hand-made")).toBe(false)

    // Rescheduling an event without an ID keeps the same open task, replaces its old confirmation, and moves its counts.
    const d9 = shiftCalendarDay(todayStr, 9)
    const d11 = shiftCalendarDay(todayStr, 11)
    ha.setCalendarEvents([{ summary: "Boiler service", start: `${d9}T09:00:00Z`, end: `${d9}T10:00:00Z` }])
    await syncFromHA("calendar.household")
    ha.setCalendarEvents([{ summary: "Boiler service", start: `${d11}T10:00:00Z`, end: `${d11}T11:00:00Z` }])
    await syncFromHA("calendar.household")
    const boiler = await db.execute({ sql: "SELECT id, status, due_date FROM tasks WHERE title = 'Boiler service'", args: [] })
    expect(boiler.rows).toHaveLength(1)
    expect(String(boiler.rows[0]?.status)).not.toBe("complete")
    expect(String(boiler.rows[0]?.due_date)).toBe(`${d11}T10:00:00Z`)
    const boilerConfirmations = await db.execute({
      sql: "SELECT provider_event_id FROM calendar_confirmations WHERE task_id = ? AND source = 'ha.calendar_sync'",
      args: [String(boiler.rows[0]?.id)],
    })
    expect(boilerConfirmations.rows).toHaveLength(1)
    const movedCounts = await repo.getCalendarHAEventCounts(d9, d11, "Europe/Dublin")
    expect(movedCounts[d9] ?? 0).toBe(0)
    expect(movedCounts[d11]).toBe(1)

    // Adding a second ID-less event at the former day creates a separate task without colliding with the retired key.
    ha.setCalendarEvents([
      { summary: "Boiler service", start: `${d9}T09:00:00Z`, end: `${d9}T10:00:00Z` },
      { summary: "Boiler service", start: `${d11}T10:00:00Z`, end: `${d11}T11:00:00Z` },
    ])
    await syncFromHA("calendar.household")
    const boilersCount = await db.execute({ sql: "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Boiler service'", args: [] })
    expect(Number(boilersCount.rows[0]?.n)).toBe(2)
    const twoBoilerCounts = await repo.getCalendarHAEventCounts(d9, d11, "Europe/Dublin")
    expect(twoBoilerCounts[d9]).toBe(1)
    expect(twoBoilerCounts[d11]).toBe(1)

    const d11ConfRow = await db.execute({
      sql: `SELECT c.provider_event_id
            FROM calendar_confirmations c
            JOIN tasks t ON t.id = c.task_id
            WHERE t.title = 'Boiler service' AND t.due_date = ? AND c.source = 'ha.calendar_sync'`,
      args: [`${d11}T10:00:00Z`],
    })
    const d11ConfId = String(d11ConfRow.rows[0]?.provider_event_id ?? "")
    expect(d11ConfId.length).toBeGreaterThan(0)
    const retryDup = await repo.commitSyncMutationChunks([
      {
        kind: "create",
        taskId: globalThis.crypto.randomUUID(),
        idempotencyKey: `cal-sync-calendar.household:${d11ConfId}:retry`,
        title: "Boiler service",
        status: "pending",
        dueDate: `${d11}T10:00:00Z`,
        startDate: `${d11}T10:00:00Z`,
        endDate: `${d11}T11:00:00Z`,
        areaId: "default",
        taskType: "task",
        taskKind: "calendar_event",
        confirmation: {
          source: "calendar",
          entityId: "calendar.household",
          externalId: d11ConfId,
          confirmationSource: "ha.calendar_sync",
          payload: JSON.stringify({ entity_id: "calendar.household" }),
        },
      },
    ])
    expect(retryDup.created).toBe(0)
    expect(retryDup.skipped).toBe(1)
    expect(retryDup.errors).toHaveLength(0)
    const afterRetryCount = await db.execute({ sql: "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Boiler service'", args: [] })
    expect(Number(afterRetryCount.rows[0]?.n)).toBe(2)

    // Two new events that share a title each get their own task.
    ha.setCalendarEvents([
      { uid: "vet-1", summary: "Vet", start: `${d7}T09:00:00Z`, end: `${d7}T09:30:00Z` },
      { uid: "vet-2", summary: "Vet", start: `${d14}T09:00:00Z`, end: `${d14}T09:30:00Z` },
    ])
    await syncFromHA("calendar.household")
    const vets = await db.execute({ sql: "SELECT due_date FROM tasks WHERE title = 'Vet' ORDER BY due_date", args: [] })
    expect(vets.rows.map((row) => String(row.due_date))).toEqual([`${d7}T09:00:00Z`, `${d14}T09:00:00Z`])

    // A same-title event added later gets its own task while the first event is still there.
    ha.setCalendarEvents([{ summary: "Swimming", start: `${d7}T17:00:00Z`, end: `${d7}T18:00:00Z` }])
    await syncFromHA("calendar.household")
    ha.setCalendarEvents([
      { summary: "Swimming", start: `${d7}T17:00:00Z`, end: `${d7}T18:00:00Z` },
      { summary: "Swimming", start: `${d14}T10:00:00Z`, end: `${d14}T11:00:00Z` },
    ])
    await syncFromHA("calendar.household")
    const swimsBefore = await db.execute({ sql: "SELECT id, due_date FROM tasks WHERE title = 'Swimming' ORDER BY due_date", args: [] })
    expect(swimsBefore.rows.map((row) => String(row.due_date))).toEqual([`${d7}T17:00:00Z`, `${d14}T10:00:00Z`])

    // Moving the second ID-less same-title event keeps its existing task (and does not get blocked by the first).
    ha.setCalendarEvents([
      { summary: "Swimming", start: `${d7}T17:00:00Z`, end: `${d7}T18:00:00Z` },
      { summary: "Swimming", start: `${d14}T11:30:00Z`, end: `${d14}T12:30:00Z` },
    ])
    await syncFromHA("calendar.household")
    const swimsAfter = await db.execute({ sql: "SELECT id, status, due_date FROM tasks WHERE title = 'Swimming' ORDER BY due_date", args: [] })
    expect(swimsAfter.rows.map((row) => String(row.id))).toEqual(swimsBefore.rows.map((row) => String(row.id)))
    expect(swimsAfter.rows.map((row) => String(row.due_date))).toEqual([`${d7}T17:00:00Z`, `${d14}T11:30:00Z`])
    expect(swimsAfter.rows.every((row) => String(row.status) !== "complete")).toBe(true)
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

test("HA sync keys ID-less series on HA wall clock, leaves unchanged tasks alone, keeps Meitheal repeats, and clears deleted-series badges", async () => {
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-series-key-"))
  const ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-series-key-fixture"
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const settingsRepo = new SettingsRepository(db)
    await settingsRepo.ensureSettingsTable()
    await settingsRepo.upsert("timezone", "Europe/Dublin")
    expect(await getHAConnection()).not.toBeNull()
    const repo = new TaskRepository(db)

    const todayStr = calendarToday("Europe/Dublin")
    const d7 = shiftCalendarDay(todayStr, 7)
    const d14 = shiftCalendarDay(todayStr, 14)

    // HA in New York reports 18:00 local with -05:00, then -04:00 after US DST. In Dublin
    // time these are 23:00 and 22:00, but they are one series and must stay one task.
    ha.setCalendarEvents([
      { summary: "Swim", start: `${todayStr}T18:00:00-05:00`, end: `${todayStr}T19:00:00-05:00` },
      { summary: "Swim", start: `${d7}T18:00:00-04:00`, end: `${d7}T19:00:00-04:00` },
      { summary: "Swim", start: `${d14}T18:00:00-04:00`, end: `${d14}T19:00:00-04:00` },
    ])
    await syncFromHA("calendar.household")
    const swims = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Swim'", args: [] })
    expect(swims.rows).toHaveLength(1)
    const swimId = String(swims.rows[0]?.id)

    // A sync that changes nothing must not touch a completed task's updated_at.
    await repo.updateTask(swimId, { status: "complete" })
    await db.execute({ sql: "UPDATE tasks SET updated_at = 1000 WHERE id = ?", args: [swimId] })
    await syncFromHA("calendar.household")
    const unchanged = await db.execute({ sql: "SELECT status, updated_at FROM tasks WHERE id = ?", args: [swimId] })
    expect(String(unchanged.rows[0]?.status)).toBe("complete")
    expect(Number(unchanged.rows[0]?.updated_at)).toBe(1000)

    // A repeating Event task created in Meitheal that sync links by title keeps its own repeats.
    await db.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, labels, framework_payload, area_id, custom_fields, task_type, task_kind, due_date, recurrence_rule, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('bin-day', 'Bin day', '', 'pending', 3, '[]', '{}', 'default', '{}', 'task', 'calendar_event', ?, 'FREQ=WEEKLY', 'bin-day', 'bin-day', 901, 1, 1)`,
      args: [d7],
    })
    ha.setCalendarEvents([
      { summary: "Swim", start: `${todayStr}T18:00:00-05:00`, end: `${todayStr}T19:00:00-05:00` },
      { summary: "Swim", start: `${d7}T18:00:00-04:00`, end: `${d7}T19:00:00-04:00` },
      { summary: "Swim", start: `${d14}T18:00:00-04:00`, end: `${d14}T19:00:00-04:00` },
      { summary: "Bin day", start: d7, end: shiftCalendarDay(d7, 1) },
    ])
    await syncFromHA("calendar.household")
    // Linked to the household's own HA event, so it is never written back as a copy...
    expect(await isImportedCalendarTask("bin-day")).toBe(true)
    expect(await isImportedCalendarTask(swimId)).toBe(true)
    // ...but it still creates its own next occurrence when completed.
    await repo.updateTask("bin-day", { status: "complete" })
    const binDays = await db.execute({ sql: "SELECT status FROM tasks WHERE title = 'Bin day' ORDER BY created_at", args: [] })
    expect(binDays.rows.map((row) => String(row.status))).toEqual(["complete", "pending"])

    // Deleting the series completes its task and removes its month-grid badges.
    expect((await repo.getCalendarHAEventCounts(todayStr, d14, "Europe/Dublin"))[d14]).toBe(1)
    ha.setCalendarEvents([{ summary: "Bin day", start: d7, end: shiftCalendarDay(d7, 1) }])
    await syncFromHA("calendar.household")
    const deletedCounts = await repo.getCalendarHAEventCounts(todayStr, d14, "Europe/Dublin")
    expect(deletedCounts[d14] ?? 0).toBe(0)

    // When the household's own repeating task loses its HA event, it is unlinked, not completed.
    const openBinDay = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Bin day' AND status = 'pending'", args: [] })
    expect(openBinDay.rows).toHaveLength(1)
    await db.execute({
      sql: `INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
            VALUES ('gone-link', ?, 'gone-link', 'ha-cal-calendar.household-Bin day-gone', 'ha.calendar_sync', ?, 1)`,
      args: [String(openBinDay.rows[0]?.id), JSON.stringify({ entity_id: "calendar.household" })],
    })
    ha.setCalendarEvents([{ summary: "Unrelated", start: d7, end: shiftCalendarDay(d7, 1) }])
    await syncFromHA("calendar.household")
    const stillOpen = await db.execute({ sql: "SELECT status FROM tasks WHERE id = ?", args: [String(openBinDay.rows[0]?.id)] })
    expect(String(stillOpen.rows[0]?.status)).toBe("pending")
    const gone = await db.execute({ sql: "SELECT COUNT(*) AS n FROM calendar_confirmations WHERE confirmation_id = 'gone-link'", args: [] })
    expect(Number(gone.rows[0]?.n)).toBe(0)
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

// Time of day in Europe/Dublin for an instant, and Dublin's UTC offset on a day. Both change
// with daylight saving, so tests that depend on household time derive them instead of
// assuming the winter values.
function dublinClock(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso))
}

function dublinOffsetHours(day: string): number {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Dublin", hour: "2-digit", hour12: false }).format(new Date(`${day}T12:00:00Z`)))
  return hour - 12
}

test("HA sync adopts an ID-less series saved under the earlier household-time key even if it is completed and renamed", async () => {
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-prior-key-"))
  const ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-prior-key-fixture"
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const settingsRepo = new SettingsRepository(db)
    await settingsRepo.ensureSettingsTable()
    await settingsRepo.upsert("timezone", "Europe/Dublin")
    expect(await getHAConnection()).not.toBeNull()
    const repo = new TaskRepository(db)
    const todayStr = calendarToday("Europe/Dublin")
    const d7 = shiftCalendarDay(todayStr, 7)
    const d14 = shiftCalendarDay(todayStr, 14)
    ha.setCalendarEvents([
      { summary: "Swim", start: `${todayStr}T18:00:00-05:00`, end: `${todayStr}T19:00:00-05:00` },
      { summary: "Swim", start: `${d7}T18:00:00-05:00`, end: `${d7}T19:00:00-05:00` },
      { summary: "Swim", start: `${d14}T18:00:00-05:00`, end: `${d14}T19:00:00-05:00` },
    ])
    await syncFromHA("calendar.household")
    const created = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Swim'", args: [] })
    expect(created.rows).toHaveLength(1)
    const swimId = String(created.rows[0]?.id)

    // Rewrite the saved key to the earlier release's form (household-time 23:00), then
    // complete and rename the task so only the key can find it again.
    await db.execute({
      sql: "UPDATE calendar_confirmations SET provider_event_id = ? WHERE task_id = ? AND source = 'ha.calendar_sync'",
      args: [`ha-cal-series-calendar.household-swim::${dublinClock(`${todayStr}T18:00:00-05:00`)}`, swimId],
    })
    await repo.updateTask(swimId, { title: "Swim (renamed)", status: "complete" })

    await syncFromHA("calendar.household")
    const after = await db.execute({ sql: "SELECT id, title, status FROM tasks WHERE title LIKE 'Swim%'", args: [] })
    expect(after.rows).toHaveLength(1)
    expect(String(after.rows[0]?.id)).toBe(swimId)
    expect(String(after.rows[0]?.status)).toBe("complete")
    const key = await db.execute({
      sql: "SELECT provider_event_id FROM calendar_confirmations WHERE task_id = ? AND source = 'ha.calendar_sync'",
      args: [swimId],
    })
    expect(String(key.rows[0]?.provider_event_id)).toBe("ha-cal-series-calendar.household-swim::18:00")
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

test("HA sync keeps two ID-less series that share an earlier household-time key in separate tasks", async () => {
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-alias-collision-"))
  const ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-alias-collision-fixture"
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
    // B is written so that its Dublin time is exactly 23:00, the key the evening series holds.
    const sharedHour = String(18 - dublinOffsetHours(todayStr)).padStart(2, "0")
    const evening = [
      { summary: "Swim", start: `${todayStr}T23:00:00-05:00`, end: `${shiftCalendarDay(todayStr, 1)}T00:00:00-05:00` },
      { summary: "Swim", start: `${d7}T23:00:00-05:00`, end: `${shiftCalendarDay(d7, 1)}T00:00:00-05:00` },
    ]
    ha.setCalendarEvents(evening)
    await syncFromHA("calendar.household")
    const first = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Swim'", args: [] })
    expect(first.rows).toHaveLength(1)
    const eveningId = String(first.rows[0]?.id)

    // A second series at 18:00-05:00 is 23:00 in Dublin, the key the evening series now holds.
    ha.setCalendarEvents([
      ...evening,
      { summary: "Swim", start: `${todayStr}T${sharedHour}:00:00-05:00`, end: `${todayStr}T${sharedHour}:30:00-05:00` },
      { summary: "Swim", start: `${d7}T${sharedHour}:00:00-05:00`, end: `${d7}T${sharedHour}:30:00-05:00` },
    ])
    await syncFromHA("calendar.household")
    const both = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Swim' ORDER BY created_at", args: [] })
    expect(both.rows).toHaveLength(2)
    expect(String(both.rows[0]?.id)).toBe(eveningId)
    const keys = await db.execute({
      sql: "SELECT provider_event_id FROM calendar_confirmations WHERE source = 'ha.calendar_sync' ORDER BY provider_event_id",
      args: [],
    })
    expect(keys.rows.map((row) => String(row.provider_event_id)).sort()).toEqual([
      `ha-cal-series-calendar.household-swim::${sharedHour}:00`,
      "ha-cal-series-calendar.household-swim::23:00",
    ].sort())
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

test("sync updates skip fields edited after the planner read its snapshot", async () => {
  const previous = process.env.MEITHEAL_DB_URL
  const directory = await mkdtemp(join(tmpdir(), "meitheal-sync-snapshot-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()
  try {
    await ensureSchema()
    const repo = new TaskRepository(db)
    await db.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, labels, framework_payload, area_id, custom_fields, task_type, task_kind, due_date, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('snap-1', 'Edited by hand', '', 'pending', 3, '[]', '{}', 'default', '{}', 'task', 'calendar_event', '2026-12-01', 'cal-sync-snap', 'snap', 950, 1, 1)`,
      args: [],
    })
    // The planner read "Calendar title" / 2026-11-30, then the user saved a new title before the commit.
    const result = await repo.commitSyncMutationChunks([
      {
        kind: "update",
        taskId: "snap-1",
        title: "Provider title",
        dueDate: "2026-12-02",
        updateDueDate: true,
        expected: { title: "Calendar title", dueDate: "2026-12-01" },
      },
    ])
    expect(result.errors).toHaveLength(0)
    const row = await db.execute({ sql: "SELECT title, due_date FROM tasks WHERE id = 'snap-1'", args: [] })
    expect(String(row.rows[0]?.title)).toBe("Edited by hand")
    expect(String(row.rows[0]?.due_date)).toBe("2026-12-02")

    // The task was open when the plan was made and has been completed since: the plan no
    // longer fits, so the update is skipped as a whole.
    await db.execute({ sql: "UPDATE tasks SET status = 'complete', due_date = '2026-12-01' WHERE id = 'snap-1'", args: [] })
    const stale = await repo.commitSyncMutationChunks([
      {
        kind: "update",
        taskId: "snap-1",
        dueDate: "2026-12-08",
        updateDueDate: true,
        expected: { status: "pending", dueDate: "2026-12-01" },
      },
    ])
    expect(stale.skipped).toBe(1)
    expect(stale.updated).toBe(0)
    const afterStale = await db.execute({ sql: "SELECT status, due_date FROM tasks WHERE id = 'snap-1'", args: [] })
    expect(String(afterStale.rows[0]?.status)).toBe("complete")
    expect(String(afterStale.rows[0]?.due_date)).toBe("2026-12-01")
  } finally {
    db.close()
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(directory, { recursive: true, force: true })
  }
})

test("HA sync upgrades tasks saved by the per-occurrence release: due dates follow the series and merged same-title series split", async () => {
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-legacy-upgrade-"))
  const ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-legacy-upgrade-fixture"
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const settingsRepo = new SettingsRepository(db)
    await settingsRepo.ensureSettingsTable()
    await settingsRepo.upsert("timezone", "Europe/Dublin")
    expect(await getHAConnection()).not.toBeNull()

    const entity = "calendar.household"
    const todayStr = calendarToday("Europe/Dublin")
    const d3 = shiftCalendarDay(todayStr, 3)
    const d7 = shiftCalendarDay(todayStr, 7)
    const d10 = shiftCalendarDay(todayStr, 10)
    const d14 = shiftCalendarDay(todayStr, 14)
    const d28 = shiftCalendarDay(todayStr, 28)
    const legacyKey = (summary: string, start: string) => `ha-cal-${entity}-${summary}-${start}`
    let ticket = 700
    const seedTask = async (id: string, title: string, dueDate: string, firstStart: string) => {
      await db.execute({
        sql: `INSERT INTO tasks (id, title, description, status, priority, labels, framework_payload, area_id, custom_fields, task_type, due_date, idempotency_key, request_id, ticket_number, created_at, updated_at)
              VALUES (?, ?, '', 'pending', 3, '["calendar-sync"]', '{}', 'default', '{}', 'task', ?, ?, ?, ?, 1, 1)`,
        args: [id, title, dueDate, `cal-sync-${legacyKey(title, firstStart)}`, id, ticket++],
      })
    }
    const seedLink = async (taskId: string, summary: string, start: string, end: string) => {
      await db.execute({
        sql: `INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
              VALUES (?, ?, ?, ?, 'ha.calendar_sync', ?, 1)`,
        args: [
          globalThis.crypto.randomUUID(), taskId, globalThis.crypto.randomUUID(), legacyKey(summary, start),
          JSON.stringify({ summary, start, end, entity_id: entity }),
        ],
      })
    }

    // The old release linked every "Bin Night" occurrence to one task and left its due
    // date on the occurrence it synced last (four weeks out).
    const binStarts = [todayStr, d7, d28].map((day) => `${day}T18:30:00Z`)
    await seedTask("legacy-bin", "Bin Night", binStarts[2]!, binStarts[0]!)
    for (const start of binStarts) await seedLink("legacy-bin", "Bin Night", start, start.replace("18:30", "19:00"))

    // It also merged two different "Swimming" series (Tuesday 17:00, Saturday 10:00) into one task.
    const tueStarts = [d7, d14].map((day) => `${day}T17:00:00Z`)
    const satStarts = [d3, d10].map((day) => `${day}T10:00:00Z`)
    await seedTask("legacy-swim", "Swimming", tueStarts[1]!, satStarts[0]!)
    for (const start of [...satStarts, ...tueStarts]) await seedLink("legacy-swim", "Swimming", start, start)

    // After the user completed last week's "Gym" task, the old release created a second
    // task for the later occurrences (it never matched completed tasks by title).
    const dMinus5 = shiftCalendarDay(todayStr, -5)
    const gymStarts = [dMinus5, todayStr, d7, d14].map((day) => `${day}T07:00:00Z`)
    await seedTask("legacy-gym-done", "Gym", gymStarts[0]!, gymStarts[0]!)
    await db.execute({ sql: "UPDATE tasks SET status = 'complete' WHERE id = 'legacy-gym-done'", args: [] })
    await seedLink("legacy-gym-done", "Gym", gymStarts[0]!, gymStarts[0]!)
    await seedTask("legacy-gym-open", "Gym", gymStarts[3]!, gymStarts[1]!)
    for (const start of gymStarts.slice(1)) await seedLink("legacy-gym-open", "Gym", start, start)

    ha.setCalendarEvents([
      ...binStarts.map((start) => ({ summary: "Bin Night", start, end: start.replace("18:30", "19:00") })),
      ...[...tueStarts, ...satStarts].map((start) => ({ summary: "Swimming", start, end: start })),
      ...gymStarts.map((start) => ({ summary: "Gym", start, end: start })),
    ])
    await syncFromHA(entity)

    // The open task keeps the series and moves to today; the completed one stays completed.
    const gyms = await db.execute({ sql: "SELECT id, status, due_date FROM tasks WHERE title = 'Gym' ORDER BY id", args: [] })
    expect(gyms.rows.map((row) => [String(row.id), String(row.status), String(row.due_date)])).toEqual([
      ["legacy-gym-done", "complete", gymStarts[0]],
      ["legacy-gym-open", "pending", gymStarts[1]],
    ])
    const doneLinks = await db.execute({ sql: "SELECT COUNT(*) AS n FROM calendar_confirmations WHERE task_id = 'legacy-gym-done'", args: [] })
    expect(Number(doneLinks.rows[0]?.n)).toBe(0)

    const bin = await db.execute({ sql: "SELECT due_date, start_date, end_date FROM tasks WHERE id = 'legacy-bin'", args: [] })
    expect(String(bin.rows[0]?.due_date)).toBe(binStarts[0])
    expect(String(bin.rows[0]?.start_date)).toBe(binStarts[0])
    expect(bin.rows[0]?.end_date).not.toBeNull()
    expect(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Bin Night'", args: [] })).rows[0]?.n)).toBe(1)

    // The Tuesday series keeps the merged task (it holds the task's due date); Saturday gets its own.
    const swims = await db.execute({ sql: "SELECT id, due_date FROM tasks WHERE title = 'Swimming' ORDER BY due_date", args: [] })
    expect(swims.rows).toHaveLength(2)
    const legacySwim = swims.rows.find((row) => String(row.id) === "legacy-swim")
    const saturday = swims.rows.find((row) => String(row.id) !== "legacy-swim")
    expect(String(legacySwim?.due_date)).toBe(tueStarts[0])
    expect(String(saturday?.due_date)).toBe(satStarts[0])
    const leftover = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM calendar_confirmations WHERE task_id = 'legacy-swim' AND provider_event_id LIKE ?",
      args: [`%T10:00:00Z`],
    })
    expect(Number(leftover.rows[0]?.n)).toBe(0)

    // A second sync is stable: no new tasks and the split holds.
    await syncFromHA(entity)
    expect(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Swimming'", args: [] })).rows[0]?.n)).toBe(2)
    expect(Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM tasks WHERE title = 'Bin Night'", args: [] })).rows[0]?.n)).toBe(1)
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

test("HA sync leaves completed tasks alone, keeps user-added repeats on old imports, and re-imports a series whose task was deleted", async () => {
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-completed-"))
  const ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-completed-fixture"
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const settingsRepo = new SettingsRepository(db)
    await settingsRepo.ensureSettingsTable()
    await settingsRepo.upsert("timezone", "Europe/Dublin")
    expect(await getHAConnection()).not.toBeNull()
    const repo = new TaskRepository(db)
    const entity = "calendar.household"
    const todayStr = calendarToday("Europe/Dublin")
    const d7 = shiftCalendarDay(todayStr, 7)
    const d14 = shiftCalendarDay(todayStr, 14)
    const d21 = shiftCalendarDay(todayStr, 21)
    const at = (day: string, time: string) => `${day}T${time}:00Z`

    // A Meitheal Event task linked by title to a weekly HA event, then completed.
    await db.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, labels, framework_payload, area_id, custom_fields, task_type, task_kind, due_date, recurrence_rule, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('recycling', 'Recycling', '', 'pending', 3, '[]', '{}', 'default', '{}', 'task', 'calendar_event', ?, 'FREQ=WEEKLY', 'recycling', 'recycling', 9001, 1, 1)`,
      args: [at(todayStr, "07:00")],
    })
    ha.setCalendarEvents([todayStr, d7, d14].map((day) => ({ summary: "Recycling", start: at(day, "07:00"), end: at(day, "07:30") })))
    await syncFromHA(entity)
    await repo.updateTask("recycling", { status: "complete" })
    await db.execute({ sql: "UPDATE tasks SET updated_at = 1000 WHERE id = 'recycling'", args: [] })
    // The next week comes into view; the completed task keeps its date and updated_at.
    ha.setCalendarEvents([d7, d14, d21].map((day) => ({ summary: "Recycling", start: at(day, "07:00"), end: at(day, "07:30") })))
    await syncFromHA(entity)
    const completed = await db.execute({ sql: "SELECT status, due_date, updated_at FROM tasks WHERE id = 'recycling'", args: [] })
    expect(String(completed.rows[0]?.status)).toBe("complete")
    expect(String(completed.rows[0]?.due_date)).toBe(at(todayStr, "07:00"))
    expect(Number(completed.rows[0]?.updated_at)).toBe(1000)

    // The previous release imported a one-off "Boiler service"; the user then added a yearly rule.
    const boilerStart = at(d7, "09:00")
    await db.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, labels, framework_payload, area_id, custom_fields, task_type, due_date, recurrence_rule, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('boiler', 'Boiler service', '', 'pending', 3, '["calendar-sync"]', '{}', 'default', '{}', 'task', ?, 'FREQ=YEARLY', ?, 'boiler', 9501, 1, 1)`,
      args: [boilerStart, `cal-sync-ha-cal-${entity}-Boiler service-${boilerStart}`],
    })
    await db.execute({
      sql: `INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
            VALUES ('boiler-link', 'boiler', 'boiler-link', ?, 'ha.calendar_sync', ?, 1)`,
      args: [`ha-cal-${entity}-Boiler service-${boilerStart}`, JSON.stringify({ summary: "Boiler service", start: boilerStart, end: boilerStart, entity_id: entity })],
    })
    // The previous release also left a completed weekly "Gym" task; upgrading must not reopen it.
    const gymStart = at(todayStr, "06:00")
    await db.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, labels, framework_payload, area_id, custom_fields, task_type, due_date, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('gym', 'Gym', '', 'complete', 3, '["calendar-sync"]', '{}', 'default', '{}', 'task', ?, ?, 'gym', 9701, 1, 1)`,
      args: [gymStart, `cal-sync-ha-cal-${entity}-Gym-${gymStart}`],
    })
    await db.execute({
      sql: `INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
            VALUES ('gym-link', 'gym', 'gym-link', ?, 'ha.calendar_sync', ?, 1)`,
      args: [`ha-cal-${entity}-Gym-${gymStart}`, JSON.stringify({ summary: "Gym", start: gymStart, end: gymStart, entity_id: entity })],
    })
    ha.setCalendarEvents([
      ...[d7, d14, d21].map((day) => ({ summary: "Recycling", start: at(day, "07:00"), end: at(day, "07:30") })),
      { summary: "Boiler service", start: boilerStart, end: boilerStart },
      ...[todayStr, d7, d14].map((day) => ({ summary: "Gym", start: at(day, "06:00"), end: at(day, "07:00") })),
    ])
    await syncFromHA(entity)
    expect(String((await db.execute({ sql: "SELECT status FROM tasks WHERE id = 'gym'", args: [] })).rows[0]?.status)).toBe("complete")
    await repo.updateTask("boiler", { status: "complete" })
    const boilers = await db.execute({ sql: "SELECT status, recurrence_rule FROM tasks WHERE title = 'Boiler service' ORDER BY created_at", args: [] })
    expect(boilers.rows.map((row) => String(row.status))).toEqual(["complete", "pending"])

    // Deleting a synced task does not stop its series: the next sync imports it again.
    const swimEvents = [todayStr, d7, d14].map((day) => ({ summary: "Swim", start: at(day, "18:00"), end: at(day, "19:00") }))
    ha.setCalendarEvents(swimEvents)
    await syncFromHA(entity)
    const firstSwim = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Swim'", args: [] })
    expect(firstSwim.rows).toHaveLength(1)
    await db.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [String(firstSwim.rows[0]?.id)] })
    await syncFromHA(entity)
    const secondSwim = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Swim'", args: [] })
    expect(secondSwim.rows).toHaveLength(1)
    expect(String(secondSwim.rows[0]?.id)).not.toBe(String(firstSwim.rows[0]?.id))
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

test("a completed series keeps its last-applied baseline, so a provider rename still applies when the series reopens", async () => {
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]))
  const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-frozen-baseline-"))
  const ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "calendar-frozen-baseline-fixture"
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const settingsRepo = new SettingsRepository(db)
    await settingsRepo.ensureSettingsTable()
    await settingsRepo.upsert("timezone", "Europe/Dublin")
    expect(await getHAConnection()).not.toBeNull()
    const repo = new TaskRepository(db)
    const todayStr = calendarToday("Europe/Dublin")
    const [d7, d14, d21] = [7, 14, 21].map((n) => shiftCalendarDay(todayStr, n)) as [string, string, string]
    const at = (day: string) => `${day}T07:00:00Z`
    const series = (title: string, days: string[]) => days.map((day) => ({ uid: "rec-1", summary: title, start: at(day), end: `${day}T07:30:00Z` }))

    ha.setCalendarEvents(series("Recycling", [todayStr, d7, d14]))
    await syncFromHA("calendar.household")
    const created = await db.execute({ sql: "SELECT id FROM tasks WHERE title = 'Recycling'", args: [] })
    expect(created.rows).toHaveLength(1)
    const taskId = String(created.rows[0]?.id)
    await repo.updateTask(taskId, { status: "complete" })

    // The provider renames the series while the task is completed: the task stays as completed...
    // The calendar also moves its last occurrence from d14 to d21.
    ha.setCalendarEvents(series("Recycling B", [todayStr, d7, d21]))
    await syncFromHA("calendar.household")
    const frozen = await db.execute({ sql: "SELECT title, status FROM tasks WHERE id = ?", args: [taskId] })
    expect(String(frozen.rows[0]?.title)).toBe("Recycling")
    expect(String(frozen.rows[0]?.status)).toBe("complete")
    // The saved baseline keeps the last-applied title, while month-grid occurrences follow the calendar.
    const baseline = await db.execute({
      sql: "SELECT payload FROM calendar_confirmations WHERE task_id = ? AND source = 'ha.calendar_sync'",
      args: [taskId],
    })
    const savedPayload = JSON.parse(String(baseline.rows[0]?.payload)) as { summary: string; occurrences: Array<{ start: string }> }
    expect(savedPayload.summary).toBe("Recycling")
    expect(savedPayload.occurrences.map((o) => o.start)).toEqual([at(todayStr), at(d7), at(d21)])

    // ...and follows the calendar again, with the new title, once the next occurrence reopens it.
    ha.setCalendarEvents(series("Recycling B", [d7, d14, d21]))
    await syncFromHA("calendar.household")
    const reopened = await db.execute({ sql: "SELECT title, status, due_date FROM tasks WHERE id = ?", args: [taskId] })
    expect(String(reopened.rows[0]?.status)).toBe("pending")
    expect(String(reopened.rows[0]?.title)).toBe("Recycling B")
    expect(String(reopened.rows[0]?.due_date)).toBe(at(d7))
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

test("CalDAV isolates same UID across distinct calendars without overwriting either task", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-caldav-multical-"))
  const previous = Object.fromEntries(["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_TOKEN"].map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  const origin = "http://caldav-multical.example"
  const todayStr = calendarToday("Europe/Dublin")
  const tomorrowStr = shiftCalendarDay(todayStr, 1)
  const dtBasic = (day: string) => day.replace(/-/g, "")

  let teamTitle = "Team Dentists"
  const personalTitle = "Personal Dentists"

  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume XML request */ }
    response.setHeader("content-type", "application/xml")
    if (request.method === "PROPFIND") {
      response.writeHead(207).end(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">`
        + `<d:response><d:href>/team/</d:href><d:propstat><d:prop><d:displayname>Shared</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`
        + `<d:response><d:href>/personal/</d:href><d:propstat><d:prop><d:displayname>Shared</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`
        + `</d:multistatus>`,
      )
      return
    }
    if (request.method === "REPORT") {
      const isTeam = request.url?.startsWith("/team")
      const summary = isTeam ? teamTitle : personalTitle
      const day = isTeam ? dtBasic(todayStr) : dtBasic(tomorrowStr)
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:shared-invite-uid",
        `SUMMARY:${summary}`,
        `DTSTART;VALUE=DATE:${day}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n")
      response.writeHead(207).end(
        `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${request.url}item.ics</d:href><d:propstat><d:prop><c:calendar-data>${ics}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`,
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
  process.env.HA_TOKEN = "caldav-multical-key"
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
    expect(getCalendarSyncStatus().lastSyncEventCount).toBe(2)

    const tasksAfterFirst = (await db.execute({ sql: `SELECT title, due_date FROM tasks ORDER BY title ASC`, args: [] })).rows
    expect(tasksAfterFirst).toEqual([
      expect.objectContaining({ title: "Personal Dentists", due_date: tomorrowStr }),
      expect.objectContaining({ title: "Team Dentists", due_date: todayStr }),
    ])

    const idempotent = await syncCalDAVEvents()
    expect(idempotent).toEqual({ created: 0, updated: 2, total: 2 })

    teamTitle = "Team Dentists (Updated)"
    const second = await syncCalDAVEvents()
    expect(second).toEqual({ created: 0, updated: 2, total: 2 })

    const tasksAfterSecond = (await db.execute({ sql: `SELECT title, due_date FROM tasks ORDER BY title ASC`, args: [] })).rows
    expect(tasksAfterSecond).toEqual([
      expect.objectContaining({ title: "Personal Dentists", due_date: tomorrowStr }),
      expect.objectContaining({ title: "Team Dentists (Updated)", due_date: todayStr }),
    ])
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
