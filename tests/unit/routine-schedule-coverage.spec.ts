import { expect, test } from "@playwright/test"
import {
  applyTimeToRRule,
  buildGoogleRecurrencePresets,
  cadenceToRRule,
  describeRule,
  extractTimeFromRRule,
  getNextOccurrence,
  isValidRoutineCadence,
  parseRRule,
} from "../../apps/web/src/domains/tasks/recurrence"
import {
  isRoutineActiveForPeriod,
  routinePeriod,
  routineStreakDayStep,
} from "../../apps/web/src/domains/tasks/routine-period"

test("stored cadence names still resolve when households reopen older routines", () => {
  const legacy = {
    daily: "FREQ=DAILY",
    weekly: "FREQ=WEEKLY",
    weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    monthly: "FREQ=MONTHLY",
    yearly: "FREQ=YEARLY",
    annually: "FREQ=YEARLY",
  }
  for (const [name, rule] of Object.entries(legacy)) {
    expect(cadenceToRRule(` ${name.toUpperCase()} `)).toBe(rule)
    expect(isValidRoutineCadence(name)).toBe(true)
  }
  expect(isValidRoutineCadence(null)).toBe(false)
  expect(isValidRoutineCadence("FREQ=DAILY;" + "X=".padEnd(200, "A"))).toBe(false)
  expect(cadenceToRRule("after bin collection")).toBeNull()
  expect(describeRule("after bin collection")).toBe("after bin collection")
  expect(describeRule("weekdays")).toBe("Every weekday (Monday to Friday)")
})

test("editing a saved routine time preserves weekdays, interval, and end settings", () => {
  const saved = " rrULE:freq=weekly;interval=2;byday=mo,fr;byhour=6;count=3;until=20261019T235959Z "
  const timed = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;BYHOUR=12;BYMINUTE=5;COUNT=3;UNTIL=20261019"
  const untimed = "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=3;UNTIL=20261019"

  expect(extractTimeFromRRule(saved)).toBe("06:00")
  expect(extractTimeFromRRule("weekly")).toBe("")
  expect(extractTimeFromRRule(null)).toBe("")
  expect(applyTimeToRRule(saved, " 12:05 ")).toBe(timed)
  expect(applyTimeToRRule(timed, "24:00")).toBe(timed)
  expect(applyTimeToRRule(timed, "")).toBe(untimed)
  expect(applyTimeToRRule("after bin collection", "08:00")).toBe("after bin collection")
  expect(describeRule(timed)).toBe("Every 2 weeks on Monday, Friday at 12:05 PM, 3 times, until 2026-10-19")
})

test("monthly and yearly task recurrence keeps ordinal, end-of-month, and leap-day intent", () => {
  const lastMonday = parseRRule("FREQ=MONTHLY;BYDAY=-1MO;BYHOUR=0;BYMINUTE=25;UNTIL=20260427")!
  const april = getNextOccurrence(lastMonday, new Date("2026-03-30T00:25:00Z"))!
  expect(april.toISOString()).toBe("2026-04-27T00:25:00.000Z")
  expect(getNextOccurrence(lastMonday, april)).toBeNull()
  expect(describeRule(lastMonday)).toBe("Monthly on the last Monday at 12:25 AM, until 2026-04-27")
  expect(describeRule("FREQ=MONTHLY;INTERVAL=2;BYDAY=2TU")).toBe("Every 2 months on the second Tuesday")

  const lastDay = parseRRule("FREQ=MONTHLY;BYMONTHDAY=-1,-1,0,32")!
  expect(lastDay.byMonthDay).toEqual([-1])
  expect(getNextOccurrence(lastDay, new Date("2026-01-31T18:45:00Z"))?.toISOString()).toBe("2026-02-28T18:45:00.000Z")
  expect(describeRule("FREQ=MONTHLY;BYMONTHDAY=15")).toBe("Monthly on day 15")
  expect(describeRule("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15")).toBe("Every 3 months on day 15")

  const leapDay = "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"
  const imported = "RRULE:FREQ=YEARLY;BYMONTH=02,2,13;BYMONTHDAY=29,29,0,32"
  expect(cadenceToRRule(imported)).toBe(leapDay)
  expect(getNextOccurrence(parseRRule(leapDay)!, new Date("2028-02-29T06:00:00Z"))?.toISOString()).toBe("2029-02-28T06:00:00.000Z")
  expect(describeRule(leapDay)).toBe("Annually on February 29")
  expect(describeRule("FREQ=YEARLY;INTERVAL=4;BYMONTH=2;BYMONTHDAY=29")).toBe("Every 4 years on February 29")
})

