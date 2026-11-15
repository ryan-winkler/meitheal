/**
 * Calendar Recurrence Engine — RFC 5545 RRULE / EXDATE Parsing, Inference & Expansion
 *
 * Supports DAILY, WEEKLY, MONTHLY, YEARLY with INTERVAL, BYDAY (including ordinals
 * such as 2TU or -1FR), BYMONTHDAY, BYMONTH, BYSETPOS (MONTHLY and YEARLY), COUNT,
 * UNTIL, EXDATE exclusions, and occurrence inference for HA calendar series without
 * RRULE. Days that do not exist in a month (the 31st, February 29) are skipped.
 * Rules with other parts are kept verbatim so a provider rule is never rewritten.
 *
 * @domain calendar
 * @bounded-context integration
 */
import { fromZonedTime, toZonedTime, format as tzFormat } from "date-fns-tz"
import { calendarDayFromInput, shiftCalendarDay } from "../../lib/date"
import { parseCalendarDay } from "../../lib/calendar-day"

export type RecurrenceFrequency = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"

export interface RecurrenceRule {
  freq: RecurrenceFrequency
  interval: number
  /** Weekday codes without ordinals, as used by WEEKLY rules. */
  byDay?: string[]
  /** Weekday codes with an optional ordinal (2TU, -1FR), as written in the rule. */
  byDayEntries?: { ordinal: number | null; day: string }[]
  byMonthDay?: number[]
  byMonth?: number[]
  bySetPos?: number[]
  wkst?: string
  count?: number
  until?: string
  /** Rule parts this engine does not model. The rule is kept verbatim when present. */
  unsupportedParts?: string[]
}

const MODELED_PARTS = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "COUNT", "UNTIL", "WKST"])

function parseIntegerList(value: string | undefined, min: number, max: number): number[] | undefined {
  if (!value) return undefined
  const numbers = value.split(",").map(token => Number.parseInt(token.trim(), 10))
    .filter(n => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max)
  return numbers.length > 0 ? Array.from(new Set(numbers)) : undefined
}

const VALID_FREQS = new Set<RecurrenceFrequency>(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
}
const CODE_BY_UTC_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const
const WEEKDAY_SORT_ORDER: Record<string, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
}
const DAY_MS = 86_400_000
const DEFAULT_MAX_OCCURRENCES = 500

/** Parse an RFC 5545 RRULE string into a structured RecurrenceRule. */
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

  const freq = map.get("FREQ") as RecurrenceFrequency | undefined
  if (!freq || !VALID_FREQS.has(freq)) {
    return null
  }

  const parsedInterval = Number.parseInt(map.get("INTERVAL") ?? "1", 10)
  const rule: RecurrenceRule = {
    freq,
    interval: Number.isFinite(parsedInterval) && parsedInterval >= 1 ? parsedInterval : 1,
  }

  const byDay = map.get("BYDAY")
  if (byDay) {
    const entries = byDay
      .split(",")
      .map(token => /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(token.trim()))
      .filter((m): m is RegExpExecArray => m !== null && m[2]! in DAY_MAP)
      .map(m => ({ ordinal: m[1] ? Number.parseInt(m[1], 10) || null : null, day: m[2]! }))
    if (entries.length > 0) {
      rule.byDay = Array.from(new Set(entries.map(e => e.day)))
      rule.byDayEntries = entries
    }
  }
  const byMonthDay = parseIntegerList(map.get("BYMONTHDAY"), 1, 31)
  if (byMonthDay) rule.byMonthDay = byMonthDay
  const byMonth = parseIntegerList(map.get("BYMONTH"), 1, 12)?.filter(n => n > 0)
  if (byMonth?.length) rule.byMonth = byMonth
  const bySetPos = parseIntegerList(map.get("BYSETPOS"), 1, 366)
  if (bySetPos) rule.bySetPos = bySetPos
  const wkst = map.get("WKST")
  if (wkst && wkst in DAY_MAP) rule.wkst = wkst
  const unsupported = Array.from(map.keys()).filter(key => !MODELED_PARTS.has(key))
  // BYSETPOS is only expanded within a month; on DAILY or WEEKLY rules keep it verbatim.
  if (rule.bySetPos && (freq === "DAILY" || freq === "WEEKLY")) unsupported.push("BYSETPOS")
  if (unsupported.length > 0) rule.unsupportedParts = unsupported

  const count = map.get("COUNT")
  if (count) {
    const parsedCount = Number.parseInt(count, 10)
    if (Number.isFinite(parsedCount) && parsedCount > 0) {
      rule.count = parsedCount
    }
  }

  const until = map.get("UNTIL")
  if (until) {
    if (/^\d{8}$/.test(until)) {
      rule.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
    } else if (/^\d{8}T\d{6}Z?$/.test(until)) {
      const datePart = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
      const timePart = `${until.slice(9, 11)}:${until.slice(11, 13)}:${until.slice(13, 15)}`
      rule.until = `${datePart}T${timePart}${until.endsWith("Z") ? "Z" : ""}`
    } else {
      rule.until = until
    }
  }

  return rule
}

