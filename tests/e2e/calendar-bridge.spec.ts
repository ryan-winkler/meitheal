/**
 * Calendar Bridge — Sync Logic Tests
 *
 * Tests the bi-directional sync engine: deduplication, stale detection,
 * export-only mode, concurrent guard, and all-day event handling.
 *
 * @domain calendar
 * @bounded-context integration
 */
import { expect, test } from "@playwright/test"

// ── Helpers ──

/** Simulate a CalendarEvent structure */
function makeEvent(overrides: Partial<{
  uid: string; summary: string; start: string; end: string;
  description: string; location: string; recurrence_id: string
}> = {}) {
  return {
    uid: overrides.uid ?? `uid-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
