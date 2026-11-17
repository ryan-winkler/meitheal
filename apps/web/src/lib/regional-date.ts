import { formatDistanceToNow } from "date-fns"
import { format as tzFormat, toZonedTime } from "date-fns-tz"
import { createClientLogger } from "@lib/client-logger"
import { parseCalendarDay } from "./calendar-day"
import { calendarDayFromInput, calendarDaysFromToday, DEFAULT_TIMEZONE, formatTimeInZone, resolveTimezone, type DateFormat } from "./date"

const log = createClientLogger("utils", "date")

/**
 * Format a date-only deadline on its stored calendar day.
 */
function formatDueDay(day: string, df: DateFormat, timezone: string, now = new Date()): string {
  const [y, m, d] = day.split("-")
  if (df === "absolute-eu") return `${d}/${m}/${y}`
  if (df === "absolute-us") return `${m}/${d}/${y}`
  if (df !== "relative") return day
  const days = calendarDaysFromToday(day, timezone, now) ?? 0
  // The Home Assistant image ships with English-only ICU data, as do the existing relative labels.
  const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  if (Math.abs(days) < 7) return relative.format(days, "day")
  if (Math.abs(days) < 30) return relative.format(Math.round(days / 7), "week")
  return relative.format(Math.round(days / 30), "month")
}

/**
 * Format a date string or Date object based on the user's regional settings.
 * Used by server-rendered task surfaces for localized dates and fallback patterns.
 */
export function formatRegionalDate(
  dateInput: string | Date | number | null | undefined,
  options?: {
    format?: DateFormat
    timezone?: string
    fallbackFormat?: string
    now?: Date
  }
): string {
  if (!dateInput) return ""

  // Resolve settings (Favor explicit options, then client-side window global, then defaults)
  let df: DateFormat = "relative"
  let tz = DEFAULT_TIMEZONE

  if (typeof window !== "undefined" && window.mSettings) {
    df = (window.mSettings.dateFormat as DateFormat) || "relative"
    tz = window.mSettings.timezone || DEFAULT_TIMEZONE
  }

  if (options?.format) df = options.format
  if (options?.timezone) tz = options.timezone
  tz = resolveTimezone(tz)
  const referenceNow = options?.now

  try {
    if (typeof dateInput === "string" && !options?.fallbackFormat) {
      if (parseCalendarDay(dateInput)) {
        return formatDueDay(dateInput, df, tz, referenceNow)
      }

      const calendarDay = calendarDayFromInput(dateInput, tz)
      if (calendarDay) {
        if (df === "relative") {
          const days = calendarDaysFromToday(dateInput, tz, referenceNow)
          if (days === 0) {
            const time = formatTimeInZone(dateInput, tz)
            return time ? `Today · ${time}` : "today"
          }
          return formatDueDay(calendarDay, df, tz, referenceNow)
        }
        return formatDueDay(calendarDay, df, tz, referenceNow)
      }
    }

    const d = new Date(dateInput)
    if (isNaN(d.getTime())) return String(dateInput)

    // If explicit fallback was requested, use date-fns-tz
    if (options?.fallbackFormat) {
      const zoned = toZonedTime(d, tz)
      return tzFormat(zoned, options.fallbackFormat, { timeZone: tz })
    }

    if (df === "relative") {
      // e.g "2 days ago"
      return formatDistanceToNow(d, { addSuffix: true })
    }

    // Convert to zoned time
    const zonedDate = toZonedTime(d, tz)

    if (df === "absolute-iso") {
      return tzFormat(zonedDate, "yyyy-MM-dd", { timeZone: tz })
    }
    if (df === "absolute-eu") {
      return tzFormat(zonedDate, "dd/MM/yyyy", { timeZone: tz })
    }
    if (df === "absolute-us") {
      return tzFormat(zonedDate, "MM/dd/yyyy", { timeZone: tz })
    }

    // Default fallback
    return tzFormat(zonedDate, "yyyy-MM-dd", { timeZone: tz })
  } catch (e) {
    log.warn("Date formatting error", e)
    return String(dateInput)
  }
}