function formatRRuleUntil(until: string): string {
  const trimmed = until.trim()
  if (/^\d{8}(?:T\d{6}Z?)?$/i.test(trimmed)) {
    return trimmed.toUpperCase()
  }
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z?))?$/)
  if (isoMatch) {
    const [, y, m, d, hh, mm, ss = "00", z = ""] = isoMatch
    return hh && mm ? `${y}${m}${d}T${hh}${mm}${ss}${z.toUpperCase()}` : `${y}${m}${d}`
  }
  const parsed = new Date(trimmed)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
  }
  return trimmed.slice(0, 10).replace(/-/g, "")
}

/** Serialize a RecurrenceRule back to an RRULE string (without "RRULE:" prefix). */
export function toRRuleString(rule: RecurrenceRule): string {
  const parts: string[] = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.byDayEntries && rule.byDayEntries.length > 0) {
    parts.push(`BYDAY=${rule.byDayEntries.map(e => `${e.ordinal ?? ""}${e.day}`).join(",")}`)
  } else if (rule.byDay && rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.join(",")}`)
  }
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`)
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(",")}`)
  if (rule.bySetPos?.length) parts.push(`BYSETPOS=${rule.bySetPos.join(",")}`)
  if (rule.wkst && rule.wkst !== "MO") parts.push(`WKST=${rule.wkst}`)
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`)
  if (rule.until) {
    parts.push(`UNTIL=${formatRRuleUntil(rule.until)}`)
  }
  return parts.join(";")
}

