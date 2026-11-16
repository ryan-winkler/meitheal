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

/** Match the same Calendar occurrence across equivalent offset representations. */
export function calendarOccurrenceStartKey(start: string): string {
  const raw = start.trim()
  const instant = zonedCalendarInstant(raw)
  return instant === null ? raw : String(instant)
}

export function normalizeCalendarEventSummary(summary: string): string {
  return summary.trim().toLowerCase().replace(/\s+/g, " ")
}

/** The last household date covered by an event with an exclusive end. */
export function calendarEventLastDay(end: string, timezone: string): string | null {
  const raw = end.trim()
  const instant = zonedCalendarInstant(raw)
  if (instant !== null) return calendarDayFromInput(instant - 1, timezone)

  const day = calendarDayFromInput(raw, timezone)
  if (!day) return null
  if (DATE_ONLY.test(raw) || /^\d{4}-\d{2}-\d{2}[T ]00:00(?::00(?:\.0+)?)?$/.test(raw)) {
    return shiftCalendarDay(day, -1)
  }
  return day
}

function zonedCalendarInstant(raw: string): number | null {
  if (!/[T ].*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null
  const instant = Date.parse(raw)
  return Number.isFinite(instant) ? instant : null
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
