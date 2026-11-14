/**
 * Calendar Recurrence, CalDAV iCal Compliance, Timed ISO Dates, & Query Tests
 *
 * Covers Requirement 11 fixes across:
 *   - apps/web/src/domains/calendar/recurrence.ts
 *   - apps/web/src/domains/calendar/caldav-client.ts
 *   - apps/web/src/lib/date.ts
 *   - apps/web/src/lib/task-queries.ts
 *   - apps/web/src/domains/tasks/persistence/task-repository.ts
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  expandRRuleOccurrences,
  getNextOccurrence,
  inferRRuleFromDates,
  matchesRRuleOnDate,
  normalizeRRule,
  parseRRule,
  toRRuleString,
} from "../../apps/web/src/domains/calendar/recurrence"
import {
  expandCalDAVEventsInWindow,
  extractXmlResponses,
  listCalDAVEvents,
  parseVEvents,
  validateCalDAVUrl,
} from "../../apps/web/src/domains/calendar/caldav-client"
import {
  calendarDayFromInput,
  calendarDaysFromToday,
  formatRegionalDate,
  formatRelativeDue,
} from "../../apps/web/src/lib/date"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { getTodayTaskCounts, todayDueSection } from "../../apps/web/src/lib/task-queries"

// ── 1. Calendar RRULE Engine ───────────────────────────────────────────

test.describe("calendar recurrence engine", () => {
  test("parses, normalizes, and formats DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL & BYDAY", () => {
    const parsed = parseRRule("RRULE:freq=weekly;interval=2;byday=mo,fr;count=5")
    expect(parsed).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byDay: ["MO", "FR"],
      count: 5,
      until: undefined,
    })
    expect(toRRuleString(parsed!)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=5")
    expect(normalizeRRule("rrule:freq=monthly;interval=1")).toBe("FREQ=MONTHLY")
    expect(normalizeRRule("FREQ=INVALID")).toBeNull()
  })

  test("computes next occurrence and matchesRRuleOnDate honoring EXDATE", () => {
    const rule = "FREQ=WEEKLY;BYDAY=FR"
    const next = getNextOccurrence(parseRRule(rule)!, new Date("2026-11-13T09:00:00Z"))
    expect(next?.toISOString().replace(/\.\d{3}Z$/, "Z")).toBe("2026-11-20T09:00:00Z")

    expect(matchesRRuleOnDate(rule, "2026-11-13", "2026-11-20", undefined, "Europe/Dublin")).toBe(true)
    expect(matchesRRuleOnDate(rule, "2026-11-13", "2026-11-20", ["2026-11-20"], "Europe/Dublin")).toBe(false)
  })

  test("expands MONTHLY and YEARLY with INTERVAL cleanly", () => {
    const monthly = expandRRuleOccurrences({
      dtstart: "2026-01-15",
      rrule: "FREQ=MONTHLY;INTERVAL=2",
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2026-06-01T23:59:59Z"),
      timezone: "Europe/Dublin",
    })
    expect(monthly.map((o) => o.start)).toEqual(["2026-01-15", "2026-03-15", "2026-05-15"])

    const yearly = expandRRuleOccurrences({
      dtstart: "2024-02-29",
      rrule: "FREQ=YEARLY",
      windowStart: new Date("2024-01-01T00:00:00Z"),
      windowEnd: new Date("2026-12-31T23:59:59Z"),
      timezone: "Europe/Dublin",
    })
    expect(yearly.map((o) => o.start)).toEqual(["2024-02-29", "2025-02-28", "2026-02-28"])
  })

  test("infers DAILY, WEEKLY;BYDAY, and MONTHLY RRULEs from multiple occurrence starts", () => {
    expect(inferRRuleFromDates(["2026-11-13T08:00:00Z", "2026-11-14T08:00:00Z", "2026-11-15T08:00:00Z"], "Europe/Dublin")).toBe("FREQ=DAILY")
    expect(inferRRuleFromDates(["2026-11-13T08:00:00Z", "2026-11-20T08:00:00Z", "2026-11-27T08:00:00Z"], "Europe/Dublin")).toBe("FREQ=WEEKLY;BYDAY=FR")
    expect(inferRRuleFromDates(["2026-10-13T08:00:00Z", "2026-11-13T08:00:00Z", "2026-12-13T08:00:00Z"], "Europe/Dublin")).toBe("FREQ=MONTHLY")
  })

  test("expands long-running daily series >500 days after dtstart and excludes floating EXDATE", () => {
    const hits = expandRRuleOccurrences({
      dtstart: "2024-01-01T09:00:00",
      dtend: "2024-01-01T10:00:00",
      rrule: "FREQ=DAILY",
      exdates: ["2026-06-02T09:00:00"],
      windowStart: new Date("2026-06-01T00:00:00Z"),
      windowEnd: new Date("2026-06-03T23:59:59Z"),
      timezone: "Europe/Dublin",
    })
    expect(hits.map((h) => h.start)).toEqual([
      "2026-06-01T09:00:00",
      "2026-06-03T09:00:00",
    ])
  })

  test("validates CalDAV SSRF IPv6/CGNAT/redirect/DOCTYPE/cross-origin defenses", async () => {
    for (const blocked of [
      "https://[::1]/cal",
      "https://[::ffff:127.0.0.1]/cal",
      "https://[::]/cal",
      "https://100.64.0.1/cal",
      "https://localhost./cal",
    ]) {
      expect(validateCalDAVUrl(blocked).valid, blocked).toBe(false)
    }
    expect(validateCalDAVUrl("https://caldav.example.com/dav").valid).toBe(true)

    await expect(
      listCalDAVEvents(
        { url: "https://caldav.example.com/dav", username: "u", password: "p" },
        "https://evil.example.net/steal",
        new Date("2026-11-01T00:00:00Z"),
        new Date("2026-11-02T00:00:00Z"),
      ),
    ).rejects.toThrow(/cross-origin/i)

    expect(() =>
      extractXmlResponses(`<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:multistatus/>`),
    ).toThrow(/DOCTYPE|ENTITY/i)

    const parsedXml = extractXmlResponses(
      `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
      `<D:response><D:href>/cal/home/</D:href><D:propstat><D:prop>` +
      `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
      `<D:displayname>Family</D:displayname>` +
      `<C:calendar-data><![CDATA[BEGIN:VCALENDAR\nEND:VCALENDAR]]></C:calendar-data>` +
      `</D:prop></D:propstat></D:response></D:multistatus>`,
    )
    expect(parsedXml).toEqual([
      {
        href: "/cal/home/",
        props: {
          displayname: "Family",
          calendarData: "BEGIN:VCALENDAR\nEND:VCALENDAR",
          isCalendar: "true",
        },
      },
    ])
  })
})

// ── 2. CalDAV Parser & RRULE/EXDATE Expansion ──────────────────────────

test.describe("CalDAV parser & expansion", () => {
  test("preserves colons in TZID, URLs, descriptions, and isolates VALARM", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:colon-tz-1",
      "SUMMARY:Team Sync: Q4 Roadmap",
      "DTSTART;TZID=America/New_York:20261113T090000",
      "DTEND;TZID=America/New_York:20261113T100000",
      "LOCATION:Room 4: North Wing",
      "DESCRIPTION:Link: https://example.com:8443/meet/abc",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder: starts soon",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")

    const events = parseVEvents(ics, "/cal/colon.ics")
    expect(events).toHaveLength(1)
    expect(events[0]!.summary).toBe("Team Sync: Q4 Roadmap")
    expect(events[0]!.location).toBe("Room 4: North Wing")
    expect(events[0]!.description).toBe("Link: https://example.com:8443/meet/abc")
    expect(events[0]!.tzid).toBe("America/New_York")
    // 09:00 EST (UTC-5 in Nov after DST end) == 14:00:00Z
    expect(events[0]!.dtstart).toBe("2026-11-13T14:00:00Z")
  })

  test("handles exclusive all-day DTEND and expands RRULE with EXDATE + RECURRENCE-ID override", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:holiday-1",
      "SUMMARY:School Break",
      "DTSTART;VALUE=DATE:20261113",
      "DTEND;VALUE=DATE:20261115",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:chore-weekly",
      "SUMMARY:Trash Pickup",
      "DTSTART:20261106T080000Z",
      "DTEND:20261106T083000Z",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "EXDATE:20261120T080000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:chore-weekly",
      "RECURRENCE-ID:20261113T080000Z",
      "SUMMARY:Trash Pickup (Delayed)",
      "DTSTART:20261113T100000Z",
      "DTEND:20261113T103000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")

    const parsed = parseVEvents(ics, "/cal/mixed.ics")
    expect(parsed[0]!.dtstart).toBe("2026-11-13")
    expect(parsed[0]!.dtend).toBe("2026-11-15")
    expect(parsed[0]!.inclusiveEndDate).toBe("2026-11-14")

    const expanded = expandCalDAVEventsInWindow(
      parsed,
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-12-01T00:00:00Z"),
    )
    const weekly = expanded.filter((e) => e.uid === "chore-weekly")
    // 4 generated (Nov 6, Nov 13, Nov 20, Nov 27), Nov 20 excluded by EXDATE, Nov 13 replaced by RECURRENCE-ID override
    expect(weekly.map((e) => [e.dtstart, e.summary])).toEqual([
      ["2026-11-06T08:00:00Z", "Trash Pickup"],
      ["2026-11-13T10:00:00Z", "Trash Pickup (Delayed)"],
      ["2026-11-27T08:00:00Z", "Trash Pickup"],
    ])
  })
})

// ── 3. Timed ISO Dates Across date.ts & task-queries.ts ────────────────

test.describe("timed ISO date helpers", () => {
  test("calendarDayFromInput extracts local household calendar day across timezones", () => {
    expect(calendarDayFromInput("2026-11-13", "America/New_York")).toBe("2026-11-13")
    expect(calendarDayFromInput("2026-11-13T18:30:00", "America/New_York")).toBe("2026-11-13")
    // 2026-11-14T01:30:00Z is 2026-11-13 20:30 in New York (-05:00)
    expect(calendarDayFromInput("2026-11-14T01:30:00Z", "America/New_York")).toBe("2026-11-13")
    // 2026-11-13T20:00:00Z is 2026-11-14 05:00 in Tokyo (+09:00)
    expect(calendarDayFromInput("2026-11-13T20:00:00Z", "Asia/Tokyo")).toBe("2026-11-14")
  })

  test("calendarDaysFromToday & relative labels never classify today's timed ISO event as overdue", () => {
    const now = new Date("2026-11-13T12:00:00Z")
    expect(calendarDaysFromToday("2026-11-13T09:00:00Z", "Europe/Dublin", now)).toBe(0)
    expect(calendarDaysFromToday("2026-11-13T18:30:00Z", "Europe/Dublin", now)).toBe(0)
    expect(calendarDaysFromToday("2026-11-14T01:30:00Z", "America/New_York", now)).toBe(0)

    expect(formatRelativeDue("2026-11-13T18:30:00Z", "Europe/Dublin", now)).toBe("Today · 18:30")
    expect(formatRelativeDue("2026-11-13", "Europe/Dublin", now)).toBe("Due today")
    expect(formatRegionalDate("2026-11-13T18:30:00Z", {
      format: "relative",
      timezone: "Europe/Dublin",
      now,
    })).toBe("Today · 18:30")
  })

  test("todayDueSection puts today's timed ISO event in due (not carried or dropped)", () => {
    expect(todayDueSection("2026-11-13T09:00:00Z", "2026-11-13", "Europe/Dublin")).toBe("due")
    expect(todayDueSection("2026-11-13T18:30:00Z", "2026-11-13", "Europe/Dublin")).toBe("due")
    expect(todayDueSection("2026-11-12T23:00:00Z", "2026-11-13", "Europe/Dublin")).toBe("carried")
    expect(todayDueSection("2026-11-14T09:00:00Z", "2026-11-13", "Europe/Dublin")).toBeNull()
  })
})

// ── 4. TaskRepository Timed ISO & Multi-Occurrence Queries ─────────────

test("TaskRepository queries handle timed ISO due dates and expanded HA event occurrences", async () => {
  const previousDb = process.env.MEITHEAL_DB_URL
  const directory = await mkdtemp(join(tmpdir(), "meitheal-repo-timed-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()

  try {
    await ensureSchema()
    const repo = new TaskRepository(db)

    // Seed tasks: yesterday overdue, earlier today timed, later today timed, month-end timed, tomorrow high-priority timed
    await db.batch([
      {
        sql: `INSERT INTO tasks (id, title, status, priority, due_date, task_kind, idempotency_key, request_id, created_at, updated_at)
              VALUES ('t-overdue', 'Yesterday Task', 'pending', 2, '2026-11-12T10:00:00Z', 'task', 'k-overdue', 'r-overdue', 1, 1)`,
        args: [],
      },
      {
        sql: `INSERT INTO tasks (id, title, status, priority, due_date, task_kind, idempotency_key, request_id, created_at, updated_at)
              VALUES ('t-today-am', 'Earlier Today', 'pending', 2, '2026-11-13T08:00:00Z', 'calendar_event', 'k-today-am', 'r-today-am', 2, 2)`,
        args: [],
      },
      {
        sql: `INSERT INTO tasks (id, title, status, priority, due_date, color, task_kind, idempotency_key, request_id, created_at, updated_at)
              VALUES ('t-today-pm', 'Later Today', 'pending', 1, '2026-11-13T18:30:00Z', '#3b82f6', 'task', 'k-today-pm', 'r-today-pm', 3, 3)`,
        args: [],
      },
      {
        sql: `INSERT INTO tasks (id, title, status, priority, due_date, task_kind, idempotency_key, request_id, created_at, updated_at)
              VALUES ('t-tomorrow-hi', 'Tomorrow Urgent', 'pending', 1, '2026-11-14T09:00:00Z', 'task', 'k-tomorrow-hi', 'r-tomorrow-hi', 4, 4)`,
        args: [],
      },
      {
        sql: `INSERT INTO tasks (id, title, status, priority, due_date, task_kind, idempotency_key, request_id, created_at, updated_at)
              VALUES ('t-month-end', 'Month End Timed', 'pending', 3, '2026-11-30T20:00:00Z', 'task', 'k-month-end', 'r-month-end', 5, 5)`,
        args: [],
      },
    ], "write")

    // Today's timed tasks must appear in getTasksDueOn and MUST NOT appear in overdue
    const dueToday = await repo.getTasksDueOn("2026-11-13", "Europe/Dublin")
    expect(dueToday.map((r) => r.id).sort()).toEqual(["t-today-am", "t-today-pm"])

    const overdue = await repo.getOverdueTasks("2026-11-13", "Europe/Dublin")
    expect(overdue.map((r) => r.id)).toEqual(["t-overdue"])
    expect(await repo.getOverdueCount("2026-11-13", "Europe/Dublin")).toBe(1)

    // Suggested tasks must include tomorrow high-priority timed, and NOT duplicate later-today timed
    const suggested = await repo.getSuggestedTasks("2026-11-13", 10, "Europe/Dublin")
    expect(suggested.map((r) => r.id)).toEqual(["t-tomorrow-hi"])

    // Range & Calendar task counts include month-end timed ISO timestamps
    const inRange = await repo.getTasksInRange("2026-11-13", "2026-11-30", "Europe/Dublin")
    expect(inRange.map((r) => r.id).sort()).toEqual(["t-month-end", "t-today-am", "t-today-pm", "t-tomorrow-hi"])

    const dayCounts = await repo.getCalendarTaskCounts("2026-11-01", "2026-11-30", "Europe/Dublin")
    expect(dayCounts["2026-11-13"]?.count).toBe(2)
    expect(dayCounts["2026-11-30"]?.count).toBe(1)

    // getTodayTaskCounts classifies both timed today tasks under dueToday (not carriedForward)
    const todayCounts = await getTodayTaskCounts(new Date("2026-11-13T12:00:00Z"), "Europe/Dublin")
    expect(todayCounts.dueToday).toBe(2)
    expect(todayCounts.carriedForward).toBe(1)

    // getCalendarHAEventCounts expands multi-occurrence confirmation payload intervals
    await db.batch([
      {
        sql: `UPDATE tasks SET calendar_sync_state = 'synced' WHERE id = 't-today-am'`,
        args: [],
      },
      {
        sql: `INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
              VALUES ('conf-1', 't-today-am', 'req-1', 'uid-am', 'ha.calendar_sync', ?, 1)`,
        args: [
          JSON.stringify({
            occurrences: [
              { start: "2026-11-13T08:00:00Z", end: "2026-11-13T09:00:00Z", effective_end: "2026-11-13" },
              { start: "2026-11-20", end: "2026-11-22" }, // exclusive end -> spans Nov 20 & Nov 21
            ],
          }),
        ],
      },
    ], "write")

    const haCounts = await repo.getCalendarHAEventCounts("2026-11-01", "2026-11-30", "Europe/Dublin")
    expect(haCounts["2026-11-13"]).toBe(1)
    expect(haCounts["2026-11-20"]).toBe(1)
    expect(haCounts["2026-11-21"]).toBe(1)
    expect(haCounts["2026-11-22"] ?? 0).toBe(0)
  } finally {
    db.close()
    resetPersistenceForTests()
    if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDb
    await rm(directory, { recursive: true, force: true })
  }
})