/** Normalize an RRULE string to canonical form, or return null if invalid. */
export function normalizeRRule(rrule: string | null | undefined): string | null {
  if (!rrule) return null
  const parsed = parseRRule(rrule)
  if (!parsed) return null
  if (parsed.unsupportedParts?.length) {
    // Keep a rule this engine cannot fully model exactly as the provider wrote it.
    const trimmed = rrule.trim()
    return (trimmed.toUpperCase().startsWith("RRULE:") ? trimmed.slice(6) : trimmed).toUpperCase()
  }
  return toRRuleString(parsed)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/**
 * Days (1-31) a MONTHLY or YEARLY rule selects in one month. Without BYMONTHDAY or
 * BYDAY the rule repeats on the start day. RFC 5545 §3.3.10 says a month without
 * that day (February 30, or February 29 in a common year) is skipped and not
 * counted, which matches CalDAV servers. With both BYMONTHDAY and BYDAY, only days
 * that satisfy both are kept (Friday the 13th).
 */
function monthCandidateDays(rule: RecurrenceRule, year: number, month: number, startDay: number): number[] {
  const length = daysInMonth(year, month)
  let days: number[]
  const monthDays = rule.byMonthDay?.length
    ? rule.byMonthDay.map(d => (d > 0 ? d : length + d + 1)).filter(d => d >= 1 && d <= length)
    : null
  if (rule.byDayEntries?.length) {
    days = []
    for (const entry of rule.byDayEntries) {
      const weekday = DAY_MAP[entry.day]!
      const matches: number[] = []
      for (let d = 1; d <= length; d++) {
        if (new Date(Date.UTC(year, month, d)).getUTCDay() === weekday) matches.push(d)
      }
      if (entry.ordinal === null) days.push(...matches)
      else {
        const pick = entry.ordinal > 0 ? matches[entry.ordinal - 1] : matches[matches.length + entry.ordinal]
        if (pick !== undefined) days.push(pick)
      }
    }
    if (monthDays) {
      const allowed = new Set(monthDays)
      days = days.filter(d => allowed.has(d))
    }
  } else if (monthDays) {
    days = monthDays
  } else {
    days = startDay <= length ? [startDay] : []
  }
  days = Array.from(new Set(days)).sort((a, b) => a - b)
  if (rule.bySetPos?.length) {
    const picked = rule.bySetPos
      .map(pos => (pos > 0 ? days[pos - 1] : days[days.length + pos]))
      .filter((d): d is number => d !== undefined)
    days = Array.from(new Set(picked)).sort((a, b) => a - b)
  }
  return days
}

/** Candidate days of a MONTHLY or YEARLY rule from its start day, in order. */
function* monthBasedDays(rule: RecurrenceRule, startDay: string): Generator<string> {
  const [y, m, d] = startDay.split("-").map(Number) as [number, number, number]
  const startMonth = m - 1
  const months = rule.freq === "YEARLY" ? (rule.byMonth?.map(n => n - 1) ?? [startMonth]).sort((a, b) => a - b) : null
  for (let step = 0; step < 12_000; step++) {
    const periodMonths = months
      ? months.map(month => ({ year: y + step * rule.interval, month }))
      : [{ year: y + Math.floor((startMonth + step * rule.interval) / 12), month: (startMonth + step * rule.interval) % 12 }]
    for (const { year, month } of periodMonths) {
      if (rule.freq === "MONTHLY" && rule.byMonth?.length && !rule.byMonth.includes(month + 1)) continue
      for (const day of monthCandidateDays(rule, year, month, d)) {
        const iso = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
        if (iso >= startDay) yield iso
      }
    }
  }
}

/** Compute the next occurrence after `fromDate` using UTC calendar fields. */
export function getNextOccurrence(
  rule: RecurrenceRule,
  fromDate: Date,
  completionCount = 0,
): Date | null {
  if (rule.count !== undefined && completionCount >= rule.count) {
    return null
  }
  if (Number.isNaN(fromDate.getTime())) return null

  const next = new Date(fromDate.getTime())

  switch (rule.freq) {
    case "DAILY":
      next.setUTCDate(next.getUTCDate() + rule.interval)
      break

    case "WEEKLY":
      if (rule.byDay && rule.byDay.length > 0) {
        const wkstDay = DAY_MAP[rule.wkst ?? "MO"] ?? 1
        const currentOffset = (next.getUTCDay() - wkstDay + 7) % 7
        const targetOffsets = Array.from(
          new Set(
            rule.byDay
              .map(d => DAY_MAP[d])
              .filter((d): d is number => d !== undefined)
              .map(d => (d - wkstDay + 7) % 7),
          ),
        ).sort((a, b) => a - b)

        const nextInWeek = targetOffsets.find(offset => offset > currentOffset)
        if (nextInWeek !== undefined) {
          next.setUTCDate(next.getUTCDate() + (nextInWeek - currentOffset))
        } else if (targetOffsets.length > 0) {
          const daysUntilNextWeek = 7 * rule.interval - currentOffset + targetOffsets[0]!
          next.setUTCDate(next.getUTCDate() + daysUntilNextWeek)
        }
      } else {
        next.setUTCDate(next.getUTCDate() + 7 * rule.interval)
      }
      break

    case "MONTHLY": {
      const origDay = next.getUTCDate()
      next.setUTCMonth(next.getUTCMonth() + rule.interval)
      if (next.getUTCDate() !== origDay) {
        next.setUTCDate(0)
      }
      break
    }

    case "YEARLY": {
      const origMonth = next.getUTCMonth()
      next.setUTCFullYear(next.getUTCFullYear() + rule.interval)
      if (next.getUTCMonth() !== origMonth) {
        next.setUTCDate(0)
      }
      break
    }
  }

  if (rule.until) {
    const untilDate = /^\d{4}-\d{2}-\d{2}$/.test(rule.until)
      ? new Date(`${rule.until}T23:59:59.999Z`)
      : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(rule.until)
        ? new Date(`${rule.until.replace(" ", "T")}Z`)
        : new Date(rule.until)
    if (!Number.isNaN(untilDate.getTime()) && next > untilDate) {
      return null
    }
  }

  return next
}

/**
 * Infer an RRULE string from multiple occurrence start dates/timestamps in a series.
 * Recognizes daily (~1d), weekday schedules, weekly (~7d / biweekly ~14d), monthly (~28-31d), and yearly (~365-366d).
 */
export function inferRRuleFromDates(
  occurrenceStarts: string[],
  timezone = "Europe/Dublin",
): string | null {
  const uniqueDays = Array.from(
    new Set(
      occurrenceStarts
        .map(s => calendarDayFromInput(s, timezone))
        .filter((d): d is string => d !== null),
    ),
  ).sort()

  if (uniqueDays.length < 2) return null

  const parsedDays = uniqueDays
    .map(d => parseCalendarDay(d))
    .filter((d): d is Date => d !== undefined)

  if (parsedDays.length < 2) return null

  const deltas: number[] = []
  for (let i = 1; i < parsedDays.length; i++) {
    deltas.push(Math.round((parsedDays[i]!.getTime() - parsedDays[i - 1]!.getTime()) / DAY_MS))
  }

  const minDelta = Math.min(...deltas)
  const maxDelta = Math.max(...deltas)

  if (minDelta === 1 && maxDelta === 1) {
    return "FREQ=DAILY"
  }

  const dayCodes = Array.from(
    new Set(parsedDays.map(d => CODE_BY_UTC_DAY[d.getUTCDay()]!)),
  ).sort((a, b) => (WEEKDAY_SORT_ORDER[a] ?? 9) - (WEEKDAY_SORT_ORDER[b] ?? 9))

  const allWeekdays = parsedDays.every(d => {
    const dow = d.getUTCDay()
    return dow >= 1 && dow <= 5
  })
  if (allWeekdays && maxDelta <= 3 && deltas.some(d => d === 3) && deltas.some(d => d === 1)) {
    return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
  }

  if (minDelta >= 6 && maxDelta <= 8 && dayCodes.length === 1) {
    return `FREQ=WEEKLY;BYDAY=${dayCodes[0]}`
  }

  if (minDelta === 7 && maxDelta === 7) {
    return `FREQ=WEEKLY;BYDAY=${dayCodes.join(",")}`
  }

  // Handle weekly / multi-week series where an occasional week was skipped or cancelled
  if (dayCodes.length === 1 && deltas.every(d => d >= 7 && d % 7 === 0)) {
    const weeks = deltas.map(d => d / 7)
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
    const intervalWeeks = weeks.reduce((acc, w) => gcd(acc, w))
    if (intervalWeeks === 1) {
      return `FREQ=WEEKLY;BYDAY=${dayCodes[0]}`
    }
    if (intervalWeeks <= 4) {
      return `FREQ=WEEKLY;INTERVAL=${intervalWeeks};BYDAY=${dayCodes[0]}`
    }
  }

  if (minDelta >= 13 && maxDelta <= 15 && dayCodes.length === 1) {
    return `FREQ=WEEKLY;INTERVAL=2;BYDAY=${dayCodes[0]}`
  }

  if (minDelta >= 28 && maxDelta <= 31) {
    return "FREQ=MONTHLY"
  }

  if (minDelta >= 365 && maxDelta <= 366) {
    return "FREQ=YEARLY"
  }

  if (minDelta === maxDelta && minDelta > 1) {
    if (minDelta % 7 === 0 && dayCodes.length === 1) {
      return `FREQ=WEEKLY;INTERVAL=${minDelta / 7};BYDAY=${dayCodes[0]}`
    }
    return `FREQ=DAILY;INTERVAL=${minDelta}`
  }

  // Handle multi-day weekly patterns (e.g. MO,WE,FR repeating across weeks)
  if (maxDelta <= 7 && dayCodes.length > 1 && uniqueDays.length >= 3) {
    const spanWeeks = (parsedDays[parsedDays.length - 1]!.getTime() - parsedDays[0]!.getTime()) / (7 * DAY_MS)
    if (spanWeeks >= 1) {
      return `FREQ=WEEKLY;BYDAY=${dayCodes.join(",")}`
    }
  }

  // Approximate daily when minor gaps occur
  const avgDelta = deltas.reduce((sum, d) => sum + d, 0) / deltas.length
  if (avgDelta >= 0.9 && avgDelta <= 1.5 && deltas.some(d => d === 1)) {
    return "FREQ=DAILY"
  }
  if (avgDelta >= 6.5 && avgDelta <= 7.5 && dayCodes.length === 1) {
    return `FREQ=WEEKLY;BYDAY=${dayCodes[0]}`
  }

  return null
}

export interface ExpandedOccurrence {
  start: string
  end?: string | undefined
  inclusiveEndDate?: string | undefined
}

export interface ExpandRRuleInput {
  dtstart: string
  dtend?: string | undefined
  rrule?: string | undefined
  exdates?: string[] | undefined
  windowStart: Date
  windowEnd: Date
  allDay?: boolean | undefined
  timezone?: string | undefined
  maxOccurrences?: number | undefined
}

function buildExdateSet(
  exdates: string[] | undefined,
  timezone: string,
  isZoned: boolean,
): { days: Set<string>; instants: Set<number> } {
  const days = new Set<string>()
  const instants = new Set<number>()
  for (const ex of exdates ?? []) {
    const trimmed = ex.trim()
    if (!trimmed) continue
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      days.add(trimmed)
      continue
    }
    if (trimmed.includes("T") || trimmed.includes(" ")) {
      if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) {
        const ms = Date.parse(trimmed)
        if (!Number.isNaN(ms)) instants.add(ms)
      } else {
        // Normalize floating EXDATE wall-clock timestamps against the event's timezone semantics.
        const isoWall = trimmed.replace(" ", "T")
        const ms = isZoned
          ? fromZonedTime(isoWall, timezone).getTime()
          : Date.parse(`${isoWall}Z`)
        if (!Number.isNaN(ms)) instants.add(ms)
      }
      continue
    }
    const day = calendarDayFromInput(trimmed, timezone)
    if (day) days.add(day)
  }
  return { days, instants }
}

