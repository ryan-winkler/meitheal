import test from "node:test"
import assert from "node:assert/strict"
import {
  buildCalendarMonthCells,
  formatIsoDateLocal,
  formatIsoDateTimeLocal,
  formatQuickDateSublabel,
  formatTablerDateDisplay,
  formatTimeHHMM,
  getWeekdayShortLabels,
  hasNonMidnightTime,
  parseFlexibleDateInput,
  parseIsoDateLocal,
} from "./date-time-parser"

test("parseIsoDateLocal parses valid YYYY-MM-DD strings without timezone drift", () => {
  const date = parseIsoDateLocal("2026-11-24")
  assert.ok(date)
  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 10)
  assert.equal(date.getDate(), 24)
  assert.equal(formatIsoDateLocal(date), "2026-11-24")
})

test("parseIsoDateLocal parses YYYY-MM-DDTHH:mm preserving local time", () => {
  const date = parseIsoDateLocal("2026-11-24T14:35")
  assert.ok(date)
  assert.equal(formatIsoDateLocal(date), "2026-11-24")
  assert.equal(formatTimeHHMM(date), "14:35")
  assert.equal(formatIsoDateTimeLocal(date), "2026-11-24T14:35")
  assert.equal(hasNonMidnightTime(date), true)
})

test("parseIsoDateLocal rejects invalid calendar dates and empty strings", () => {
  assert.equal(parseIsoDateLocal(""), null)
  assert.equal(parseIsoDateLocal(null), null)
  assert.equal(parseIsoDateLocal("2026-02-30"), null)
  assert.equal(parseIsoDateLocal("not-a-date"), null)
})

test("parseFlexibleDateInput parses typed ISO, natural, slash, and relative dates with optional times", () => {
  const ref = new Date(2026, 10, 24, 10, 0, 0, 0) // 24 Nov 2026
  const opts = { enableTime: true, now: ref }

  const iso = parseFlexibleDateInput("2026-12-05 16:45", opts)
  assert.ok(iso)
  assert.equal(formatIsoDateTimeLocal(iso.date), "2026-12-05T16:45")
  assert.equal(iso.hasTime, true)

  const isoDateOnly = parseFlexibleDateInput("2026-12-05 16:45", { enableTime: false, now: ref })
  assert.ok(isoDateOnly)
  assert.equal(formatIsoDateTimeLocal(isoDateOnly.date), "2026-12-05T00:00")
  assert.equal(isoDateOnly.hasTime, false)

  const natural = parseFlexibleDateInput("24 Nov 2026 2:30pm", opts)
  assert.ok(natural)
  assert.equal(formatIsoDateTimeLocal(natural.date), "2026-11-24T14:30")
  assert.equal(natural.hasTime, true)

  const slashEu = parseFlexibleDateInput("05/12/2026", { ...opts, dateFormat: "absolute-eu" })
  assert.ok(slashEu)
  assert.equal(formatIsoDateLocal(slashEu.date), "2026-12-05")

  const slashUs = parseFlexibleDateInput("05/12/2026, 3:15 PM", { ...opts, dateFormat: "absolute-us" })
  assert.ok(slashUs)
  assert.equal(formatIsoDateTimeLocal(slashUs.date), "2026-05-12T15:15")
  assert.equal(slashUs.hasTime, true)

  const relative = parseFlexibleDateInput("tomorrow 9am", opts)
  assert.ok(relative)
  assert.equal(formatIsoDateTimeLocal(relative.date), "2026-11-25T09:00")
  assert.equal(relative.hasTime, true)

  assert.equal(parseFlexibleDateInput("2026-02-30", opts), null)
  assert.equal(parseFlexibleDateInput("not a real date", opts), null)
})

test("formatTablerDateDisplay conforms to all Settings date_format options", () => {
  const date = parseIsoDateLocal("2026-03-09")
  const timed = parseIsoDateLocal("2026-03-09T15:45")
  assert.ok(date && timed)

  assert.equal(formatTablerDateDisplay(date, false, "absolute-iso"), "2026-03-09")
  assert.equal(formatTablerDateDisplay(timed, true, "absolute-iso"), "2026-03-09 15:45")

  assert.equal(formatTablerDateDisplay(date, false, "absolute-eu"), "09/03/2026")
  assert.equal(formatTablerDateDisplay(timed, true, "absolute-eu"), "09/03/2026, 15:45")

  assert.equal(formatTablerDateDisplay(date, false, "absolute-us"), "03/09/2026")
  assert.equal(formatTablerDateDisplay(timed, true, "absolute-us"), "03/09/2026, 3:45 PM")

  const relLabel = formatTablerDateDisplay(timed, true, "relative")
  assert.match(relLabel, /9/)
  assert.match(relLabel, /Mar/)
  assert.match(relLabel, /2026/)
  assert.match(relLabel, /15:45/)

  assert.equal(formatQuickDateSublabel(date, "absolute-iso"), "2026-03-09")
  assert.equal(formatQuickDateSublabel(date, "absolute-eu"), "09/03")
  assert.equal(formatQuickDateSublabel(date, "absolute-us"), "03/09")
})

test("buildCalendarMonthCells always returns exactly 42 cells (6 fixed rows) across all months and week starts", () => {
  // Check 4-week Feb (Feb 2027 starts on Monday), leap Feb 2028, 30-day April 2029, 31-day Aug 2026
  const months: Array<[number, number]> = [
    [2027, 1],
    [2028, 1],
    [2029, 3],
    [2026, 7],
    [2026, 10],
  ]
  for (const weekStart of ["monday", "sunday", "saturday"] as const) {
    const labels = getWeekdayShortLabels(weekStart)
    assert.equal(labels.length, 7)
    for (const [year, month] of months) {
      const cells = buildCalendarMonthCells(year, month, weekStart)
      assert.equal(cells.length, 42, `Expected 42 cells for ${year}-${month + 1} (${weekStart})`)
      const inMonth = cells.filter((c) => !c.isOutside)
      const expectedDays = new Date(year, month + 1, 0).getDate()
      assert.equal(inMonth.length, expectedDays)
    }
  }
  assert.deepEqual(getWeekdayShortLabels("sunday"), ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"])
  assert.deepEqual(getWeekdayShortLabels("monday"), ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"])
  assert.deepEqual(getWeekdayShortLabels("saturday"), ["Sa", "Su", "Mo", "Tu", "We", "Th", "Fr"])
})
