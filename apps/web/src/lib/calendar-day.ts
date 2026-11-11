import type { Locale } from "./locale"

// CLDR 46.1 Gregorian month abbreviations for Irish. See public/licenses/unicode-cldr.txt.
const irishMonths = ["Ean", "Feabh", "Márta", "Aib", "Beal", "Meith", "Iúil", "Lún", "MFómh", "DFómh", "Samh", "Noll"]

const monthDayOptions = { month: "short", day: "numeric", timeZone: "UTC" } as const
let englishDate: Intl.DateTimeFormat | undefined
let englishMonthDay: Intl.DateTimeFormat | undefined
let browserMonthDay: Intl.DateTimeFormat | undefined

export function readStoredCalendarDay(value: string | null): string | undefined {
  return value?.match(/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}(?=$|[Tt\s])/u)?.[0]
}

/** Format the stored calendar day without shifting it to the server or browser time zone. */
export function formatCalendarDay(value: string | null, locale: Locale | undefined, includeYear = false): string | undefined {
  const day = readStoredCalendarDay(value)
  const separator = value?.[10]
  if (day?.length !== 10 || (separator !== undefined && separator !== "T" && separator !== " ")) return

  const date = new Date(day + "T00:00:00Z")
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return

  // The Home Assistant image ships with English-only ICU data.
  if (locale === "ga") {
    const monthDay = `${date.getUTCDate()} ${irishMonths[date.getUTCMonth()]}`
    return includeYear ? `${monthDay} ${date.getUTCFullYear()}` : monthDay
  }

  if (includeYear) {
    return (englishDate ??= new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" })).format(date)
  }

  const formatter = locale === "en"
    ? (englishMonthDay ??= new Intl.DateTimeFormat("en-IE", monthDayOptions))
    : (browserMonthDay ??= new Intl.DateTimeFormat(undefined, monthDayOptions))
  return formatter.format(date)
}