function parseStartTimeParts(dtstart: string, timezone: string): { day: string; timeStr: string | null; isZoned: boolean } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dtstart)) {
    return parseCalendarDay(dtstart) ? { day: dtstart, timeStr: null, isZoned: false } : null
  }
  const floating = dtstart.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/)
  if (floating && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(dtstart)) {
    return parseCalendarDay(floating[1]!) ? { day: floating[1]!, timeStr: floating[2]!, isZoned: false } : null
  }
  const parsed = new Date(dtstart)
  if (Number.isNaN(parsed.getTime())) return null
  const zoned = toZonedTime(parsed, timezone)
  return {
    day: tzFormat(zoned, "yyyy-MM-dd", { timeZone: timezone }),
    timeStr: tzFormat(zoned, "HH:mm:ss", { timeZone: timezone }),
    isZoned: true,
  }
}

function buildOccurrenceTimestamp(day: string, timeStr: string | null, isZoned: boolean, timezone: string): string {
  if (!timeStr) return day
  const wallClock = `${day}T${timeStr}`
  if (!isZoned) return wallClock
  return fromZonedTime(wallClock, timezone).toISOString().replace(/\.\d{3}Z$/, "Z")
}

function computeAllDayDurationDays(dtstart: string, dtend?: string): number {
  if (!dtend) return 1
  const s = parseCalendarDay(dtstart.slice(0, 10))
  const e = parseCalendarDay(dtend.slice(0, 10))
  if (!s || !e) return 1
  const diff = Math.round((e.getTime() - s.getTime()) / DAY_MS)
  return diff >= 1 ? diff : 1
}

