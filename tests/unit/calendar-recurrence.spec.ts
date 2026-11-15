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
  calendarToday,
  formatRegionalDate,
  formatRelativeDue,
  shiftCalendarDay,
} from "../../apps/web/src/lib/date"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"
import { SettingsRepository } from "../../apps/web/src/domains/tasks/persistence/settings-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { GET as getTodayCountsRoute } from "../../apps/web/src/pages/api/tasks/today-counts"
import { loadKanbanBoard } from "../../apps/web/src/lib/kanban-board-data"
import { getTasksForView, getTodayTaskCounts, getTodayTaskRows, todayDueSection } from "../../apps/web/src/lib/task-queries"

// ── 1. Calendar RRULE Engine ───────────────────────────────────────────

test.describe("calendar recurrence engine", () => {
  test("parses, normalizes, and formats DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL & BYDAY", () => {
    const parsed = parseRRule("RRULE:freq=weekly;interval=2;byday=mo,fr;count=5")
    expect(parsed).toEqual({
      freq: "WEEKLY",
      interval: 2,
      byDay: ["MO", "FR"],
      byDayEntries: [{ ordinal: null, day: "MO" }, { ordinal: null, day: "FR" }],
      count: 5,
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
    // RFC 5545 §3.3.10: a year without February 29 has no occurrence.
    expect(yearly.map((o) => o.start)).toEqual(["2024-02-29"])
    const leapYears = expandRRuleOccurrences({
      dtstart: "2024-02-29",
      rrule: "FREQ=YEARLY;COUNT=2",
      windowStart: new Date("2024-01-01T00:00:00Z"),
      windowEnd: new Date("2032-12-31T23:59:59Z"),
      timezone: "Europe/Dublin",
    })
    expect(leapYears.map((o) => o.start)).toEqual(["2024-02-29", "2028-02-29"])
  })

  test("keeps ordinal BYDAY, BYMONTHDAY and BYSETPOS rules and expands them exactly", () => {
    expect(normalizeRRule("FREQ=MONTHLY;BYDAY=2TU")).toBe("FREQ=MONTHLY;BYDAY=2TU")
    expect(normalizeRRule("FREQ=MONTHLY;BYMONTHDAY=-1")).toBe("FREQ=MONTHLY;BYMONTHDAY=-1")
    expect(normalizeRRule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")).toBe("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")
    expect(normalizeRRule("FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU")).toBe("FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3")
    // Parts the engine does not model are kept exactly as the provider wrote them.
    expect(normalizeRRule("FREQ=DAILY;BYHOUR=9,17")).toBe("FREQ=DAILY;BYHOUR=9,17")

    const window = { windowStart: new Date("2026-01-01T00:00:00Z"), windowEnd: new Date("2026-04-30T23:59:59Z"), timezone: "Europe/Dublin" }
    const secondTuesday = expandRRuleOccurrences({ dtstart: "2026-01-13", rrule: "FREQ=MONTHLY;BYDAY=2TU", ...window })
    expect(secondTuesday.map((o) => o.start)).toEqual(["2026-01-13", "2026-02-10", "2026-03-10", "2026-04-14"])
    const lastDay = expandRRuleOccurrences({ dtstart: "2026-01-31", rrule: "FREQ=MONTHLY;BYMONTHDAY=-1", ...window })
    expect(lastDay.map((o) => o.start)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"])
    const lastWeekday = expandRRuleOccurrences({ dtstart: "2026-01-30", rrule: "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", ...window })
    expect(lastWeekday.map((o) => o.start)).toEqual(["2026-01-30", "2026-02-27", "2026-03-31", "2026-04-30"])
    const lastSundayOfMarch = expandRRuleOccurrences({
      dtstart: "2025-03-30", rrule: "FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
      windowStart: new Date("2025-01-01T00:00:00Z"), windowEnd: new Date("2027-12-31T23:59:59Z"), timezone: "Europe/Dublin",
    })
    expect(lastSundayOfMarch.map((o) => o.start)).toEqual(["2025-03-30", "2026-03-29", "2027-03-28"])
  })

  test("a DAILY rule with BYDAY repeats only on the listed weekdays and counts only those", () => {
    const weekdays = expandRRuleOccurrences({
      dtstart: "2026-11-13",
      rrule: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=4",
      windowStart: new Date("2026-11-01T00:00:00Z"),
      windowEnd: new Date("2026-11-30T23:59:59Z"),
      timezone: "UTC",
    })
    expect(weekdays.map((o) => o.start)).toEqual(["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18"])
  })

  test("a series started on the 31st skips months without a 31st, as CalDAV servers do", () => {
    const monthly = expandRRuleOccurrences({
      dtstart: "2026-01-31",
      rrule: "FREQ=MONTHLY",
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2026-05-31T23:59:59Z"),
      timezone: "Europe/Dublin",
    })
    expect(monthly.map((o) => o.start)).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"])
  })

  test("BYMONTH, BYMONTHDAY and BYDAY limits apply to every frequency", () => {
    const seasonal = expandRRuleOccurrences({
      dtstart: "2026-04-07",
      rrule: "FREQ=WEEKLY;BYDAY=TU;BYMONTH=4,5,6,7,8,9,10",
      windowStart: new Date("2026-10-20T00:00:00Z"),
      windowEnd: new Date("2026-11-30T23:59:59Z"),
      timezone: "UTC",
    })
    expect(seasonal.map((o) => o.start)).toEqual(["2026-10-20", "2026-10-27"])

    const fridayThe13th = expandRRuleOccurrences({
      dtstart: "2026-02-13",
      rrule: "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13",
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2026-12-31T23:59:59Z"),
      timezone: "UTC",
    })
    expect(fridayThe13th.map((o) => o.start)).toEqual(["2026-02-13", "2026-03-13", "2026-11-13"])

    const firstAndFifteenth = expandRRuleOccurrences({
      dtstart: "2026-11-01",
      rrule: "FREQ=DAILY;BYMONTHDAY=1,15;COUNT=3",
      windowStart: new Date("2026-11-01T00:00:00Z"),
      windowEnd: new Date("2027-01-31T23:59:59Z"),
      timezone: "UTC",
    })
    expect(firstAndFifteenth.map((o) => o.start)).toEqual(["2026-11-01", "2026-11-15", "2026-12-01"])

    // A YEARLY BYDAY without BYMONTH covers the whole year; an ordinal counts within the year.
    const everyMondayOfYear = expandRRuleOccurrences({
      dtstart: "2026-01-05",
      rrule: "FREQ=YEARLY;BYDAY=MO;COUNT=6",
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2026-12-31T23:59:59Z"),
      timezone: "UTC",
    })
    expect(everyMondayOfYear.map((o) => o.start)).toEqual(["2026-01-05", "2026-01-12", "2026-01-19", "2026-01-26", "2026-02-02", "2026-02-09"])
    const twentiethMonday = expandRRuleOccurrences({
      dtstart: "2026-05-18",
      rrule: "FREQ=YEARLY;BYDAY=20MO",
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2027-12-31T23:59:59Z"),
      timezone: "UTC",
    })
    expect(twentiethMonday.map((o) => o.start)).toEqual(["2026-05-18", "2027-05-17"])
    const never = expandRRuleOccurrences({
      dtstart: "2026-01-01",
      rrule: "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30",
      windowStart: new Date("2026-01-01T00:00:00Z"),
      windowEnd: new Date("2027-12-31T23:59:59Z"),
      timezone: "UTC",
    })
    expect(never).toEqual([])

    // BYSETPOS is only modelled within a month, so a DAILY rule keeps it verbatim.
    expect(normalizeRRule("FREQ=DAILY;BYDAY=MO,FR;BYSETPOS=1")).toBe("FREQ=DAILY;BYDAY=MO,FR;BYSETPOS=1")
  })

  test("a long-running daily series still expands in the current window", () => {
    const daily = expandRRuleOccurrences({
      dtstart: "2024-01-01T08:00:00Z",
      rrule: "FREQ=DAILY",
      windowStart: new Date("2026-11-10T00:00:00Z"),
      windowEnd: new Date("2026-11-12T23:59:59Z"),
      timezone: "UTC",
    })
    expect(daily.map((o) => o.start.slice(0, 10))).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"])
    const counted = expandRRuleOccurrences({
      dtstart: "2026-11-01",
      rrule: "FREQ=DAILY;COUNT=3",
      windowStart: new Date("2026-11-01T00:00:00Z"),
      windowEnd: new Date("2026-11-30T23:59:59Z"),
      timezone: "UTC",
    })
    expect(counted.map((o) => o.start)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"])
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

  test("excludes EXDATEs on non-RRULE single events and handles UTC-midnight boundary in matchesRRuleOnDate", () => {
    expect(expandRRuleOccurrences({
      dtstart: "2026-11-15T09:00:00Z",
      dtend: "2026-11-15T10:00:00Z",
      exdates: ["2026-11-15"],
      windowStart: new Date("2026-11-01T00:00:00Z"),
      windowEnd: new Date("2026-11-30T23:59:59Z"),
      timezone: "Europe/Dublin",
    })).toEqual([])

    expect(expandRRuleOccurrences({
      dtstart: "2026-11-15T09:00:00Z",
      dtend: "2026-11-15T10:00:00Z",
      exdates: ["2026-11-15T09:00:00Z"],
      windowStart: new Date("2026-11-01T00:00:00Z"),
      windowEnd: new Date("2026-11-30T23:59:59Z"),
      timezone: "Europe/Dublin",
    })).toEqual([])

    expect(
      matchesRRuleOnDate("FREQ=DAILY", "2026-11-13T06:30:00Z", "2026-11-12", undefined, "America/Los_Angeles"),
    ).toBe(true)
    expect(
      matchesRRuleOnDate("FREQ=DAILY", "2026-11-12T12:30:00Z", "2026-11-13", undefined, "Pacific/Auckland"),
    ).toBe(true)
  })

  test("expands floating non-zoned timestamps against the provided UTC window deterministically", () => {
    const hits = expandRRuleOccurrences({
      dtstart: "2026-11-15T23:30:00",
      dtend: "2026-11-16T00:15:00",
      rrule: "FREQ=DAILY;COUNT=2",
      timezone: "America/Los_Angeles",
      windowStart: new Date("2026-11-15T23:45:00Z"),
      windowEnd: new Date("2026-11-16T00:05:00Z"),
    })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.start).toBe("2026-11-15T23:30:00")
  })

  test("validates CalDAV SSRF IPv6/CGNAT/redirect/DOCTYPE/cross-origin defenses", async () => {
    for (const blocked of [
      "https://[::1]/cal",
      "https://[::ffff:127.0.0.1]/cal",
      "https://[::]/cal",
      "https://100.64.0.1/cal",
      "https://[::ffff:100.64.0.1]/cal",
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
    ).rejects.toThrow(/another origin|cross-origin/i)

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

test("Kanban overdue index and getTasksForView slim counts evaluate timed ISO due dates in household timezone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-tz-overdue-"))
  const previousDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tz-overdue.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()
  try {
    await ensureSchema()
    const todayAkl = calendarToday("Pacific/Auckland")
    const todayLa = calendarToday("America/Los_Angeles")
    // In Pacific/Auckland (+12/+13), 22:00Z on yesterday is already 10:00/11:00 todayAkl (NOT overdue).
    const aklTodayIso = `${shiftCalendarDay(todayAkl, -1)}T22:00:00Z`
    // In America/Los_Angeles (-7/-8), 02:00Z on todayLa is 18:00/19:00 yesterday in LA (IS overdue).
    const laOverdueIso = `${todayLa}T02:00:00Z`

    await db.execute({
      sql: `INSERT INTO tasks (id, title, status, priority, due_date, task_kind, idempotency_key, request_id, created_at, updated_at)
            VALUES ('tz-akl', 'Auckland Later Today', 'pending', 2, ?, 'task', 'k-akl', 'r-akl', 1, 1),
                   ('tz-la', 'LA Yesterday Evening', 'pending', 2, ?, 'task', 'k-la', 'r-la', 2, 2)`,
      args: [aklTodayIso, laOverdueIso],
    })

    const repo = new TaskRepository(db)
    const lanes = [{ id: "pending", key: "pending", label: "Pending", icon: "clock", includes: ["pending"], builtIn: true, wipLimit: 0 }]

    const aklBoard = await loadKanbanBoard(repo, lanes, 0, new URLSearchParams("status=overdue"), "Pacific/Auckland")
    const aklPendingIds = aklBoard.get("pending")?.ids ?? []
    expect(aklPendingIds).not.toContain("tz-akl")

    const laBoard = await loadKanbanBoard(repo, lanes, 0, new URLSearchParams("status=overdue"), "America/Los_Angeles")
    const laPendingIds = laBoard.get("pending")?.ids ?? []
    expect(laPendingIds).toContain("tz-la")

    const aklView = await getTasksForView({ slim: true, timezone: "Pacific/Auckland" })
    const laView = await getTasksForView({ slim: true, timezone: "America/Los_Angeles" })
    expect(aklView.tasks.find((t) => t.id === "tz-akl")?.is_overdue).toBe(false)
    expect(laView.tasks.find((t) => t.id === "tz-la")?.is_overdue).toBe(true)
    expect(aklView.counts.overdue).toBe(aklView.tasks.filter((t) => t.is_overdue).length)
    expect(laView.counts.overdue).toBe(laView.tasks.filter((t) => t.is_overdue).length)
  } finally {
    db.close()
    resetPersistenceForTests()
    if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDb
    await rm(directory, { recursive: true, force: true })
  }
})

test("biweekly BYDAY rules spanning Sunday respect week boundaries and WKST", () => {
  const moWkst = expandRRuleOccurrences({
    dtstart: "2026-11-02",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU",
    windowStart: new Date("2026-11-01T00:00:00Z"),
    windowEnd: new Date("2026-11-25T23:59:59Z"),
    timezone: "UTC",
  })
  expect(moWkst.map((o) => o.start)).toEqual([
    "2026-11-02",
    "2026-11-08",
    "2026-11-16",
    "2026-11-22",
  ])

  expect(normalizeRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU")).toBe(
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU",
  )
  const suWkst = expandRRuleOccurrences({
    dtstart: "2026-11-02",
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,SU;WKST=SU",
    windowStart: new Date("2026-11-01T00:00:00Z"),
    windowEnd: new Date("2026-11-25T23:59:59Z"),
    timezone: "UTC",
  })
  expect(suWkst.map((o) => o.start)).toEqual([
    "2026-11-02",
    "2026-11-15",
    "2026-11-16",
  ])
})

test("CalDAV expansion excludes STATUS:CANCELLED standalone events and RECURRENCE-ID overrides", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:cancelled-standalone",
    "SUMMARY:Cancelled One-Off",
    "STATUS:CANCELLED",
    "DTSTART:20261110T090000Z",
    "DTEND:20261110T100000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-series",
    "SUMMARY:Weekly Sync",
    "DTSTART:20261102T090000Z",
    "DTEND:20261102T100000Z",
    "RRULE:FREQ=WEEKLY;COUNT=4",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-series",
    "SUMMARY:Weekly Sync",
    "STATUS:CANCELLED",
    "RECURRENCE-ID:20261109T090000Z",
    "DTSTART:20261109T090000Z",
    "DTEND:20261109T100000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:weekly-series",
    "STATUS:CANCELLED",
    "RECURRENCE-ID:20261116T090000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:win-tz-series",
    "SUMMARY:Windows TZ Weekly",
    "DTSTART;TZID=\"Eastern Standard Time\":20261103T090000",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")

  const parsed = parseVEvents(ics, "/cal/team.ics")
  const expanded = expandCalDAVEventsInWindow(
    parsed,
    new Date("2026-11-01T00:00:00Z"),
    new Date("2026-11-25T23:59:59Z"),
  )
  expect(expanded.map((e) => `${e.uid}@${e.dtstart}`)).toEqual([
    "weekly-series@2026-11-02T09:00:00Z",
    "win-tz-series@2026-11-03T09:00:00",
    "win-tz-series@2026-11-10T09:00:00",
    "weekly-series@2026-11-23T09:00:00Z",
  ])
})

test("entity-escaped SabreDAV calendar-data keeps RRULE, UNTIL and STATUS intact", () => {
  const escapedIcs = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:bins",
    "SUMMARY:Bins &amp; recycling",
    "DTSTART:20261102T080000Z",
    "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261110T000000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:club",
    "SUMMARY:Book club",
    "DTSTART:20261110T180000Z",
    "RRULE:FREQ=MONTHLY;BYDAY=2TU",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:club",
    "RECURRENCE-ID:20261208T180000Z",
    "DTSTART:20261208T180000Z",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("&#13;\n")
  const [response] = extractXmlResponses(
    `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<D:response><D:href>/cal/home/bins.ics?x=1&amp;y=2</D:href><D:propstat><D:prop>` +
    `<C:calendar-data>${escapedIcs}</C:calendar-data>` +
    `</D:prop></D:propstat></D:response></D:multistatus>`,
  )
  expect(response?.href).toBe("/cal/home/bins.ics?x=1&y=2")
  const parsed = parseVEvents(response!.props.calendarData!, response!.href)
  expect(parsed.find(e => e.uid === "bins")?.summary).toBe("Bins & recycling")
  const expanded = expandCalDAVEventsInWindow(
    parsed,
    new Date("2026-11-01T00:00:00Z"),
    new Date("2027-01-31T23:59:59Z"),
  )
  expect(expanded.map((e) => `${e.uid}@${e.dtstart}`)).toEqual([
    "bins@2026-11-02T08:00:00Z",
    "bins@2026-11-09T08:00:00Z",
    "club@2026-11-10T18:00:00Z",
    "club@2027-01-12T18:00:00Z",
  ])
})

test("completing a local repeating calendar_event task spawns its next occurrence and keeps task_kind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-local-event-repeat-"))
  const previousDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "local-repeat.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()
  try {
    await ensureSchema()
    await db.execute({
      sql: `INSERT INTO tasks (id, title, status, priority, due_date, recurrence_rule, task_kind, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('local-evt-1', 'Local Team Standup', 'pending', 3, '2026-11-02', 'FREQ=WEEKLY', 'calendar_event', 'k-le1', 'r-le1', 10, 1, 1)`,
      args: [],
    })
    const repo = new TaskRepository(db)
    const outcome = await repo.updateTask("local-evt-1", { status: "complete" })
    expect(outcome.ok).toBe(true)

    const rows = await db.execute({
      sql: `SELECT id, status, due_date, recurrence_rule, task_kind FROM tasks ORDER BY created_at ASC`,
      args: [],
    })
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows[0]!.status).toBe("complete")
    expect(rows.rows[1]!.status).toBe("pending")
    expect(rows.rows[1]!.due_date).toBe("2026-11-09")
    expect(rows.rows[1]!.recurrence_rule).toBe("FREQ=WEEKLY")
    expect(rows.rows[1]!.task_kind).toBe("calendar_event")
  } finally {
    db.close()
    resetPersistenceForTests()
    if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDb
    await rm(directory, { recursive: true, force: true })
  }
})

test("toRRuleString and CalDAV expansion preserve UNTIL time and zone cutoff", () => {
  expect(normalizeRRule("FREQ=DAILY;UNTIL=20261117T080000Z")).toBe("FREQ=DAILY;UNTIL=20261117T080000Z")
  expect(normalizeRRule("FREQ=DAILY;UNTIL=20261117T080000")).toBe("FREQ=DAILY;UNTIL=20261117T080000")
  expect(toRRuleString({ freq: "DAILY", interval: 1, until: "2026-11-17T08:00:00Z" })).toBe("FREQ=DAILY;UNTIL=20261117T080000Z")

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:until-cutoff-series",
    "SUMMARY:Morning Check-in",
    "DTSTART:20261115T090000Z",
    "DTEND:20261115T093000Z",
    "RRULE:FREQ=DAILY;UNTIL=20261117T080000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")

  const parsed = parseVEvents(ics, "/cal/cutoff.ics")
  expect(parsed[0]?.rrule).toBe("FREQ=DAILY;UNTIL=20261117T080000Z")

  const expanded = expandCalDAVEventsInWindow(
    parsed,
    new Date("2026-11-14T00:00:00Z"),
    new Date("2026-11-20T23:59:59Z"),
  )
  expect(expanded.map((e) => e.dtstart)).toEqual([
    "2026-11-15T09:00:00Z",
    "2026-11-16T09:00:00Z",
  ])

  // Positive UTC offset (IST = UTC+1) where 00:30 local shifts UTC day back: final exact UNTIL occurrence stays included
  const positiveOffsetExpanded = expandRRuleOccurrences({
    dtstart: "2026-07-01T23:30:00Z",
    rrule: "FREQ=DAILY;UNTIL=20260703T233000Z",
    timezone: "Europe/Dublin",
    windowStart: new Date("2026-07-01T00:00:00Z"),
    windowEnd: new Date("2026-07-10T23:59:59Z"),
  })
  expect(positiveOffsetExpanded.map((o) => o.start)).toEqual([
    "2026-07-01T23:30:00Z",
    "2026-07-02T23:30:00Z",
    "2026-07-03T23:30:00Z",
  ])
})

test("GET /api/tasks/today-counts and getTodayTaskCounts evaluate counters in the household timezone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-today-counts-tz-"))
  const previousDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "today-counts.db")}`
  resetPersistenceForTests()
  const db = getPersistenceClient()
  try {
    await ensureSchema()
    const settings = new SettingsRepository(db)
    await settings.ensureSettingsTable()
    await settings.upsert("timezone", "America/Los_Angeles")

    // 2026-11-13T02:00:00Z is 2026-11-12 18:00 in America/Los_Angeles (carried forward on Nov 13 LA),
    // but 2026-11-13 02:00 in Europe/Dublin (due today on Nov 13 Dublin).
    await db.execute({
      sql: `INSERT INTO tasks (id, title, status, priority, due_date, idempotency_key, request_id, ticket_number, created_at, updated_at)
            VALUES ('tz-Boundary-1', 'Late Evening LA', 'pending', 3, '2026-11-13T02:00:00Z', 'k-tz-b1', 'r-tz-b1', 1, 1, 1)`,
      args: [],
    })

    // Omitting timezone reads household settings.timezone (America/Los_Angeles), not hardcoded Europe/Dublin
    const storedTzCounts = await getTodayTaskCounts(new Date("2026-11-13T12:00:00Z"))
    expect(storedTzCounts.dueToday).toBe(0)
    expect(storedTzCounts.carriedForward).toBe(1)

    const dublinCounts = await getTodayTaskCounts(new Date("2026-11-13T12:00:00Z"), "Europe/Dublin")
    expect(dublinCounts.dueToday).toBe(1)
    expect(dublinCounts.carriedForward).toBe(0)

    // Evening completions in America/Los_Angeles (2026-11-14 18:30 PST = 2026-11-15T02:30:00Z)
    // count toward 2026-11-14 in LA (not 2026-11-15), for both epoch ms and ISO text updated_at.
    const laEveningMs = Date.parse("2026-11-15T02:30:00Z")
    await db.batch([
      {
        sql: `INSERT INTO tasks (id, title, status, priority, idempotency_key, request_id, ticket_number, created_at, updated_at)
              VALUES ('la-done-ms', 'Completed LA Evening (ms)', 'complete', 3, 'k-la-ms', 'r-la-ms', 2, ?, ?)`,
        args: [laEveningMs, laEveningMs],
      },
      {
        sql: `INSERT INTO tasks (id, title, status, priority, idempotency_key, request_id, ticket_number, created_at, updated_at)
              VALUES ('la-done-iso', 'Completed LA Evening (iso)', 'complete', 3, 'k-la-iso', 'r-la-iso', 3, ?, '2026-11-15T02:30:00Z')`,
        args: [laEveningMs],
      },
    ], "write")
    const laNov14Counts = await getTodayTaskCounts(new Date("2026-11-15T03:00:00Z"))
    expect(laNov14Counts.completedToday).toBe(2)
    expect(laNov14Counts.completionPercent).toBe(Math.round((2 / 3) * 100))
    const laNov14Rows = await getTodayTaskRows("2026-11-14", false, "America/Los_Angeles")
    expect(laNov14Rows.completedTodayCount).toBe(2)
    const laNov15Counts = await getTodayTaskCounts(new Date("2026-11-15T18:00:00Z"))
    expect(laNov15Counts.completedToday).toBe(0)

    // Deterministically verify GET /api/tasks/today-counts across the international date line at any UTC hour
    const now = new Date()
    const behindDay = calendarToday("Etc/GMT+12", now)
    await db.execute({
      sql: `UPDATE tasks SET due_date = ? WHERE id = 'tz-Boundary-1'`,
      args: [behindDay],
    })
    await settings.upsert("timezone", "Etc/GMT+12")

    const behindResp = await getTodayCountsRoute({ locals: { timezone: "Etc/GMT+12" } } as unknown as Parameters<typeof getTodayCountsRoute>[0])
    expect(behindResp.status).toBe(200)
    await expect(behindResp.json()).resolves.toMatchObject({ dueToday: 1, carriedForward: 0 })

    // Even if locals.timezone is unset, the route honors persisted household timezone in settings
    const fallbackResp = await getTodayCountsRoute({ locals: {} } as unknown as Parameters<typeof getTodayCountsRoute>[0])
    expect(fallbackResp.status).toBe(200)
    await expect(fallbackResp.json()).resolves.toMatchObject({ dueToday: 1, carriedForward: 0 })

    const aheadResp = await getTodayCountsRoute({ locals: { timezone: "Pacific/Kiritimati" } } as unknown as Parameters<typeof getTodayCountsRoute>[0])
    expect(aheadResp.status).toBe(200)
    await expect(aheadResp.json()).resolves.toMatchObject({ dueToday: 0, carriedForward: 1 })
  } finally {
    db.close()
    resetPersistenceForTests()
    if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDb
    await rm(directory, { recursive: true, force: true })
  }
})

test("CalDAV XML scanning keeps offsets for characters whose lowercase form is longer and stays linear on unclosed tags", () => {
  const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>/cal/a/</d:href><d:propstat><d:prop><d:displayname>İstanbul</d:displayname></d:prop></d:propstat></d:response><d:response><d:href>/cal/b/</d:href><d:propstat><d:prop><d:displayname>Second</d:displayname></d:prop></d:propstat></d:response></d:multistatus>`
  const parsed = extractXmlResponses(xml)
  expect(parsed.map((r) => r.href)).toEqual(["/cal/a/", "/cal/b/"])
  expect(parsed.map((r) => r.props.displayname)).toEqual(["İstanbul", "Second"])

  const unclosed = `<d:multistatus xmlns:d="DAV:">${"<d:response><d:href>/x".repeat(20000)}</d:multistatus>`
  const startedAt = Date.now()
  expect(extractXmlResponses(unclosed)).toEqual([])
  expect(Date.now() - startedAt).toBeLessThan(2000)
})

