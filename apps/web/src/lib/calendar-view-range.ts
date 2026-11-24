/**
 * Pure date-range, navigation, and grid math for Calendar Day / Week / Month / Year views.
 * Decoupled from DOM and database for deterministic unit testing and SSR reuse.
 * @domain tasks/calendar
 */
import { shiftCalendarDay } from "./date"

export type CalendarViewMode = "day" | "week" | "month" | "year"
export type CalendarWeekStart = "sunday" | "monday" | "saturday"

export interface CalendarNavTarget {
  view: CalendarViewMode
  year: number
  month: number // 0-indexed
  date: string // YYYY-MM-DD
}

export interface CalendarWeekDay {
  dateStr: string
  day: number
  month: number // 0-indexed
  year: number
  weekdayShort: string
  monthShort: string
  isToday: boolean
  isWeekend: boolean
}

export interface CalendarYearMonthCell {
  day: number
  dateStr: string
  isCurrentMonth: boolean
  isToday: boolean
  isWeekend: boolean
}

export interface CalendarYearMonth {
  year: number
  month: number // 0-indexed
  label: string
  shortLabel: string
  cells: CalendarYearMonthCell[]
}

export interface CalendarViewState {
  view: CalendarViewMode
  anchorDate: string // YYYY-MM-DD
  year: number
  month: number // 0-indexed
  day: number
  rangeStart: string // YYYY-MM-DD inclusive
  rangeEnd: string // YYYY-MM-DD inclusive
  heading: string
  shortHeading: string
  weekLabels: string[]
  weekDays: CalendarWeekDay[]
  prev: CalendarNavTarget
  next: CalendarNavTarget
  today: CalendarNavTarget
}

const VALID_VIEWS = new Set<CalendarViewMode>(["day", "week", "month", "year"])
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const LONG_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export function parseCalendarViewMode(raw: string | null | undefined): CalendarViewMode {
  const normalized = (raw ?? "").trim().toLowerCase() as CalendarViewMode
  return VALID_VIEWS.has(normalized) ? normalized : "month"
}

export function normalizeWeekStart(raw: string | null | undefined): CalendarWeekStart {
  if (raw === "sunday" || raw === "saturday" || raw === "monday") return raw
  return "monday"
}

