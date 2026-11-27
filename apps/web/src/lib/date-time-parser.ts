/**
 * Pure Date & Time Parser/Formatter for Meitheal's unified Tabler Date+Time Picker.
 *
 * Zero DOM dependencies — unit-tested directly via `node:test`.
 * Conforms to user's regional Settings (`date_format` and `week_start`).
 *
 * @domain tasks (shared utility)
 */

export type DateFormatSetting = "relative" | "absolute-iso" | "absolute-eu" | "absolute-us"
export type WeekStartSetting = "monday" | "sunday" | "saturday"

const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/
const ISO_DATETIME_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/
const TIME_SUFFIX_RE = /(?:,|\s+at|\s+T|\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i
const SLASH_DATE_RE = /^(\d{1,4})\/(\d{1,2})\/(\d{2,4})$/

const MONTH_NAMES: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

const VALID_DATE_FORMATS = new Set<DateFormatSetting>(["relative", "absolute-iso", "absolute-eu", "absolute-us"])
const VALID_WEEK_STARTS = new Set<WeekStartSetting>(["monday", "sunday", "saturday"])

export function normalizeDateFormatSetting(value: unknown): DateFormatSetting {
  if (typeof value === "string" && VALID_DATE_FORMATS.has(value as DateFormatSetting)) {
    return value as DateFormatSetting
  }
  return "relative"
}

export function normalizeWeekStartSetting(value: unknown): WeekStartSetting {
  if (typeof value === "string" && VALID_WEEK_STARTS.has(value as WeekStartSetting)) {
    return value as WeekStartSetting
  }
  return "monday"
}

export function readActiveDateFormat(): DateFormatSetting {
  if (typeof window !== "undefined") {
    const winFmt = (window as Window & { mSettings?: { dateFormat?: string } }).mSettings?.dateFormat
    if (winFmt && VALID_DATE_FORMATS.has(winFmt as DateFormatSetting)) {
      return winFmt as DateFormatSetting
    }
    try {
      const stored = window.localStorage?.getItem("meitheal-date-format")
      if (stored && VALID_DATE_FORMATS.has(stored as DateFormatSetting)) {
        return stored as DateFormatSetting
      }
    } catch { /* localStorage unavailable */ }
  }
  return "relative"
}

export function readActiveWeekStart(): WeekStartSetting {
  if (typeof window !== "undefined") {
    const winWs = (window as Window & { mSettings?: { weekStart?: string } }).mSettings?.weekStart
    if (winWs && VALID_WEEK_STARTS.has(winWs as WeekStartSetting)) {
      return winWs as WeekStartSetting
    }
    try {
      const stored = window.localStorage?.getItem("meitheal-week-start")
      if (stored && VALID_WEEK_STARTS.has(stored as WeekStartSetting)) {
        return stored as WeekStartSetting
      }
    } catch { /* localStorage unavailable */ }
  }
  return "monday"
}

const SHORT_DOW_FROM_SUN = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const

export function getWeekStartDayIndex(weekStart: WeekStartSetting = readActiveWeekStart()): number {
  if (weekStart === "sunday") return 0
  if (weekStart === "saturday") return 6
  return 1
}

export function getWeekdayShortLabels(weekStart: WeekStartSetting = readActiveWeekStart()): string[] {
  const start = getWeekStartDayIndex(weekStart)
  return Array.from({ length: 7 }, (_, i) => SHORT_DOW_FROM_SUN[(start + i) % 7]!)
}

export interface CalendarGridCell {
  date: Date
  isOutside: boolean
}

/**
 * Build a fixed 42-cell (6 rows × 7 columns) calendar grid for any month.
 * Fixed 6-row geometry prevents vertical modal jumping across 4-, 5-, and 6-week months.
 */
export function buildCalendarMonthCells(
  year: number,
  month: number,
  weekStart: WeekStartSetting = "monday",
): CalendarGridCell[] {
  const firstDay = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const startDayIdx = getWeekStartDayIndex(weekStart)
  const startOffset = (firstDay.getDay() - startDayIdx + 7) % 7

  const cells: CalendarGridCell[] = []
  for (let i = 0; i < startOffset; i++) {
    cells.push({
      date: new Date(year, month, -(startOffset - i - 1)),
      isOutside: true,
    })
  }
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push({
      date: new Date(year, month, day),
      isOutside: false,
    })
  }
  const trailing = 42 - cells.length
  for (let i = 1; i <= trailing; i++) {
    cells.push({
      date: new Date(year, month + 1, i),
      isOutside: true,
    })
  }
  return cells
}

function buildValidLocalDate(year: number, monthIndex: number, day: number, hours = 0, minutes = 0): Date | null {
  if (
    !Number.isInteger(year) || year < 1000 || year > 9999 ||
    !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11 ||
    !Number.isInteger(day) || day < 1 || day > 31 ||
    !Number.isInteger(hours) || hours < 0 || hours > 23 ||
    !Number.isInteger(minutes) || minutes < 0 || minutes > 59
  ) {
    return null
  }
  const date = new Date(year, monthIndex, day, hours, minutes, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null
  }
  return date
}

