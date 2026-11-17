import { fromZonedTime } from "date-fns-tz"
import { parseCalendarDay } from "./calendar-day"

export type DateFormat = "relative" | "absolute-iso" | "absolute-eu" | "absolute-us";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FLOATING_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const DAY_MS = 86_400_000;
export const DEFAULT_TIMEZONE = "Europe/Dublin";

export function isValidTimezone(timezone: string): boolean {
  if (!timezone) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export function resolveTimezone(timezone?: string): string {
  const candidate = timezone?.trim() ?? ""
  return isValidTimezone(candidate) ? candidate : DEFAULT_TIMEZONE
}

let calendarFormatter: { timeZone: string; format: Intl.DateTimeFormat } | undefined
let clockFormatter: { timeZone: string; format: Intl.DateTimeFormat } | undefined
let offsetFormatter: { timeZone: string; format: Intl.DateTimeFormat } | undefined

/** Today's calendar date in the given timezone, as YYYY-MM-DD. */
export function calendarToday(timezone = DEFAULT_TIMEZONE, now = new Date()): string {
  const timeZone = resolveTimezone(timezone)
  if (calendarFormatter?.timeZone !== timeZone) {
    calendarFormatter = { timeZone, format: new Intl.DateTimeFormat("en", {
      timeZone, calendar: "iso8601", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
    }) }
  }
  const parts = calendarFormatter.format.formatToParts(now)
  const year = parts.find(part => part.type === "year")!.value.padStart(4, "0")
  const month = parts.find(part => part.type === "month")!.value
  const day = parts.find(part => part.type === "day")!.value
  return `${year}-${month}-${day}`
}

/** Shift a YYYY-MM-DD calendar day by a whole number of days. */
export function shiftCalendarDay(day: string, deltaDays: number): string {
  const parsed = parseCalendarDay(day);
  if (!parsed) return day;
  parsed.setUTCDate(parsed.getUTCDate() + deltaDays);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Extract the local YYYY-MM-DD calendar day from a date-only string,
 * floating datetime, or zoned ISO timestamp in the household timezone.
 */
export function calendarDayFromInput(
  input: string | Date | number | null | undefined,
  timezone = DEFAULT_TIMEZONE,
): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return null;

    if (DATE_ONLY.test(trimmed)) {
      return parseCalendarDay(trimmed) ? trimmed : null;
    }

    const floatingMatch = trimmed.match(FLOATING_DATETIME);
    if (floatingMatch) {
      const dayPart = floatingMatch[1]!;
      const hour = Number(floatingMatch[2]);
      const minute = Number(floatingMatch[3]);
      const second = floatingMatch[4] ? Number(floatingMatch[4]) : 0;
      if (hour > 23 || minute > 59 || second > 59) return null;
      return parseCalendarDay(dayPart) ? dayPart : null;
    }

    const parsed = new Date(/^\d{12,}$/.test(trimmed) ? Number(trimmed) : trimmed)
    if (Number.isNaN(parsed.getTime())) return null;
    return calendarToday(timezone, parsed);
  }

  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return calendarToday(timezone, parsed);
}

/** Extract HH:mm wall-clock time in the target timezone for timed inputs, or null for date-only values. */
export function formatTimeInZone(
  input: string | Date | number | null | undefined,
  timezone = DEFAULT_TIMEZONE,
): string | null {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed || DATE_ONLY.test(trimmed)) return null;
    const floatingMatch = trimmed.match(FLOATING_DATETIME);
    if (floatingMatch) {
      return `${floatingMatch[2]}:${floatingMatch[3]}`;
    }
  }

  const parsed = input instanceof Date ? input : new Date(typeof input === "string" ? input.trim() : input)
  if (Number.isNaN(parsed.getTime())) return null
  const timeZone = resolveTimezone(timezone)
  if (clockFormatter?.timeZone !== timeZone) {
    clockFormatter = { timeZone, format: new Intl.DateTimeFormat("en", {
      timeZone, numberingSystem: "latn", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }) }
  }
  return clockFormatter.format.format(parsed)
}

/** UTC offset of a timezone at an absolute instant. */
export function timezoneOffsetAt(instant: number, timeZone: string): number {
  if (offsetFormatter?.timeZone !== timeZone) {
    offsetFormatter = { timeZone, format: new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" }) }
  }
  const name = offsetFormatter.format.formatToParts(instant).find(part => part.type === "timeZoneName")?.value
  if (name === "GMT") return 0
  const match = name?.match(/^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/u)
  if (!match) throw new Error("Could not determine household UTC offset")
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)
  return (match[1] === "-" ? -1 : 1) * seconds * 1000
}

export function householdDayRanges(day: string, timezone: string): [number, number][] {
  const localStart = Date.parse(`${day}T00:00:00Z`)
  const localEnd = localStart + DAY_MS
  const offsetAt = (instant: number) => timezoneOffsetAt(instant, timezone)

  // All IANA offsets are within 24 hours of UTC and there is at most one
  // offset transition in this three-day window. With a constant offset the
  // local date translates directly to a UTC interval.
  const windowStart = localStart - DAY_MS
  const windowEnd = localEnd + DAY_MS
  const firstOffset = offsetAt(windowStart)
  const lastOffset = offsetAt(windowEnd - 1)
  if (firstOffset === lastOffset) return [[localStart - firstOffset, localEnd - firstOffset]]

  let before = windowStart
  let after = windowEnd - 1
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2)
    if (offsetAt(middle) === firstOffset) before = middle
    else after = middle
  }

  // Intersect the requested local date with each constant-offset segment.
  // A rollback just after midnight can leave a gap between the two ranges.
  const ranges: [number, number][] = []
  for (const [from, to, offset] of [[windowStart, after, firstOffset], [after, windowEnd, lastOffset]] as const) {
    const start = Math.max(from, localStart - offset)
    const end = Math.min(to, localEnd - offset)
    if (start >= end) continue
    const previous = ranges.at(-1)
    if (previous?.[1] === start) previous[1] = end
    else ranges.push([start, end])
  }
  return ranges
}