test("CalDAV property lines split on the first colon outside quoted parameters", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:alt-1",
    "SUMMARY:Planning",
    "DTSTART:20261116T090000Z",
    'DESCRIPTION;ALTREP="cid:part1@example.org":Meeting notes',
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  const [event] = parseVEvents(ics, "/cal/alt.ics")
  expect(event?.description).toBe("Meeting notes")
})

test("RECURRENCE-ID RANGE=THISANDFUTURE moves every later instance, keeps earlier ones and survives DST", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:range-1",
    "SUMMARY:Standup",
    "DTSTART;TZID=Europe/Dublin:20261019T090000",
    "DTEND;TZID=Europe/Dublin:20261019T093000",
    "RRULE:FREQ=WEEKLY;COUNT=6",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:range-1",
    "SUMMARY:Standup (later)",
    "RECURRENCE-ID;TZID=Europe/Dublin;RANGE=THISANDFUTURE:20261102T090000",
    "DTSTART;TZID=Europe/Dublin:20261102T100000",
    "DTEND;TZID=Europe/Dublin:20261102T103000",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseVEvents(ics, "/cal/range.ics")
  expect(parsed.find((e) => e.recurrenceId)?.recurrenceRange).toBe("THISANDFUTURE")
  const expanded = expandCalDAVEventsInWindow(parsed, new Date("2026-10-15T00:00:00Z"), new Date("2026-12-31T00:00:00Z"))
  const starts = expanded.map((e) => `${e.dtstart} ${e.summary}`)
  // Oct 19 and Oct 26 stay at 09:00 Dublin (IST until the clocks change on Oct 25).
  expect(starts.slice(0, 2)).toEqual(["2026-10-19T08:00:00Z Standup", "2026-10-26T09:00:00Z Standup"])
  // From Nov 2 the wall clock is 10:00 Dublin (GMT = 10:00Z), including after the clocks changed.
  expect(starts.slice(2)).toEqual([
    "2026-11-02T10:00:00Z Standup (later)",
    "2026-11-09T10:00:00Z Standup (later)",
    "2026-11-16T10:00:00Z Standup (later)",
    "2026-11-23T10:00:00Z Standup (later)",
  ])
})

