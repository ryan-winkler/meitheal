import { formatDistanceToNow } from "date-fns";
import { format as tzFormat, toZonedTime } from "date-fns-tz";
import { createClientLogger } from "@lib/client-logger";
import { parseCalendarDay } from "./calendar-day";

const log = createClientLogger("utils", "date");

export type DateFormat = "relative" | "absolute-iso" | "absolute-eu" | "absolute-us";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const FLOATING_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const DAY_MS = 86_400_000;
const DEFAULT_TIMEZONE = "Europe/Dublin";

function resolveTimezone(timezone?: string): string {
  const candidate = timezone?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en", { timeZone: candidate });
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Today's calendar date in the given timezone, as YYYY-MM-DD. */
export function calendarToday(timezone = DEFAULT_TIMEZONE, now = new Date()): string {
  const tz = resolveTimezone(timezone);
  return tzFormat(toZonedTime(now, tz), "yyyy-MM-dd", { timeZone: tz });
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
  const tz = resolveTimezone(timezone);

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

    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return calendarToday(tz, parsed);
  }

  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return calendarToday(tz, parsed);
}

/** Extract HH:mm wall-clock time in the target timezone for timed inputs, or null for date-only values. */
export function formatTimeInZone(
  input: string | Date | number | null | undefined,
  timezone = DEFAULT_TIMEZONE,
): string | null {
  if (input === null || input === undefined || input === "") return null;
  const tz = resolveTimezone(timezone);

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed || DATE_ONLY.test(trimmed)) return null;
    const floatingMatch = trimmed.match(FLOATING_DATETIME);
    if (floatingMatch) {
      return `${floatingMatch[2]}:${floatingMatch[3]}`;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return tzFormat(toZonedTime(parsed, tz), "HH:mm", { timeZone: tz });
  }

  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) return null;
  return tzFormat(toZonedTime(parsed, tz), "HH:mm", { timeZone: tz });
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

/**
 * A due date without a time is a calendar day, not an instant at UTC midnight.
 * Format it as that day so it never shifts by a day or reads "22 hours ago".
 */
function formatDueDay(day: string, df: DateFormat, timezone: string, now = new Date()): string {
  const [y, m, d] = day.split("-");
  if (df === "absolute-eu") return `${d}/${m}/${y}`;
  if (df === "absolute-us") return `${m}/${d}/${y}`;
  if (df !== "relative") return day;
  const days = calendarDaysFromToday(day, timezone, now) ?? 0;
  // The Home Assistant image ships with English-only ICU data, as do the existing relative labels.
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(days) < 7) return relative.format(days, "day");
  if (Math.abs(days) < 30) return relative.format(Math.round(days / 7), "week");
  return relative.format(Math.round(days / 30), "month");
}

/**
 * Format a date string or Date object based on the user's regional settings.
 * Supports running in SSR (where settings are passed in) or CSR (reads from window.mSettings).
 */
export function formatRegionalDate(
  dateInput: string | Date | number | null | undefined,
  options?: {
    format?: DateFormat;
    timezone?: string;
    fallbackFormat?: string;
    now?: Date;
  }
): string {
  if (!dateInput) return "";

  // Resolve settings (Favor explicit options, then client-side window global, then defaults)
  let df: DateFormat = "relative";
  let tz = DEFAULT_TIMEZONE;

  if (typeof window !== "undefined" && window.mSettings) {
    df = (window.mSettings.dateFormat as DateFormat) || "relative";
    tz = window.mSettings.timezone || DEFAULT_TIMEZONE;
  }

  if (options?.format) df = options.format;
  if (options?.timezone) tz = options.timezone;
  tz = resolveTimezone(tz);
  const referenceNow = options?.now;

  try {
    if (typeof dateInput === "string" && !options?.fallbackFormat) {
      if (DATE_ONLY.test(dateInput) && parseCalendarDay(dateInput)) {
        return formatDueDay(dateInput, df, tz, referenceNow);
      }

      const calendarDay = calendarDayFromInput(dateInput, tz);
      if (calendarDay) {
        if (df === "relative") {
          const days = calendarDaysFromToday(dateInput, tz, referenceNow);
          if (days === 0) {
            const time = formatTimeInZone(dateInput, tz);
            return time ? `Today · ${time}` : "today";
          }
          return formatDueDay(calendarDay, df, tz, referenceNow);
        }
        return formatDueDay(calendarDay, df, tz, referenceNow);
      }
    }

    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return String(dateInput);

    // If explicit fallback was requested, use date-fns-tz
    if (options?.fallbackFormat) {
      const zoned = toZonedTime(d, tz);
      return tzFormat(zoned, options.fallbackFormat, { timeZone: tz });
    }

    if (df === "relative") {
      // e.g "2 days ago"
      return formatDistanceToNow(d, { addSuffix: true });
    }

    // Convert to zoned time
    const zonedDate = toZonedTime(d, tz);

    if (df === "absolute-iso") {
      return tzFormat(zonedDate, "yyyy-MM-dd", { timeZone: tz });
    }
    if (df === "absolute-eu") {
      return tzFormat(zonedDate, "dd/MM/yyyy", { timeZone: tz });
    }
    if (df === "absolute-us") {
      return tzFormat(zonedDate, "MM/dd/yyyy", { timeZone: tz });
    }

    // Default fallback
    return tzFormat(zonedDate, "yyyy-MM-dd", { timeZone: tz });
  } catch (e) {
    log.warn("Date formatting error", e);
    return String(dateInput);
  }
}
