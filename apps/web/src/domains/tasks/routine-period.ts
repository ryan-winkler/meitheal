import { calendarToday, shiftCalendarDay } from "../../lib/date"
import { cadenceToRRule, parseRRule } from "./recurrence"

const CODE_BY_UTC_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const

function utcDayOfWeek(isoDay: string): number {
  return new Date(`${isoDay}T00:00:00.000Z`).getUTCDay()
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * Determine the canonical YYYY-MM-DD occurrence period key for a routine cadence or RRULE.
 *
 * - Legacy `"daily"` / `FREQ=DAILY`: today's calendar day (`YYYY-MM-DD`).
 * - Legacy `"weekly"` / plain `FREQ=WEEKLY` (no BYDAY): Monday of the current week.
 * - `FREQ=WEEKLY;BYDAY=...`: today if today's weekday matches BYDAY, else the most recent matching weekday.
 * - `FREQ=MONTHLY`: the configured day-of-month or ordinal weekday in the current month (or 1st of month).
 * - `FREQ=YEARLY`: the configured month/day in the current year (or Jan 1).
 */
export function routinePeriod(cadence: string, now = new Date(), timezone = "UTC"): string {
  const today = !timezone || timezone === "UTC"
    ? new Date(now).toISOString().slice(0, 10)
    : calendarToday(timezone, now)

  const trimmed = cadence.trim()
  if (trimmed === "daily" || trimmed === "FREQ=DAILY") return today
  if (trimmed === "weekly" || trimmed === "FREQ=WEEKLY") {
    const weekday = utcDayOfWeek(today)
    return shiftCalendarDay(today, -((weekday + 6) % 7))
  }

  const rruleStr = cadenceToRRule(trimmed)
  const rule = rruleStr ? parseRRule(rruleStr) : null
  if (!rule) return today

  const [year, month, day] = today.split("-").map(Number) as [number, number, number]
  let dateKey = today

  switch (rule.freq) {
    case "DAILY":
      dateKey = today
      break
    case "WEEKLY": {
      if (rule.byDay && rule.byDay.length > 0) {
        let matched: string | null = null
        for (let back = 0; back < 7; back++) {
          const candidate = shiftCalendarDay(today, -back)
          const code = CODE_BY_UTC_DAY[utcDayOfWeek(candidate)]!
          if (rule.byDay.includes(code)) {
            matched = candidate
            break
          }
        }
        if (matched) {
          dateKey = matched
          break
        }
      }
      const weekday = utcDayOfWeek(today)
      dateKey = shiftCalendarDay(today, -((weekday + 6) % 7))
      break
    }
    case "MONTHLY": {
      const ordinalEntry = rule.byDayEntries?.find((entry) => entry.ordinal !== null)
      if (ordinalEntry && ordinalEntry.ordinal !== null) {
        const targetDow = CODE_BY_UTC_DAY.indexOf(ordinalEntry.day as (typeof CODE_BY_UTC_DAY)[number])
        if (targetDow >= 0) {
          const total = daysInUtcMonth(year, month - 1)
          const matches: number[] = []
          for (let d = 1; d <= total; d++) {
            if (new Date(Date.UTC(year, month - 1, d)).getUTCDay() === targetDow) matches.push(d)
          }
          const picked = ordinalEntry.ordinal > 0
            ? matches[ordinalEntry.ordinal - 1]
            : matches[matches.length + ordinalEntry.ordinal]
          if (picked !== undefined) {
            dateKey = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(picked).padStart(2, "0")}`
            break
          }
        }
      }
      const desired = rule.byMonthDay?.[0] ?? 1
      const maxDay = daysInUtcMonth(year, month - 1)
      const clamped = desired > 0 ? Math.min(desired, maxDay) : Math.max(1, maxDay + desired + 1)
      dateKey = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`
      break
    }
    case "YEARLY": {
      const targetMonth = rule.byMonth?.[0] ?? 1
      const desired = rule.byMonthDay?.[0] ?? 1
      const maxDay = daysInUtcMonth(year, targetMonth - 1)
      const clamped = desired > 0 ? Math.min(desired, maxDay) : Math.max(1, maxDay + desired + 1)
      dateKey = `${String(year).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`
      break
    }
  }

  if (rule.byHour !== undefined) {
    const hh = String(rule.byHour).padStart(2, "0")
    const mm = String(rule.byMinute ?? 0).padStart(2, "0")
    return `${dateKey}T${hh}:${mm}`
  }

  return dateKey
}

/**
 * Check whether a routine is still within its end boundary (UNTIL / COUNT) for the current period.
 */
export function isRoutineActiveForPeriod(
  cadence: string,
  period: string,
  existingTaskCount = 0,
): boolean {
  const rruleStr = cadenceToRRule(cadence)
  const rule = rruleStr ? parseRRule(rruleStr) : null
  if (!rule) return true
  if (rule.until && period.slice(0, 10) > rule.until.slice(0, 10)) return false
  if (rule.count !== undefined && existingTaskCount >= rule.count) return false
  return true
}

/**
 * Step size in days for streak computation (returns 7 for weekly-only, 1 for daily/multi-day).
 */
export function routineStreakDayStep(cadence: string): number {
  const trimmed = cadence.trim()
  if (trimmed === "weekly" || trimmed === "FREQ=WEEKLY") return 7
  const rruleStr = cadenceToRRule(trimmed)
  const rule = rruleStr ? parseRRule(rruleStr) : null
  if (!rule) return 1
  if (rule.freq === "DAILY") return rule.interval
  if (rule.freq === "WEEKLY") {
    if (rule.byDay && rule.byDay.length > 1) return 1
    return 7 * rule.interval
  }
  if (rule.freq === "MONTHLY") return 30 * rule.interval
  if (rule.freq === "YEARLY") return 365 * rule.interval
  return 1
}