test("YEARLY rules apply BYSETPOS to the whole year and expand BYMONTHDAY across every month", () => {
  const setPos = expandRRuleOccurrences({
    dtstart: "2026-01-05",
    allDay: true,
    rrule: "FREQ=YEARLY;BYMONTH=1,2;BYDAY=MO;BYSETPOS=1;COUNT=2",
    timezone: "UTC",
    windowStart: new Date("2026-01-01T00:00:00Z"),
    windowEnd: new Date("2028-12-31T00:00:00Z"),
  })
  expect(setPos.map((o) => o.start)).toEqual(["2026-01-05", "2027-01-04"])

  const monthDay = expandRRuleOccurrences({
    dtstart: "2026-01-15",
    allDay: true,
    rrule: "FREQ=YEARLY;BYMONTHDAY=15",
    timezone: "UTC",
    windowStart: new Date("2026-02-01T00:00:00Z"),
    windowEnd: new Date("2026-03-31T00:00:00Z"),
  })
  expect(monthDay.map((o) => o.start)).toEqual(["2026-02-15", "2026-03-15"])
})

test("rules with unmodeled parts import only the first occurrence, and long-running series still expand in the current window", () => {
  const byHour = expandRRuleOccurrences({
    dtstart: "2026-11-15T09:00:00Z",
    rrule: "FREQ=DAILY;BYHOUR=9,17;COUNT=4",
    timezone: "UTC",
    windowStart: new Date("2026-11-01T00:00:00Z"),
    windowEnd: new Date("2026-12-31T00:00:00Z"),
  })
  expect(byHour.map((o) => o.start)).toEqual(["2026-11-15T09:00:00Z"])

  const daily = expandRRuleOccurrences({
    dtstart: "1990-01-01",
    allDay: true,
    rrule: "FREQ=DAILY",
    timezone: "UTC",
    windowStart: new Date("2026-11-10T00:00:00Z"),
    windowEnd: new Date("2026-11-12T00:00:00Z"),
  })
  expect(daily.map((o) => o.start)).toEqual(["2026-11-10", "2026-11-11", "2026-11-12"])

  const weekly = expandRRuleOccurrences({
    dtstart: "1990-01-03",
    allDay: true,
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
    timezone: "UTC",
    windowStart: new Date("2026-11-01T00:00:00Z"),
    windowEnd: new Date("2026-11-30T00:00:00Z"),
  })
  // 1990-01-03 plus whole two-week steps lands on 2026-11-04 and 2026-11-18 (a Wednesday each).
  expect(weekly.map((o) => o.start)).toEqual(["2026-11-04", "2026-11-18"])
})