export function calendarEventInterval(start: string, end: string, timezone: string): [number, number] | null {
  if (DATE_ONLY.test(start.trim())) return null
  const first = calendarStartInstant(start.trim(), timezone)
  const last = calendarStartInstant(end.trim(), timezone)
  return last > first ? [first, last] : null
}

export function calendarIntervalOverlaps(interval: [number, number], ranges: [number, number][]): boolean {
  return ranges.some(([first, last]) => interval[0] < last && interval[1] > first)
}

function calendarStartInstant(raw: string, timezone: string): number {
  const wallTime = DATE_ONLY.test(raw) ? raw + "T00:00" : raw
  if (!FLOATING_DATETIME.test(wallTime)) return parseDueTime(raw, timezone)
  const wall = Date.parse(wallTime.replace(" ", "T") + "Z")
  if (!Number.isFinite(wall)) return NaN
  const offset = timezoneOffsetAt(wall - DAY_MS, timezone)
  const earlier = wall - offset
  // Prefer the first occurrence of a repeated time. Use the pre-transition offset in a gap.
  if (timezoneOffsetAt(earlier, timezone) === offset) return earlier
  const newOffset = timezoneOffsetAt(wall + DAY_MS, timezone)
  const later = wall - newOffset
  return timezoneOffsetAt(later, timezone) === newOffset ? later : earlier
}

/** Order connected events by instant. Read floating starts in the household timezone. */
export function compareCalendarStarts(left: string, right: string, timezone: string): number {
  return calendarStartInstant(left.trim(), timezone) - calendarStartInstant(right.trim(), timezone) ||
    Number(DATE_ONLY.test(right.trim())) - Number(DATE_ONLY.test(left.trim())) ||
    left.localeCompare(right)
}

/** Match timed occurrences by instant while keeping all-day starts distinct. */
export function calendarOccurrenceStartKey(start: string, timezone: string): string {
  const raw = start.trim()
  if (DATE_ONLY.test(raw)) return raw
  const instant = calendarStartInstant(raw, timezone)
  return Number.isFinite(instant) ? String(instant) : raw
}

export function formatCalendarEventTime(start: string, timezone: string): string | null {
  const raw = start.trim()
  return DATE_ONLY.test(raw) ? null : formatTimeInZone(calendarStartInstant(raw, timezone), timezone)
}

export function normalizeCalendarEventSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, " ")
}

/** Project a connected calendar timestamp onto the household day it covers. */
export function calendarEventDay(value: string, timezone: string, boundary: "start" | "exclusive-end" = "start"): string | null {
  const raw = value.trim()
  const exclusive = boundary === "exclusive-end"
  if (DATE_ONLY.test(raw)) {
    const day = calendarDayFromInput(raw, timezone)
    return day && exclusive ? shiftCalendarDay(day, -1) : day
  }
  return calendarDayFromInput(calendarStartInstant(raw, timezone) - Number(exclusive), timezone)
}

/** Whole calendar days from today to a date-only or timed ISO due date in the given timezone, or null if invalid. */
export function calendarDaysFromToday(day: string, timezone = DEFAULT_TIMEZONE, now = new Date()): number | null {
  const targetDay = calendarDayFromInput(day, timezone);
  if (!targetDay) return null;
  const target = parseCalendarDay(targetDay);
  const today = parseCalendarDay(calendarToday(timezone, now));
  if (!target || !today) return null;
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

/** Format a due date relative to today in the household timezone ("Due today", "Today · HH:MM", etc.). */
export function formatRelativeDue(
  dueDate: string,
  timezone = DEFAULT_TIMEZONE,
  now = new Date(),
  options?: { includeTime?: boolean },
): string {
  const days = calendarDaysFromToday(dueDate, timezone, now);
  if (days === null) return String(dueDate);
  if (days === 0) {
    if (options?.includeTime !== false) {
      const time = formatTimeInZone(dueDate, timezone);
      if (time) return `Today · ${time}`;
    }
    return "Due today";
  }
  if (days === 1) return "Due tomorrow";
  if (days < 0) return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
  return `Due in ${days} days`;
}

function parseDueTime(raw: string, timezone: string): number {
  if (/^\d{12,}$/.test(raw)) return Number(raw)
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return Date.parse(raw)
  if (!FLOATING_DATETIME.test(raw) || !calendarDayFromInput(raw, timezone)) return NaN
  return fromZonedTime(raw.replace(" ", "T"), resolveTimezone(timezone)).getTime()
}

/**
 * Web overdue checks keep date-only deadlines on their household day and read
 * floating times in the household timezone. For an explicit reference day,
 * only compare the clock when that day contains `now`.
 */
export function isDueOverdue(
  dueDate: unknown,
  timezone = DEFAULT_TIMEZONE,
  today?: string,
  now = Date.now(),
): boolean {
  if (typeof dueDate !== "string" && typeof dueDate !== "number") return false
  const raw = String(dueDate).trim()
  if (!raw) return false
  const clockDay = calendarToday(timezone, new Date(now))
  const dayInView = today ?? clockDay
  if (DATE_ONLY.test(raw)) return Boolean(parseCalendarDay(raw) && raw < dayInView)

  const instant = parseDueTime(raw, timezone)
  if (!Number.isFinite(instant)) return false
  const dueDay = calendarDayFromInput(instant, timezone)
  if (dueDay === null) return false
  return dueDay < dayInView || (dueDay === dayInView && dayInView === clockDay && instant < now)
}
