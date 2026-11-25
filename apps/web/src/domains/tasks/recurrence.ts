/**
 * Recurrence Engine — RFC 5545 RRULE subset with Google Calendar parity
 *
 * Parses and serializes iCal RRULE recurrence rules and calculates next occurrences.
 * Supports:
 * - DAILY, WEEKLY, MONTHLY, YEARLY frequencies
 * - INTERVAL
 * - BYDAY (including ordinals such as 4MO, -1FR for monthly nth weekday)
 * - BYMONTHDAY (1..31, -1)
 * - BYMONTH (1..12)
 * - COUNT and UNTIL end boundaries
 *
 * @domain domain-tasks
 * @kcs Recurrence rules follow RFC 5545 RRULE subset
 */

export interface ByDayEntry {
  ordinal: number | null
  day: string
}

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  interval: number
  byDay?: string[] // MO, TU, WE, TH, FR, SA, SU
  byDayEntries?: ByDayEntry[] // e.g. [{ ordinal: 4, day: "MO" }]
  byMonthDay?: number[]
  byMonth?: number[]
  byHour?: number // 0..23
  byMinute?: number // 0..59
  count?: number
  until?: string // ISO date string YYYY-MM-DD
}

const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
}

const CODE_BY_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const

const DAY_NAMES: Record<string, string> = {
  SU: "Sunday",
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const

const ORDINAL_WORDS: Record<number, string> = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
  [-1]: "last",
}

function pad2(n: number): string {
  return String(n).padStart(2, "0")
}

/** Format hour (0-23) and minute (0-59) into a clean 12-hour label like "6:00 AM" or "2:30 PM". */
export function formatRecurrenceTime(hour: number, minute = 0): string {
  const safeHour = ((Math.trunc(hour) % 24) + 24) % 24
  const safeMinute = Math.min(59, Math.max(0, Math.trunc(minute)))
  const suffix = safeHour >= 12 ? "PM" : "AM"
  const hour12 = safeHour % 12 || 12
  return `${hour12}:${pad2(safeMinute)} ${suffix}`
}

/** Extract "HH:MM" (24-hour) from a recurrence string if BYHOUR is present, else "". */
export function extractTimeFromRRule(rrule: string | null | undefined): string {
  if (!rrule) return ""
  const rule = parseRRule(cadenceToRRule(rrule) ?? rrule)
  if (!rule || rule.byHour === undefined) return ""
  return `${pad2(rule.byHour)}:${pad2(rule.byMinute ?? 0)}`
}

/** Return a canonical RRULE string with the given "HH:MM" time applied (or stripped if empty). */
export function applyTimeToRRule(rrule: string, timeHHMM: string | null | undefined): string {
  const canonical = cadenceToRRule(rrule) ?? rrule
  const rule = parseRRule(canonical)
  if (!rule) return rrule
  const trimmed = (timeHHMM ?? "").trim()
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (match) {
    const hour = Number.parseInt(match[1]!, 10)
    const minute = Number.parseInt(match[2]!, 10)
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      rule.byHour = hour
      rule.byMinute = minute
    }
  } else {
    delete rule.byHour
    delete rule.byMinute
  }
  return toRRuleString(rule)
}

/** Map legacy routine cadence shorthand ("daily", "weekly", "weekdays", "monthly", "yearly") or RRULE into a canonical RRULE. */
export function cadenceToRRule(cadence: string): string | null {
  const trimmed = cadence.trim()
  if (!trimmed) return null
  switch (trimmed.toLowerCase()) {
    case "daily":
      return "FREQ=DAILY"
    case "weekly":
      return "FREQ=WEEKLY"
    case "weekdays":
      return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
    case "monthly":
      return "FREQ=MONTHLY"
    case "yearly":
    case "annually":
      return "FREQ=YEARLY"
    default: {
      const parsed = parseRRule(trimmed)
      return parsed ? toRRuleString(parsed) : null
    }
  }
}

export function isValidRoutineCadence(value: unknown): value is string {
  return typeof value === "string" && value.trim().length <= 200 && cadenceToRRule(value) !== null
}

/**
 * Parse an RRULE string into a structured RecurrenceRule.
 * Examples:
 * - "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR;BYHOUR=6;BYMINUTE=0"
 * - "FREQ=MONTHLY;BYDAY=4MO"
 * - "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=23;COUNT=13"
 */
