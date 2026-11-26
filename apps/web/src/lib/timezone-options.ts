/**
 * Timezone option catalog with live GMT offset formatting for Settings.
 *
 * Uses `Intl.supportedValuesOf("timeZone")` when available and falls back to
 * a comprehensive curated global IANA catalog so every option displays a
 * Google-style `City, Region — Zone Name (GMT±HH:MM)` label.
 */

export interface TimezoneOption {
  value: string
  label: string
  offsetLabel: string
  offsetMinutes: number
  searchText: string
}

const FALLBACK_TIMEZONES = [
  "Pacific/Midway",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Denver",
  "America/Chicago",
  "America/Mexico_City",
  "America/New_York",
  "America/Toronto",
  "America/Halifax",
  "America/St_Johns",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Atlantic/Azores",
  "UTC",
  "Europe/Dublin",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Helsinki",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Europe/Istanbul",
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Kathmandu",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Adelaide",
  "Australia/Brisbane",
  "Australia/Sydney",
  "Pacific/Auckland",
] as const

const COUNTRY_HINTS: Record<string, string> = {
  "Europe/Dublin": "Dublin, Ireland",
  "Europe/London": "London, United Kingdom",
  "Europe/Lisbon": "Lisbon, Portugal",
  "Europe/Paris": "Paris, France",
  "Europe/Berlin": "Berlin, Germany",
  "Europe/Madrid": "Madrid, Spain",
  "Europe/Rome": "Rome, Italy",
  "Europe/Amsterdam": "Amsterdam, Netherlands",
  "Europe/Brussels": "Brussels, Belgium",
  "Europe/Zurich": "Zurich, Switzerland",
  "Europe/Vienna": "Vienna, Austria",
  "Europe/Stockholm": "Stockholm, Sweden",
  "Europe/Oslo": "Oslo, Norway",
  "Europe/Copenhagen": "Copenhagen, Denmark",
  "Europe/Helsinki": "Helsinki, Finland",
  "Europe/Warsaw": "Warsaw, Poland",
  "Europe/Prague": "Prague, Czechia",
  "Europe/Athens": "Athens, Greece",
  "America/New_York": "New York, United States",
  "America/Chicago": "Chicago, United States",
  "America/Denver": "Denver, United States",
  "America/Los_Angeles": "Los Angeles, United States",
  "America/Phoenix": "Phoenix, United States",
  "America/Anchorage": "Anchorage, United States",
  "Pacific/Honolulu": "Honolulu, United States",
  "America/Toronto": "Toronto, Canada",
  "America/Vancouver": "Vancouver, Canada",
  "America/Mexico_City": "Mexico City, Mexico",
  "America/Sao_Paulo": "São Paulo, Brazil",
  "America/Argentina/Buenos_Aires": "Buenos Aires, Argentina",
  "Asia/Tokyo": "Tokyo, Japan",
  "Asia/Seoul": "Seoul, South Korea",
  "Asia/Shanghai": "Shanghai, China",
  "Asia/Hong_Kong": "Hong Kong",
  "Asia/Singapore": "Singapore",
  "Asia/Kolkata": "Mumbai / New Delhi, India",
  "Asia/Dubai": "Dubai, United Arab Emirates",
  "Australia/Sydney": "Sydney, Australia",
  "Australia/Melbourne": "Melbourne, Australia",
  "Pacific/Auckland": "Auckland, New Zealand",
  UTC: "Coordinated Universal Time",
}

function parseGmtOffsetMinutes(offsetText: string): number {
  if (!offsetText || offsetText === "GMT" || offsetText === "UTC") return 0
  const match = /GMT([+-])(\d{1,2})(?::?(\d{2}))?/.exec(offsetText)
  if (!match) return 0
  const sign = match[1] === "-" ? -1 : 1
  const hours = Number.parseInt(match[2] ?? "0", 10)
  const mins = Number.parseInt(match[3] ?? "0", 10)
  return sign * (hours * 60 + mins)
}

export function formatGmtOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+"
  const abs = Math.abs(minutes)
  const hours = String(Math.floor(abs / 60)).padStart(2, "0")
  const mins = String(abs % 60).padStart(2, "0")
  return `GMT${sign}${hours}:${mins}`
}

function resolveTimezoneMeta(tz: string, refDate: Date, locale = "en"): {
  offsetLabel: string
  offsetMinutes: number
  zoneName: string
} {
  try {
    const offsetParts = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(refDate)
    const rawOffset = offsetParts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00"
    const offsetMinutes = parseGmtOffsetMinutes(rawOffset)
    const offsetLabel = formatGmtOffset(offsetMinutes)

    const longParts = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      timeZoneName: "long",
    }).formatToParts(refDate)
    const zoneName = longParts.find((part) => part.type === "timeZoneName")?.value ?? tz
    return { offsetLabel, offsetMinutes, zoneName }
  } catch {
    return { offsetLabel: "GMT+00:00", offsetMinutes: 0, zoneName: tz }
  }
}

function friendlyPlaceLabel(tz: string): string {
  if (COUNTRY_HINTS[tz]) return COUNTRY_HINTS[tz]
  const parts = tz.split("/")
  if (parts.length === 1) return tz.replace(/_/g, " ")
  const city = parts[parts.length - 1]!.replace(/_/g, " ")
  const region = parts.slice(0, -1).map((segment) => segment.replace(/_/g, " ")).join(" / ")
  return `${city} (${region})`
}

export function buildTimezoneOptions(locale = "en", refDate = new Date()): TimezoneOption[] {
  let rawZones: string[] = [...FALLBACK_TIMEZONES]
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone")
    if (Array.isArray(supported) && supported.length > 0) {
      rawZones = supported.includes("UTC") ? supported : ["UTC", ...supported]
    }
  } catch {
    // Fallback list above covers all primary global zones.
  }

  const seen = new Set<string>()
  const options: TimezoneOption[] = []

  for (const tz of rawZones) {
    if (!tz || seen.has(tz)) continue
    seen.add(tz)
    const { offsetLabel, offsetMinutes, zoneName } = resolveTimezoneMeta(tz, refDate, locale)
    const place = friendlyPlaceLabel(tz)
    const label = tz === "UTC"
      ? `(${offsetLabel}) UTC — Coordinated Universal Time`
      : `(${offsetLabel}) ${place} — ${zoneName}`
    options.push({
      value: tz,
      label,
      offsetLabel,
      offsetMinutes,
      searchText: `${tz} ${place} ${zoneName} ${offsetLabel}`.toLowerCase(),
    })
  }

  options.sort((a, b) => {
    if (a.offsetMinutes !== b.offsetMinutes) return a.offsetMinutes - b.offsetMinutes
    return a.label.localeCompare(b.label)
  })
  return options
}
