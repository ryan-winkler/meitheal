import test from "node:test"
import assert from "node:assert/strict"
import {
  applyTimeToRRule,
  buildGoogleRecurrencePresets,
  cadenceToRRule,
  describeRule,
  extractTimeFromRRule,
  formatRecurrenceTime,
  getNextOccurrence,
  isValidRoutineCadence,
  parseRRule,
  toRRuleString,
} from "./recurrence"
import {
  isRoutineActiveForPeriod,
  routinePeriod,
  routineStreakDayStep,
} from "./routine-period"
import { buildTimezoneOptions, formatGmtOffset } from "../../lib/timezone-options"
import { parseWorkspacePreferences } from "../../lib/workspace-preferences"

test("buildGoogleRecurrencePresets matches Google Calendar labels for anchor date", () => {
  // 2026-11-23 is the fourth Monday of November
  const presets = buildGoogleRecurrencePresets("2026-11-23")
  assert.deepEqual(presets, [
    { value: "FREQ=DAILY", label: "Daily" },
    { value: "FREQ=WEEKLY;BYDAY=MO", label: "Weekly on Monday" },
    { value: "FREQ=MONTHLY;BYDAY=4MO", label: "Monthly on the fourth Monday" },
    { value: "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=23", label: "Annually on November 23" },
    { value: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", label: "Every weekday (Monday to Friday)" },
  ])
})

test("parseRRule + toRRuleString round-trips ordinal BYDAY, BYMONTH, COUNT, and UNTIL", () => {
  const r1 = parseRRule("FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO;COUNT=13")
  assert.ok(r1)
  assert.equal(r1.freq, "MONTHLY")
  assert.equal(r1.interval, 2)
  assert.deepEqual(r1.byDayEntries, [{ ordinal: 4, day: "MO" }])
  assert.equal(r1.count, 13)
  assert.equal(toRRuleString(r1), "FREQ=MONTHLY;INTERVAL=2;BYDAY=4MO;COUNT=13")
  assert.equal(describeRule(r1), "Every 2 months on the fourth Monday, 13 times")

  const r2 = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20270222")
  assert.ok(r2)
  assert.equal(r2.until, "2027-02-22")
  assert.equal(toRRuleString(r2), "FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20270222")
  assert.equal(describeRule(r2), "Weekly on Monday, Wednesday, Friday, until 2027-02-22")
})

test("recurrence time support (BYHOUR/BYMINUTE) handles Gym at 6 am every M W F", () => {
  assert.equal(formatRecurrenceTime(6, 0), "6:00 AM")
  assert.equal(formatRecurrenceTime(0, 15), "12:15 AM")
  assert.equal(formatRecurrenceTime(12, 0), "12:00 PM")
  assert.equal(formatRecurrenceTime(18, 45), "6:45 PM")

  const withTime = applyTimeToRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR", "06:00")
  assert.equal(withTime, "FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=6;BYMINUTE=0")
  assert.equal(extractTimeFromRRule(withTime), "06:00")
  assert.equal(describeRule(withTime), "Weekly on Monday, Wednesday, Friday at 6:00 AM")
  assert.equal(isValidRoutineCadence(withTime), true)

  const parsed = parseRRule(withTime)!
  const next = getNextOccurrence(parsed, new Date("2026-11-23T12:00:00Z")) // Monday -> Wednesday
  assert.ok(next)
  assert.equal(next.toISOString(), "2026-11-25T06:00:00.000Z")

  assert.equal(routinePeriod(withTime, new Date("2026-11-23T12:00:00Z"), "UTC"), "2026-11-23T06:00")
  assert.equal(isRoutineActiveForPeriod(`${withTime};UNTIL=20261123`, "2026-11-23T06:00", 0), true)
  assert.equal(isRoutineActiveForPeriod(`${withTime};UNTIL=20261120`, "2026-11-23T06:00", 0), false)

  // Clearing time strips BYHOUR/BYMINUTE
  assert.equal(applyTimeToRRule(withTime, ""), "FREQ=WEEKLY;BYDAY=MO,WE,FR")
})

test("getNextOccurrence handles monthly ordinal weekday and end boundaries", () => {
  const rule = parseRRule("FREQ=MONTHLY;BYDAY=4MO")!
  // From 2026-11-23 (4th Monday of Nov 2026) -> 4th Monday of Dec 2026 is 2026-12-28
  const next = getNextOccurrence(rule, new Date("2026-11-23T12:00:00Z"))
  assert.ok(next)
  assert.equal(next.toISOString().slice(0, 10), "2026-12-28")

  // COUNT exhaustion returns null
  const limited = parseRRule("FREQ=DAILY;COUNT=3")!
  assert.equal(getNextOccurrence(limited, new Date("2026-11-23T12:00:00Z"), 3), null)

  // UNTIL past boundary returns null
  const bounded = parseRRule("FREQ=DAILY;UNTIL=20261123")!
  assert.equal(getNextOccurrence(bounded, new Date("2026-11-23T12:00:00Z"), 0), null)
})

test("cadence validation and routine period computation support legacy and RRULE cadences", () => {
  assert.equal(isValidRoutineCadence("daily"), true)
  assert.equal(isValidRoutineCadence("weekly"), true)
  assert.equal(isValidRoutineCadence("FREQ=MONTHLY;BYDAY=-1FR"), true)
  assert.equal(isValidRoutineCadence("FREQ=INVALID"), false)
  assert.equal(cadenceToRRule("weekdays"), "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")

  const monday = new Date("2026-11-23T12:00:00Z")
  assert.equal(routinePeriod("daily", monday, "UTC"), "2026-11-23")
  assert.equal(routinePeriod("weekly", monday, "UTC"), "2026-11-23")
  assert.equal(routinePeriod("FREQ=MONTHLY;BYMONTHDAY=23", monday, "UTC"), "2026-11-23")
  assert.equal(routinePeriod("FREQ=MONTHLY;BYDAY=4MO", monday, "UTC"), "2026-11-23")
  assert.equal(routinePeriod("FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=23", monday, "UTC"), "2026-11-23")
  // Weekdays routine evaluated on Sunday (2026-11-22) resolves to Friday (2026-11-20)
  assert.equal(routinePeriod("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", new Date("2026-11-22T12:00:00Z"), "UTC"), "2026-11-20")

  assert.equal(routineStreakDayStep("daily"), 1)
  assert.equal(routineStreakDayStep("FREQ=WEEKLY;INTERVAL=2"), 14)

  assert.equal(isRoutineActiveForPeriod("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-11-23", 0), true)
  assert.equal(isRoutineActiveForPeriod("FREQ=DAILY;COUNT=5", "2026-11-23", 5), false)
  assert.equal(isRoutineActiveForPeriod("FREQ=DAILY;UNTIL=20261120", "2026-11-23", 0), false)
})

test("buildTimezoneOptions formats live GMT offsets and friendly labels", () => {
  const ref = new Date("2026-01-15T12:00:00Z")
  assert.equal(formatGmtOffset(0), "GMT+00:00")
  assert.equal(formatGmtOffset(-300), "GMT-05:00")
  assert.equal(formatGmtOffset(330), "GMT+05:30")

  const options = buildTimezoneOptions("en", ref)
  assert.ok(options.length > 50)
  const dublin = options.find((opt) => opt.value === "Europe/Dublin")
  assert.ok(dublin)
  assert.equal(dublin.offsetLabel, "GMT+00:00")
  assert.match(dublin.label, /^\(GMT\+00:00\) Dublin, Ireland/)
  const ny = options.find((opt) => opt.value === "America/New_York")
  assert.ok(ny)
  assert.equal(ny.offsetLabel, "GMT-05:00")
  // Sorted ascending by offsetMinutes
  for (let i = 1; i < options.length; i++) {
    assert.ok(options[i]!.offsetMinutes >= options[i - 1]!.offsetMinutes)
  }
})

test("parseWorkspacePreferences validates afterTaskCreate preference", () => {
  assert.deepEqual(
    parseWorkspacePreferences(JSON.stringify({ capture: "form", afterTaskCreate: "open" })),
    { capture: "form", afterTaskCreate: "open" },
  )
  assert.deepEqual(
    parseWorkspacePreferences(JSON.stringify({ afterTaskCreate: "board" })),
    { afterTaskCreate: "board" },
  )
  assert.deepEqual(
    parseWorkspacePreferences(JSON.stringify({ afterTaskCreate: "invalid_mode" })),
    {},
  )
})