export function parseIsoDateLocal(value: string | null | undefined): Date | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const dateMatch = ISO_DATE_RE.exec(trimmed)
  if (dateMatch) {
    return buildValidLocalDate(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))
  }

  const dtMatch = ISO_DATETIME_RE.exec(trimmed)
  if (dtMatch) {
    return buildValidLocalDate(
      Number(dtMatch[1]),
      Number(dtMatch[2]) - 1,
      Number(dtMatch[3]),
      Number(dtMatch[4]),
      Number(dtMatch[5]),
    )
  }

  return null
}

export function formatIsoDateLocal(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0")
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function formatTimeHHMM(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

export function formatTime12Hour(date: Date): string {
  const rawHours = date.getHours()
  const period = rawHours >= 12 ? "PM" : "AM"
  const hours12 = rawHours % 12 || 12
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${hours12}:${minutes} ${period}`
}

export function formatIsoDateTimeLocal(date: Date): string {
  return `${formatIsoDateLocal(date)}T${formatTimeHHMM(date)}`
}

export function hasNonMidnightTime(date: Date): boolean {
  return date.getHours() !== 0 || date.getMinutes() !== 0
}

/**
 * Format a date (and optional time) conforming to the active Settings `date_format`:
 * - `absolute-iso`: `YYYY-MM-DD` / `YYYY-MM-DD HH:MM`
 * - `absolute-eu`: `DD/MM/YYYY` / `DD/MM/YYYY, HH:MM`
 * - `absolute-us`: `MM/DD/YYYY` / `MM/DD/YYYY, h:MM AM/PM`
 * - `relative`: `24 Nov 2026` / `24 Nov 2026, HH:MM`
 */
export function formatTablerDateDisplay(
  date: Date,
  includeTime = false,
  dateFormat: DateFormatSetting = readActiveDateFormat(),
): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0")
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")

  if (dateFormat === "absolute-iso") {
    const base = `${yyyy}-${mm}-${dd}`
    return includeTime ? `${base} ${formatTimeHHMM(date)}` : base
  }
  if (dateFormat === "absolute-eu") {
    const base = `${dd}/${mm}/${yyyy}`
    return includeTime ? `${base}, ${formatTimeHHMM(date)}` : base
  }
  if (dateFormat === "absolute-us") {
    const base = `${mm}/${dd}/${yyyy}`
    return includeTime ? `${base}, ${formatTime12Hour(date)}` : base
  }

  const datePart = date.toLocaleDateString("en-IE", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
  if (!includeTime) return datePart
  return `${datePart}, ${formatTimeHHMM(date)}`
}

/** Format a compact date hint for quick presets conforming to `date_format`. */
export function formatQuickDateSublabel(
  date: Date,
  dateFormat: DateFormatSetting = readActiveDateFormat(),
): string {
  const yyyy = String(date.getFullYear()).padStart(4, "0")
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  if (dateFormat === "absolute-iso") return `${yyyy}-${mm}-${dd}`
  if (dateFormat === "absolute-eu") return `${dd}/${mm}`
  if (dateFormat === "absolute-us") return `${mm}/${dd}`
  return date.toLocaleDateString("en-IE", { day: "numeric", month: "short" })
}

/** Return an example placeholder matching the user's active `date_format` setting. */
export function getDateInputPlaceholder(
  enableTime: boolean,
  dateFormat: DateFormatSetting = readActiveDateFormat(),
): string {
  if (dateFormat === "absolute-iso") return enableTime ? "YYYY-MM-DD HH:MM" : "YYYY-MM-DD"
  if (dateFormat === "absolute-eu") return enableTime ? "DD/MM/YYYY, HH:MM" : "DD/MM/YYYY"
  if (dateFormat === "absolute-us") return enableTime ? "MM/DD/YYYY, h:MM AM" : "MM/DD/YYYY"
  return enableTime ? "Select date & time" : "Select date"
}

function parseTimeToken(hoursRaw: string, minutesRaw: string | undefined, meridiemRaw: string | undefined): { hours: number; minutes: number } | null {
  let hours = Number(hoursRaw)
  const minutes = minutesRaw !== undefined ? Number(minutesRaw) : 0
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null

  const meridiem = meridiemRaw?.toLowerCase()
  if (meridiem === "am" || meridiem === "pm") {
    if (hours < 1 || hours > 12) return null
    if (meridiem === "am" && hours === 12) hours = 0
    else if (meridiem === "pm" && hours !== 12) hours += 12
  } else {
    if (hours < 0 || hours > 23) return null
  }
  return { hours, minutes }
}

function parseDatePart(rawDate: string, now: Date, dateFormat: DateFormatSetting): Date | null {
  const s = rawDate.trim().replace(/,+$/, "").trim()
  if (!s) return null
  const lower = s.toLowerCase()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (lower === "today") return today
  if (lower === "tomorrow" || lower === "tmrw") {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
  }
  if (lower === "yesterday") {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  }
  if (lower === "next week") {
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)
  }

  // ISO YYYY-MM-DD
  const iso = ISO_DATE_RE.exec(s)
  if (iso) {
    return buildValidLocalDate(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
  }

  // Slash dates: YYYY/MM/DD or DD/MM/YYYY or MM/DD/YYYY (respects dateFormat when ambiguous)
  const slash = SLASH_DATE_RE.exec(s)
  if (slash) {
    const p1 = Number(slash[1])
    const p2 = Number(slash[2])
    const p3 = Number(slash[3])
    if (slash[1]!.length === 4) {
      return buildValidLocalDate(p1, p2 - 1, p3)
    }
    const year = p3 < 100 ? 2000 + p3 : p3
    if (p1 > 12) return buildValidLocalDate(year, p2 - 1, p1)
    if (p2 > 12) return buildValidLocalDate(year, p1 - 1, p2)
    if (dateFormat === "absolute-us") {
      return buildValidLocalDate(year, p1 - 1, p2)
    }
    return buildValidLocalDate(year, p2 - 1, p1)
  }

  // "24 Nov 2026" or "24 Nov"
  const dayFirst = /^(\d{1,2})\s+([a-z]+)(?:[\s,]+(\d{2,4}))?$/i.exec(s)
  if (dayFirst) {
    const month = MONTH_NAMES[dayFirst[2]!.toLowerCase()]
    if (month !== undefined) {
      const year = dayFirst[3]
        ? (dayFirst[3].length === 2 ? 2000 + Number(dayFirst[3]) : Number(dayFirst[3]))
        : today.getFullYear()
      return buildValidLocalDate(year, month, Number(dayFirst[1]))
    }
  }

  // "Nov 24 2026" or "Nov 24, 2026" or "Nov 24"
  const monthFirst = /^([a-z]+)\s+(\d{1,2})(?:[\s,]+(\d{2,4}))?$/i.exec(s)
  if (monthFirst) {
    const month = MONTH_NAMES[monthFirst[1]!.toLowerCase()]
    if (month !== undefined) {
      const year = monthFirst[3]
        ? (monthFirst[3].length === 2 ? 2000 + Number(monthFirst[3]) : Number(monthFirst[3]))
        : today.getFullYear()
      return buildValidLocalDate(year, month, Number(monthFirst[2]))
    }
  }

  return null
}

export interface ParsedFlexibleDate {
  date: Date
  hasTime: boolean
}

export interface FlexibleParseOptions {
  enableTime?: boolean
  now?: Date
  dateFormat?: DateFormatSetting
}

/**
 * Parse flexible user-typed date and optional time strings.
 * Supports ISO (`2026-11-24`, `2026-11-24 14:30`, `2026-11-24T14:30`),
 * natural dates (`24 Nov 2026`, `Nov 24 2:30pm`), slash dates (`24/11/2026` or `11/24/2026`),
 * and relative shorthands (`today`, `tomorrow 9am`).
 */
export function parseFlexibleDateInput(
  raw: string,
  options: FlexibleParseOptions = {},
): ParsedFlexibleDate | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const now = options.now ?? new Date()
  const enableTime = Boolean(options.enableTime)
  const dateFormat = options.dateFormat ?? readActiveDateFormat()

  // Fast path for strict ISO datetime
  const strictDt = ISO_DATETIME_RE.exec(trimmed)
  if (strictDt) {
    const date = buildValidLocalDate(
      Number(strictDt[1]),
      Number(strictDt[2]) - 1,
      Number(strictDt[3]),
      enableTime ? Number(strictDt[4]) : 0,
      enableTime ? Number(strictDt[5]) : 0,
    )
    return date ? { date, hasTime: enableTime } : null
  }

  // Try pure date first
  const directDate = parseDatePart(trimmed, now, dateFormat)
  if (directDate) {
    return { date: directDate, hasTime: false }
  }

  // Try splitting trailing time expression (e.g. "24 Nov 2026, 14:30", "11/24/2026, 2:30 PM", "tomorrow 9am")
  const timeMatch = TIME_SUFFIX_RE.exec(trimmed)
  if (timeMatch && (timeMatch[2] !== undefined || timeMatch[3] !== undefined)) {
    const dateSegment = trimmed.slice(0, timeMatch.index).trim()
    const timeVal = parseTimeToken(timeMatch[1]!, timeMatch[2], timeMatch[3])
    if (dateSegment && timeVal) {
      const base = parseDatePart(dateSegment, now, dateFormat)
      if (base) {
        const result = buildValidLocalDate(
          base.getFullYear(),
          base.getMonth(),
          base.getDate(),
          enableTime ? timeVal.hours : 0,
          enableTime ? timeVal.minutes : 0,
        )
        return result ? { date: result, hasTime: enableTime } : null
      }
    }
  }

  return null
}
