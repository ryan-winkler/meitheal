import assert from "node:assert/strict"
import test from "node:test"
import {
  buildYearMonths,
  parseCalendarViewMode,
  resolveCalendarViewState,
} from "./calendar-view-range"

test("parseCalendarViewMode normalizes valid modes and defaults to month", () => {
  assert.equal(parseCalendarViewMode("day"), "day")
  assert.equal(parseCalendarViewMode("WEEK"), "week")
  assert.equal(parseCalendarViewMode("Month"), "month")
  assert.equal(parseCalendarViewMode("year"), "year")
  assert.equal(parseCalendarViewMode("invalid"), "month")
  assert.equal(parseCalendarViewMode(null), "month")
})

test("resolveCalendarViewState computes month boundaries and cross-year prev/next", () => {
  const jan = resolveCalendarViewState({
    viewParam: "month",
    yearParam: "2026",
    monthParam: "0",
    todayStr: "2026-01-15",
    weekStart: "monday",
  })
  assert.equal(jan.view, "month")
  assert.equal(jan.rangeStart, "2026-01-01")
  assert.equal(jan.rangeEnd, "2026-01-31")
  assert.equal(jan.prev.year, 2025)
  assert.equal(jan.prev.month, 11)
  assert.equal(jan.next.year, 2026)
  assert.equal(jan.next.month, 1)
  assert.deepEqual(jan.weekLabels, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"])
})

test("resolveCalendarViewState computes week ranges respecting monday and sunday weekStart", () => {
  // 2026-10-07 is a Wednesday
  const monWeek = resolveCalendarViewState({
    viewParam: "week",
    dateParam: "2026-10-07",
    todayStr: "2026-10-07",
    weekStart: "monday",
  })
  assert.equal(monWeek.rangeStart, "2026-10-05")
  assert.equal(monWeek.rangeEnd, "2026-10-11")
  assert.equal(monWeek.weekDays.length, 7)
  assert.equal(monWeek.weekDays[2]?.isToday, true)
  assert.equal(monWeek.prev.date, "2026-09-28")
  assert.equal(monWeek.next.date, "2026-10-12")

  const sunWeek = resolveCalendarViewState({
    viewParam: "week",
    dateParam: "2026-10-07",
    todayStr: "2026-10-07",
    weekStart: "sunday",
  })
  assert.equal(sunWeek.rangeStart, "2026-10-04")
  assert.equal(sunWeek.rangeEnd, "2026-10-10")
  assert.equal(sunWeek.weekDays[0]?.isWeekend, true)
  assert.equal(sunWeek.weekDays[6]?.isWeekend, true)
})

test("resolveCalendarViewState handles day stepping across leap year February", () => {
  const leap = resolveCalendarViewState({
    viewParam: "day",
    dateParam: "2028-02-29",
    todayStr: "2028-02-28",
  })
  assert.equal(leap.rangeStart, "2028-02-29")
  assert.equal(leap.rangeEnd, "2028-02-29")
  assert.equal(leap.prev.date, "2028-02-28")
  assert.equal(leap.next.date, "2028-03-01")
  assert.equal(leap.next.month, 2)
})

test("resolveCalendarViewState and buildYearMonths produce 12 accurate months for year view", () => {
  const yearState = resolveCalendarViewState({
    viewParam: "year",
    yearParam: "2026",
    todayStr: "2026-06-12",
    weekStart: "monday",
  })
  assert.equal(yearState.rangeStart, "2026-01-01")
  assert.equal(yearState.rangeEnd, "2026-12-31")
  assert.equal(yearState.heading, "2026")
  assert.equal(yearState.prev.year, 2025)
  assert.equal(yearState.next.year, 2027)

  const months = buildYearMonths(2026, "2026-06-12", "monday")
  assert.equal(months.length, 12)
  assert.equal(months[1]?.cells.filter(c => c.isCurrentMonth).length, 28)
  const juneToday = months[5]?.cells.find(c => c.isToday)
  assert.equal(juneToday?.dateStr, "2026-06-12")
})