export function isValidIsoDate(value: string | null | undefined): value is string {
  if (!value) return false
  const match = DATE_RE.exec(value.trim())
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 100 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

export function formatIsoDate(year: number, monthIndex: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

export function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

export function weekStartIndex(weekStart: CalendarWeekStart): number {
  if (weekStart === "monday") return 1
  if (weekStart === "saturday") return 6
  return 0
}

export function weekDayLabels(weekStart: CalendarWeekStart): string[] {
  const start = weekStartIndex(weekStart)
  return Array.from({ length: 7 }, (_, i) => SHORT_WEEKDAYS[(start + i) % 7]!)
}

export function isColumnWeekend(columnIndex: number, weekStart: CalendarWeekStart): boolean {
  const dow = (weekStartIndex(weekStart) + columnIndex) % 7
  return dow === 0 || dow === 6
}

export function startOfCalendarWeek(dateStr: string, weekStart: CalendarWeekStart): string {
  const [y, m, d] = dateStr.split("-").map(Number)
  const utc = new Date(Date.UTC(y!, m! - 1, d!))
  const dow = utc.getUTCDay()
  const start = weekStartIndex(weekStart)
  const diff = (dow - start + 7) % 7
  return shiftCalendarDay(dateStr, -diff)
}

function clampYear(raw: string | null | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 9999 ? parsed : fallback
}

function clampMonth(raw: string | null | undefined, fallback: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 11 ? parsed : fallback
}

export function resolveCalendarViewState(input: {
  viewParam?: string | null
  dateParam?: string | null
  yearParam?: string | null
  monthParam?: string | null
  todayStr: string
  weekStart?: string | null
}): CalendarViewState {
  const view = parseCalendarViewMode(input.viewParam)
  const weekStart = normalizeWeekStart(input.weekStart)
  const safeToday = isValidIsoDate(input.todayStr) ? input.todayStr : "2026-01-01"
  const [todayY, todayM, todayD] = safeToday.split("-").map(Number) as [number, number, number]

  let year = todayY
  let month = todayM - 1
  let day = todayD

  if (isValidIsoDate(input.dateParam)) {
    const [py, pm, pd] = input.dateParam.split("-").map(Number) as [number, number, number]
    year = py
    month = pm - 1
    day = pd
  } else if (input.yearParam || input.monthParam) {
    year = clampYear(input.yearParam, todayY)
    month = clampMonth(input.monthParam, todayM - 1)
    const maxDay = daysInUtcMonth(year, month)
    day = year === todayY && month === todayM - 1 ? Math.min(todayD, maxDay) : 1
  }

  const anchorDate = formatIsoDate(year, month, day)
  const labels = weekDayLabels(weekStart)
  const weekStartDate = startOfCalendarWeek(anchorDate, weekStart)
  const weekDays: CalendarWeekDay[] = Array.from({ length: 7 }, (_, i) => {
    const dateStr = shiftCalendarDay(weekStartDate, i)
    const [wy, wm, wd] = dateStr.split("-").map(Number) as [number, number, number]
    const dow = new Date(Date.UTC(wy, wm - 1, wd)).getUTCDay()
    return {
      dateStr,
      day: wd,
      month: wm - 1,
      year: wy,
      weekdayShort: SHORT_WEEKDAYS[dow]!,
      monthShort: SHORT_MONTHS[wm - 1]!,
      isToday: dateStr === safeToday,
      isWeekend: dow === 0 || dow === 6,
    }
  })

  const todayTarget: CalendarNavTarget = {
    view,
    year: todayY,
    month: todayM - 1,
    date: safeToday,
  }

  if (view === "day") {
    const prevDate = shiftCalendarDay(anchorDate, -1)
    const nextDate = shiftCalendarDay(anchorDate, 1)
    const [py, pm] = prevDate.split("-").map(Number) as [number, number]
    const [ny, nm] = nextDate.split("-").map(Number) as [number, number]
    const heading = new Date(`${anchorDate}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    })
    const shortHeading = new Date(`${anchorDate}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
    return {
      view,
      anchorDate,
      year,
      month,
      day,
      rangeStart: anchorDate,
      rangeEnd: anchorDate,
      heading,
      shortHeading,
      weekLabels: labels,
      weekDays,
      prev: { view, year: py, month: pm - 1, date: prevDate },
      next: { view, year: ny, month: nm - 1, date: nextDate },
      today: todayTarget,
    }
  }

  if (view === "week") {
    const first = weekDays[0]!
    const last = weekDays[6]!
    const prevDate = shiftCalendarDay(weekStartDate, -7)
    const nextDate = shiftCalendarDay(weekStartDate, 7)
    const [py, pm] = prevDate.split("-").map(Number) as [number, number]
    const [ny, nm] = nextDate.split("-").map(Number) as [number, number]
    let heading: string
    if (first.year !== last.year) {
      heading = `${first.monthShort} ${first.day}, ${first.year} – ${last.monthShort} ${last.day}, ${last.year}`
    } else if (first.month !== last.month) {
      heading = `${first.monthShort} ${first.day} – ${last.monthShort} ${last.day}, ${last.year}`
    } else {
      heading = `${LONG_MONTHS[first.month]} ${first.day}–${last.day}, ${first.year}`
    }
    return {
      view,
      anchorDate,
      year,
      month,
      day,
      rangeStart: first.dateStr,
      rangeEnd: last.dateStr,
      heading,
      shortHeading: `${first.monthShort} ${first.day}–${last.day}`,
      weekLabels: labels,
      weekDays,
      prev: { view, year: py, month: pm - 1, date: prevDate },
      next: { view, year: ny, month: nm - 1, date: nextDate },
      today: todayTarget,
    }
  }

  if (view === "year") {
    const prevYear = Math.max(100, year - 1)
    const nextYear = Math.min(9999, year + 1)
    return {
      view,
      anchorDate,
      year,
      month,
      day,
      rangeStart: formatIsoDate(year, 0, 1),
      rangeEnd: formatIsoDate(year, 11, 31),
      heading: String(year),
      shortHeading: String(year),
      weekLabels: labels,
      weekDays,
      prev: { view, year: prevYear, month: 0, date: formatIsoDate(prevYear, 0, 1) },
      next: { view, year: nextYear, month: 0, date: formatIsoDate(nextYear, 0, 1) },
      today: todayTarget,
    }
  }

  // Default: month
  const maxDay = daysInUtcMonth(year, month)
  const prevMonth = month === 0 ? 11 : month - 1
  const prevYear = month === 0 ? Math.max(100, year - 1) : year
  const nextMonth = month === 11 ? 0 : month + 1
  const nextYear = month === 11 ? Math.min(9999, year + 1) : year
  const heading = `${LONG_MONTHS[month]} ${year}`
  return {
    view: "month",
    anchorDate,
    year,
    month,
    day,
    rangeStart: formatIsoDate(year, month, 1),
    rangeEnd: formatIsoDate(year, month, maxDay),
    heading,
    shortHeading: `${SHORT_MONTHS[month]} ${year}`,
    weekLabels: labels,
    weekDays,
    prev: { view: "month", year: prevYear, month: prevMonth, date: formatIsoDate(prevYear, prevMonth, 1) },
    next: { view: "month", year: nextYear, month: nextMonth, date: formatIsoDate(nextYear, nextMonth, 1) },
    today: todayTarget,
  }
}

export function buildYearMonths(
  year: number,
  todayStr: string,
  weekStartRaw?: string | null,
): CalendarYearMonth[] {
  const weekStart = normalizeWeekStart(weekStartRaw)
  const startOffset = weekStartIndex(weekStart)
  const months: CalendarYearMonth[] = []

  for (let m = 0; m < 12; m++) {
    const firstDow = new Date(Date.UTC(year, m, 1)).getUTCDay()
    const leadingBlanks = (firstDow - startOffset + 7) % 7
    const totalDays = daysInUtcMonth(year, m)
    const cells: CalendarYearMonthCell[] = []
    let cursor = 1 - leadingBlanks

    for (let week = 0; week < 6; week++) {
      const row: CalendarYearMonthCell[] = []
      for (let col = 0; col < 7; col++) {
        const d = cursor++
        const isCurrentMonth = d >= 1 && d <= totalDays
        const dateStr = isCurrentMonth ? formatIsoDate(year, m, d) : ""
        row.push({
          day: d,
          dateStr,
          isCurrentMonth,
          isToday: isCurrentMonth && dateStr === todayStr,
          isWeekend: isColumnWeekend(col, weekStart),
        })
      }
      if (week > 0 && row.every(cell => !cell.isCurrentMonth)) break
      cells.push(...row)
    }

    months.push({
      year,
      month: m,
      label: LONG_MONTHS[m]!,
      shortLabel: SHORT_MONTHS[m]!,
      cells,
    })
  }

  return months
}
