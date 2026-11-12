import { formatDistanceToNow } from "date-fns";
import { format as tzFormat, toZonedTime } from "date-fns-tz";
import { createClientLogger } from "@lib/client-logger";
import { parseCalendarDay } from "./calendar-day";

const log = createClientLogger("utils", "date");

export type DateFormat = "relative" | "absolute-iso" | "absolute-eu" | "absolute-us";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Today's calendar date in the given timezone, as YYYY-MM-DD. */
export function calendarToday(timezone: string, now = new Date()): string {
  return tzFormat(toZonedTime(now, timezone), "yyyy-MM-dd", { timeZone: timezone });
}

/** Whole calendar days from today to a YYYY-MM-DD date in the given timezone, or null for any other value. */
export function calendarDaysFromToday(day: string, timezone: string, now = new Date()): number | null {
  const target = parseCalendarDay(day);
  const today = parseCalendarDay(calendarToday(timezone, now));
  if (!target || !today) return null;
  return Math.round((target.getTime() - today.getTime()) / DAY_MS);
}

/**
 * A due date without a time is a calendar day, not an instant at UTC midnight.
 * Format it as that day so it never shifts by a day or reads "22 hours ago".
 */
function formatDueDay(day: string, df: DateFormat, timezone: string): string {
  const [y, m, d] = day.split("-");
  if (df === "absolute-eu") return `${d}/${m}/${y}`;
  if (df === "absolute-us") return `${m}/${d}/${y}`;
  if (df !== "relative") return day;
  const days = calendarDaysFromToday(day, timezone) ?? 0;
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
  }
): string {
  if (!dateInput) return "";

  // Resolve settings (Favor explicit options, then client-side window global, then defaults)
  let df: DateFormat = "relative";
  let tz = "Europe/Dublin";

  if (typeof window !== "undefined" && window.mSettings) {
    df = (window.mSettings.dateFormat as DateFormat) || "relative";
    tz = window.mSettings.timezone || "Europe/Dublin";
  }

  if (options?.format) df = options.format;
  if (options?.timezone) tz = options.timezone;

  try {
    if (typeof dateInput === "string" && DATE_ONLY.test(dateInput) && parseCalendarDay(dateInput) && !options?.fallbackFormat) {
      return formatDueDay(dateInput, df, tz);
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