export function parseRRule(rrule: string): RecurrenceRule | null {
  if (!rrule || rrule.trim().length === 0) return null

  const trimmed = rrule.trim()
  const raw = trimmed.toUpperCase().startsWith("RRULE:") ? trimmed.slice(6) : trimmed
  const parts = raw.split(";")
  const map = new Map<string, string>()

  for (const part of parts) {
    const eqIdx = part.indexOf("=")
    if (eqIdx === -1) continue
    const key = part.slice(0, eqIdx).trim().toUpperCase()
    const value = part.slice(eqIdx + 1).trim().toUpperCase()
    if (key && value) map.set(key, value)
  }

  const freq = map.get("FREQ")
  if (!freq || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    return null
  }

  const parsedInterval = Number.parseInt(map.get("INTERVAL") ?? "1", 10)
  const rule: RecurrenceRule = {
    freq: freq as RecurrenceRule["freq"],
    interval: Number.isFinite(parsedInterval) && parsedInterval >= 1 ? Math.min(999, parsedInterval) : 1,
  }

  const byDay = map.get("BYDAY")
  if (byDay) {
    const entries: ByDayEntry[] = []
    for (const token of byDay.split(",")) {
      const match = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(token.trim())
      if (!match || !(match[2]! in DAY_MAP)) continue
      const ordinal = match[1] ? Number.parseInt(match[1], 10) : null
      if (ordinal !== null && (ordinal === 0 || ordinal < -5 || ordinal > 5)) continue
      entries.push({ ordinal, day: match[2]! })
    }
    if (entries.length > 0) {
      rule.byDayEntries = entries
      rule.byDay = Array.from(new Set(entries.map((entry) => entry.day)))
    }
  }

  const byMonthDay = map.get("BYMONTHDAY")
  if (byMonthDay) {
    const days = byMonthDay
      .split(",")
      .map((token) => Number.parseInt(token.trim(), 10))
      .filter((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) <= 31)
    if (days.length > 0) rule.byMonthDay = Array.from(new Set(days))
  }

  const byMonth = map.get("BYMONTH")
  if (byMonth) {
    const months = byMonth
      .split(",")
      .map((token) => Number.parseInt(token.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 12)
    if (months.length > 0) rule.byMonth = Array.from(new Set(months))
  }

  const byHour = map.get("BYHOUR")
  if (byHour !== undefined) {
    const parsedHour = Number.parseInt(byHour.split(",")[0]?.trim() ?? "", 10)
    if (Number.isInteger(parsedHour) && parsedHour >= 0 && parsedHour <= 23) {
      rule.byHour = parsedHour
      const byMinute = map.get("BYMINUTE")
      const parsedMin = byMinute !== undefined ? Number.parseInt(byMinute.split(",")[0]?.trim() ?? "", 10) : 0
      rule.byMinute = Number.isInteger(parsedMin) && parsedMin >= 0 && parsedMin <= 59 ? parsedMin : 0
    }
  }

  const count = map.get("COUNT")
  if (count) {
    const parsedCount = Number.parseInt(count, 10)
    if (Number.isFinite(parsedCount) && parsedCount > 0) {
      rule.count = Math.min(9999, parsedCount)
    }
  }

  const until = map.get("UNTIL")
  if (until) {
    if (/^\d{8}$/.test(until)) {
      rule.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
    } else if (/^\d{8}T\d{6}Z?$/.test(until)) {
      rule.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
    } else if (/^\d{4}-\d{2}-\d{2}/.test(until)) {
      rule.until = until.slice(0, 10)
    }
  }

  return rule
}

/** Serialize a RecurrenceRule back to a canonical RRULE string. */
export function toRRuleString(rule: RecurrenceRule): string {
  const parts: string[] = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byDayEntries && rule.byDayEntries.length > 0) {
    parts.push(`BYDAY=${rule.byDayEntries.map((entry) => `${entry.ordinal ?? ""}${entry.day}`).join(",")}`)
  } else if (rule.byDay && rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.join(",")}`)
  }
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(",")}`)
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`)
  if (rule.byHour !== undefined && Number.isInteger(rule.byHour) && rule.byHour >= 0 && rule.byHour <= 23) {
    parts.push(`BYHOUR=${rule.byHour}`)
    const min = rule.byMinute !== undefined && Number.isInteger(rule.byMinute) && rule.byMinute >= 0 && rule.byMinute <= 59
      ? rule.byMinute
      : 0
    parts.push(`BYMINUTE=${min}`)
  }
  if (rule.count) parts.push(`COUNT=${rule.count}`)
  if (rule.until) parts.push(`UNTIL=${rule.until.slice(0, 10).replace(/-/g, "")}`)
  return parts.join(";")
}

function nthWeekdayOfMonthUTC(year: number, monthIndex: number, weekday: number, ordinal: number): Date | null {
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
  const matches: number[] = []
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(Date.UTC(year, monthIndex, d)).getUTCDay() === weekday) matches.push(d)
  }
  const picked = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal]
  if (picked === undefined) return null
  return new Date(Date.UTC(year, monthIndex, picked))
}

/**
 * Calculate the next occurrence using UTC calendar fields.
 * Returns null if the recurrence has ended (count exhausted or past UNTIL date).
 */
export function getNextOccurrence(
  rule: RecurrenceRule,
  fromDate: Date,
  completionCount = 0,
): Date | null {
  if (rule.count !== undefined && completionCount >= rule.count) {
    return null
  }

  const next = new Date(fromDate.getTime())

  switch (rule.freq) {
    case "DAILY":
      next.setUTCDate(next.getUTCDate() + rule.interval)
      break

    case "WEEKLY":
      if (rule.byDay && rule.byDay.length > 0) {
        const currentDay = next.getUTCDay()
        const targetDays = rule.byDay
          .map((d) => DAY_MAP[d])
          .filter((d): d is number => d !== undefined)
          .sort((a, b) => a - b)

        let found = false
        for (const targetDay of targetDays) {
          const diff = targetDay - currentDay
          if (diff > 0) {
            next.setUTCDate(next.getUTCDate() + diff)
            found = true
            break
          }
        }

        if (!found && targetDays.length > 0) {
          const firstTarget = targetDays[0]!
          const daysUntilNextWeek = 7 * rule.interval - currentDay + firstTarget
          next.setUTCDate(next.getUTCDate() + daysUntilNextWeek)
        }
      } else {
        next.setUTCDate(next.getUTCDate() + 7 * rule.interval)
      }
      break

    case "MONTHLY": {
      const ordinalEntry = rule.byDayEntries?.find((entry) => entry.ordinal !== null)
      if (ordinalEntry && ordinalEntry.ordinal !== null && ordinalEntry.day in DAY_MAP) {
        const totalMonths = next.getUTCFullYear() * 12 + next.getUTCMonth() + rule.interval
        const targetYear = Math.floor(totalMonths / 12)
        const targetMonth = totalMonths % 12
        const computed = nthWeekdayOfMonthUTC(targetYear, targetMonth, DAY_MAP[ordinalEntry.day]!, ordinalEntry.ordinal)
        if (computed) {
          next.setUTCFullYear(computed.getUTCFullYear(), computed.getUTCMonth(), computed.getUTCDate())
        } else {
          next.setUTCMonth(next.getUTCMonth() + rule.interval)
        }
      } else {
        const desiredDay = rule.byMonthDay?.[0] ?? next.getUTCDate()
        const totalMonths = next.getUTCFullYear() * 12 + next.getUTCMonth() + rule.interval
        const targetYear = Math.floor(totalMonths / 12)
        const targetMonth = totalMonths % 12
        const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
        const clampedDay = desiredDay > 0 ? Math.min(desiredDay, lastDay) : Math.max(1, lastDay + desiredDay + 1)
        next.setUTCFullYear(targetYear, targetMonth, clampedDay)
      }
      break
    }

    case "YEARLY": {
      const targetYear = next.getUTCFullYear() + rule.interval
      const targetMonth = rule.byMonth?.[0] ? rule.byMonth[0] - 1 : next.getUTCMonth()
      const desiredDay = rule.byMonthDay?.[0] ?? next.getUTCDate()
      const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
      const clampedDay = desiredDay > 0 ? Math.min(desiredDay, lastDay) : Math.max(1, lastDay + desiredDay + 1)
      next.setUTCFullYear(targetYear, targetMonth, clampedDay)
      break
    }
  }

  if (rule.byHour !== undefined) {
    next.setUTCHours(rule.byHour, rule.byMinute ?? 0, 0, 0)
  }

  if (rule.until) {
    const untilDate = new Date(`${rule.until.slice(0, 10)}T23:59:59.999Z`)
    if (!Number.isNaN(untilDate.getTime()) && next > untilDate) return null
  }

  return next
}

/** Build dynamic Google Calendar preset recurrence options anchored to `referenceDate` (YYYY-MM-DD or Date). */
export function buildGoogleRecurrencePresets(referenceDate: Date | string = new Date()): Array<{ value: string; label: string }> {
  const ref = typeof referenceDate === "string" && /^\d{4}-\d{2}-\d{2}/.test(referenceDate)
    ? new Date(`${referenceDate.slice(0, 10)}T12:00:00Z`)
    : (referenceDate instanceof Date && !Number.isNaN(referenceDate.getTime()) ? referenceDate : new Date())

  const dow = ref.getUTCDay()
  const dayCode = CODE_BY_DAY[dow] ?? "MO"
  const dayName = DAY_NAMES[dayCode] ?? "Monday"
  const dayOfMonth = ref.getUTCDate()
  const monthIndex = ref.getUTCMonth()
  const monthNumber = monthIndex + 1
  const monthName = MONTH_NAMES[monthIndex] ?? "January"
  const nth = Math.floor((dayOfMonth - 1) / 7) + 1
  const daysInMonth = new Date(Date.UTC(ref.getUTCFullYear(), monthIndex + 1, 0)).getUTCDate()
  const isLastOfMonth = dayOfMonth + 7 > daysInMonth && nth >= 5
  const ordinalValue = isLastOfMonth ? -1 : nth
  const ordinalWord = ORDINAL_WORDS[ordinalValue] ?? `${nth}th`

  return [
    { value: "FREQ=DAILY", label: "Daily" },
    { value: `FREQ=WEEKLY;BYDAY=${dayCode}`, label: `Weekly on ${dayName}` },
    { value: `FREQ=MONTHLY;BYDAY=${ordinalValue}${dayCode}`, label: `Monthly on the ${ordinalWord} ${dayName}` },
    { value: `FREQ=YEARLY;BYMONTH=${monthNumber};BYMONTHDAY=${dayOfMonth}`, label: `Annually on ${monthName} ${dayOfMonth}` },
    { value: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", label: "Every weekday (Monday to Friday)" },
  ]
}

/** Build a human-readable Google Calendar-style description of a recurrence rule or legacy cadence. */
export function describeRule(ruleOrString: RecurrenceRule | string): string {
  const rule = typeof ruleOrString === "string"
    ? parseRRule(cadenceToRRule(ruleOrString) ?? ruleOrString)
    : ruleOrString
  if (!rule) return typeof ruleOrString === "string" ? ruleOrString : ""

  let desc = ""

  switch (rule.freq) {
    case "DAILY":
      desc = rule.interval === 1 ? "Daily" : `Every ${rule.interval} days`
      break
    case "WEEKLY": {
      const days = rule.byDay ?? []
      const isWeekdays =
        rule.interval === 1 &&
        days.length === 5 &&
        ["MO", "TU", "WE", "TH", "FR"].every((code) => days.includes(code))
      if (isWeekdays) {
        desc = "Every weekday (Monday to Friday)"
      } else if (days.length > 0) {
        const dayText = days.map((d) => DAY_NAMES[d] ?? d).join(", ")
        desc = rule.interval === 1 ? `Weekly on ${dayText}` : `Every ${rule.interval} weeks on ${dayText}`
      } else {
        desc = rule.interval === 1 ? "Weekly" : `Every ${rule.interval} weeks`
      }
      break
    }
    case "MONTHLY": {
      const ordinalEntry = rule.byDayEntries?.find((entry) => entry.ordinal !== null)
      if (ordinalEntry && ordinalEntry.ordinal !== null) {
        const ord = ORDINAL_WORDS[ordinalEntry.ordinal] ?? `${ordinalEntry.ordinal}th`
        const dayName = DAY_NAMES[ordinalEntry.day] ?? ordinalEntry.day
        desc = rule.interval === 1
          ? `Monthly on the ${ord} ${dayName}`
          : `Every ${rule.interval} months on the ${ord} ${dayName}`
      } else if (rule.byMonthDay?.length) {
        const dayNum = rule.byMonthDay[0]!
        desc = rule.interval === 1
          ? `Monthly on day ${dayNum}`
          : `Every ${rule.interval} months on day ${dayNum}`
      } else {
        desc = rule.interval === 1 ? "Monthly" : `Every ${rule.interval} months`
      }
      break
    }
    case "YEARLY": {
      if (rule.byMonth?.length && rule.byMonthDay?.length) {
        const monthName = MONTH_NAMES[(rule.byMonth[0]! - 1 + 12) % 12] ?? ""
        const dayNum = rule.byMonthDay[0]!
        desc = rule.interval === 1
          ? `Annually on ${monthName} ${dayNum}`
          : `Every ${rule.interval} years on ${monthName} ${dayNum}`
      } else {
        desc = rule.interval === 1 ? "Annually" : `Every ${rule.interval} years`
      }
      break
    }
  }

  if (rule.byHour !== undefined) {
    desc += ` at ${formatRecurrenceTime(rule.byHour, rule.byMinute ?? 0)}`
  }
  if (rule.count) desc += `, ${rule.count} times`
  if (rule.until) desc += `, until ${rule.until}`

  return desc
}