function inclusiveEndForAllDay(startDay: string, exclusiveEndDay: string): string {
  if (exclusiveEndDay <= startDay) return startDay
  return shiftCalendarDay(exclusiveEndDay, -1)
}

function parseInstantValue(value: string): number {
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return Date.parse(value)
  return Date.parse(`${value.replace(" ", "T")}Z`)
}

function overlapsWindow(startStr: string, endStr: string | undefined, allDay: boolean, windowStart: Date, windowEnd: Date): boolean {
  const startMs = allDay ? Date.parse(`${startStr.slice(0, 10)}T00:00:00Z`) : parseInstantValue(startStr)
  if (Number.isNaN(startMs)) return false
  let endMs = startMs
  if (endStr) {
    const parsedEnd = allDay ? Date.parse(`${endStr.slice(0, 10)}T00:00:00Z`) : parseInstantValue(endStr)
    if (!Number.isNaN(parsedEnd)) endMs = parsedEnd
  } else if (allDay) {
    endMs = startMs + DAY_MS
  }
  if (allDay) {
    return endMs > windowStart.getTime() && startMs <= windowEnd.getTime()
  }
  return endMs >= windowStart.getTime() && startMs <= windowEnd.getTime()
}

/** Whether a DAILY or WEEKLY candidate day is removed by the rule's BYDAY, BYMONTHDAY or BYMONTH limits. */
function isLimitedOut(rule: RecurrenceRule, day: Date): boolean {
  if (rule.freq === "DAILY" && rule.byDay?.length && !rule.byDay.includes(CODE_BY_UTC_DAY[day.getUTCDay()]!)) {
    return true
  }
  if (rule.byMonth?.length && !rule.byMonth.includes(day.getUTCMonth() + 1)) return true
  if (rule.freq === "DAILY" && rule.byMonthDay?.length) {
    const length = daysInMonth(day.getUTCFullYear(), day.getUTCMonth())
    const dayOfMonth = day.getUTCDate()
    if (!rule.byMonthDay.some(d => (d > 0 ? d : length + d + 1) === dayOfMonth)) return true
  }
  return false
}