test("calendar presets use the selected date and store fifth weekdays as the last weekday", () => {
  expect(buildGoogleRecurrencePresets("2026-03-30")).toEqual([
    { value: "FREQ=DAILY", label: "Daily" },
    { value: "FREQ=WEEKLY;BYDAY=MO", label: "Weekly on Monday" },
    { value: "FREQ=MONTHLY;BYDAY=-1MO", label: "Monthly on the last Monday" },
    { value: "FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=30", label: "Annually on March 30" },
    { value: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", label: "Every weekday (Monday to Friday)" },
  ])
  expect(buildGoogleRecurrencePresets(new Date("2026-02-10T12:00:00Z"))[2]).toEqual({
    value: "FREQ=MONTHLY;BYDAY=2TU", label: "Monthly on the second Tuesday",
  })
})

test("routine periods cross household midnight after daylight-saving time starts", () => {
  const zone = "America/Chicago"
  const sunday = new Date("2026-03-09T04:30:00Z")
  const monday = new Date("2026-03-09T05:30:00Z")
  expect(routinePeriod("daily", sunday, zone)).toBe("2026-03-08")
  expect(routinePeriod("FREQ=DAILY;BYHOUR=7;BYMINUTE=15", monday, zone)).toBe("2026-03-09T07:15")
  expect(routinePeriod("weekly", sunday, zone)).toBe("2026-03-02")
  expect(routinePeriod("FREQ=WEEKLY;INTERVAL=2", monday, zone)).toBe("2026-03-09")
  expect(routinePeriod("weekdays", sunday, zone)).toBe("2026-03-06")
  expect(routinePeriod("weekdays", monday, zone)).toBe("2026-03-09")
})

test("routine periods keep stable monthly and yearly keys through short months", () => {
  const commonFebruary = new Date("2026-02-20T14:00:00Z")
  const leapFebruary = new Date("2028-02-20T14:00:00Z")
  expect(routinePeriod("monthly", commonFebruary)).toBe("2026-02-01")
  expect(routinePeriod("FREQ=MONTHLY;BYMONTHDAY=31", commonFebruary)).toBe("2026-02-28")
  expect(routinePeriod("FREQ=MONTHLY;BYMONTHDAY=-1", leapFebruary)).toBe("2028-02-29")
  expect(routinePeriod("FREQ=MONTHLY;BYDAY=2TU", commonFebruary)).toBe("2026-02-10")
  expect(routinePeriod("FREQ=MONTHLY;BYDAY=-1FR;BYHOUR=18;BYMINUTE=30", commonFebruary)).toBe("2026-02-27T18:30")
  expect(routinePeriod("annually", commonFebruary)).toBe("2026-01-01")
  expect(routinePeriod("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", commonFebruary)).toBe("2026-02-28")
  expect(routinePeriod("FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1", leapFebruary)).toBe("2028-02-29")
})

test("routine eligibility and streaks respect stored end boundaries and frequency", () => {
  const cadence = "FREQ=WEEKLY;BYDAY=FR;BYHOUR=22;COUNT=3;UNTIL=20260227"
  expect(isRoutineActiveForPeriod(cadence, "2026-02-27T22:00", 2)).toBe(true)
  expect(isRoutineActiveForPeriod(cadence, "2026-02-28T00:00", 2)).toBe(false)
  expect(isRoutineActiveForPeriod(cadence, "2026-02-27T22:00", 3)).toBe(false)
  expect(isRoutineActiveForPeriod("daily", "2026-02-27")).toBe(true)
  expect(routineStreakDayStep("weekly")).toBe(7)
  expect(routineStreakDayStep("weekdays")).toBe(1)
  expect(routineStreakDayStep("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR")).toBe(14)
  expect(routineStreakDayStep("FREQ=DAILY;INTERVAL=2")).toBe(2)
  expect(routineStreakDayStep("FREQ=MONTHLY;INTERVAL=2")).toBe(60)
  expect(routineStreakDayStep("FREQ=YEARLY;INTERVAL=2")).toBe(730)
})