/**
 * Expand a VEVENT (single or recurring via RRULE with EXDATE exclusions)
 * into concrete occurrences overlapping [windowStart, windowEnd].
 */
export function expandRRuleOccurrences(input: ExpandRRuleInput): ExpandedOccurrence[] {
  const tz = input.timezone?.trim() || "UTC"
  const allDay = input.allDay ?? /^\d{4}-\d{2}-\d{2}$/.test(input.dtstart)
  const parsedRule = input.rrule ? parseRRule(input.rrule) : null

  const startParts = parseStartTimeParts(input.dtstart, tz)
  const exdateSet = buildExdateSet(input.exdates, tz, startParts?.isZoned ?? false)
  const parseInstantMs = (value: string, isZoned: boolean): number => {
    if (isZoned || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return Date.parse(value)
    return parseInstantValue(value)
  }

  if (!parsedRule) {
    if (startParts) {
      const dtstartMs = allDay ? NaN : parseInstantMs(input.dtstart, startParts.isZoned)
      if (
        exdateSet.days.has(startParts.day)
        || (!allDay && Number.isFinite(dtstartMs) && exdateSet.instants.has(dtstartMs))
      ) {
        return []
      }
    }
    const inclusiveEnd = allDay && input.dtend
      ? inclusiveEndForAllDay(input.dtstart.slice(0, 10), input.dtend.slice(0, 10))
      : undefined
    if (!overlapsWindow(input.dtstart, input.dtend, allDay, input.windowStart, input.windowEnd)) {
      return []
    }
    return [{
      start: input.dtstart,
      end: input.dtend,
      inclusiveEndDate: inclusiveEnd,
    }]
  }

  if (!startParts) return []

  const durationDays = allDay ? computeAllDayDurationDays(input.dtstart, input.dtend) : 0
  const timedDurationMs = !allDay && input.dtend
    ? Math.max(0, parseInstantMs(input.dtend, startParts.isZoned) - parseInstantMs(input.dtstart, startParts.isZoned))
    : 0
  const hasEnd = Boolean(input.dtend)
  const maxOccurrences = input.maxOccurrences ?? DEFAULT_MAX_OCCURRENCES
  const maxScanIterations = Math.max(maxOccurrences * 20, 10_000)

  const untilMs = parsedRule.until
    ? (/^\d{4}-\d{2}-\d{2}$/.test(parsedRule.until)
      ? (allDay || !startParts.isZoned
        ? Date.parse(`${parsedRule.until}T23:59:59.999Z`)
        : fromZonedTime(`${parsedRule.until}T23:59:59.999`, tz).getTime())
      : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}$/.test(parsedRule.until)
        ? (startParts.isZoned
          ? fromZonedTime(parsedRule.until.replace(" ", "T"), tz).getTime()
          : parseInstantValue(parsedRule.until))
        : Date.parse(parsedRule.until))
    : null

  const occurrences: ExpandedOccurrence[] = []
  let cursor: Date | null | undefined = parseCalendarDay(startParts.day)
  if (!cursor) return []
  // MONTHLY and YEARLY rules are expanded per month from the start day, which keeps
  // ordinals (2TU), BYMONTHDAY, BYSETPOS and month-end days exact.
  const monthDays = parsedRule.freq === "MONTHLY" || parsedRule.freq === "YEARLY"
    ? monthBasedDays(parsedRule, startParts.day)
    : null
  if (monthDays) {
    const first = monthDays.next()
    cursor = first.done ? null : parseCalendarDay(first.value)
  }

  // COUNT counts every instance from DTSTART. The output cap counts only instances
  // inside the window, so a long-running series still expands in the current window.
  // Advance cursor dates without UNTIL so positive-UTC offsets do not cut off the last local day early;
  // occStartMs > untilMs below enforces the exact zoned instant cutoff.
  const { until: _omitUntil, ...cursorRule } = parsedRule
  let totalGenerated = 0
  let countedInstances = 0

  while (cursor && occurrences.length < maxOccurrences && totalGenerated < maxScanIterations) {
    if (parsedRule.count !== undefined && countedInstances >= parsedRule.count) break

    const occDay = cursor.toISOString().slice(0, 10)
    const occStart = allDay
      ? occDay
      : buildOccurrenceTimestamp(occDay, startParts.timeStr, startParts.isZoned, tz)
    const occStartMs = allDay
      ? Date.parse(`${occDay}T00:00:00Z`)
      : parseInstantMs(occStart, startParts.isZoned)

    if (untilMs !== null && !Number.isNaN(untilMs) && occStartMs > untilMs) break
    if (occStartMs > input.windowEnd.getTime()) break

    let occEnd: string | undefined
    let occInclusiveEnd: string | undefined
    if (allDay) {
      if (hasEnd) {
        occEnd = shiftCalendarDay(occDay, durationDays)
        occInclusiveEnd = inclusiveEndForAllDay(occDay, occEnd)
      } else {
        occInclusiveEnd = occDay
      }
    } else if (hasEnd) {
      const endInstant = new Date(occStartMs + timedDurationMs)
      occEnd = startParts.isZoned
        ? endInstant.toISOString().replace(/\.\d{3}Z$/, "Z")
        : endInstant.toISOString().slice(0, 19)
    }

    // BYxxx parts limit DAILY and WEEKLY rules (RFC 5545 §3.3.10): "every weekday",
    // "every Tuesday from April to October", "every day on the 1st and 15th".
    // MONTHLY and YEARLY candidates already apply them in monthCandidateDays.
    const weekdayFiltered = !monthDays && isLimitedOut(parsedRule, cursor)
    const isExcluded = weekdayFiltered || exdateSet.days.has(occDay) || (!allDay && exdateSet.instants.has(occStartMs))
    if (!isExcluded && overlapsWindow(occStart, occEnd, allDay, input.windowStart, input.windowEnd)) {
      occurrences.push({
        start: occStart,
        end: occEnd,
        inclusiveEndDate: occInclusiveEnd,
      })
    }

    totalGenerated++
    if (!weekdayFiltered) countedInstances++
    if (monthDays) {
      const next = monthDays.next()
      cursor = next.done ? null : parseCalendarDay(next.value)
    } else {
      cursor = getNextOccurrence(cursorRule, cursor, countedInstances)
    }
  }

  return occurrences
}

/** Check whether an RRULE starting at `dtstart` has an active occurrence on `targetDay` (YYYY-MM-DD). */
export function matchesRRuleOnDate(
  rrule: string,
  dtstart: string,
  targetDay: string,
  exdates?: string[],
  timezone = "Europe/Dublin",
): boolean {
  const startDay = parseCalendarDay(targetDay)
  if (!startDay) return false
  const windowStart = new Date(startDay.getTime() - DAY_MS)
  const windowEnd = new Date(startDay.getTime() + 2 * DAY_MS - 1)
  const hits = expandRRuleOccurrences({
    dtstart,
    rrule,
    exdates,
    windowStart,
    windowEnd,
    timezone,
  })
  return hits.some(h => calendarDayFromInput(h.start, timezone) === targetDay)
}
