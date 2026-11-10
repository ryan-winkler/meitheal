/**
 * CalDAV Client — Unit Tests
 *
 * Tests SSRF URL validation, iCalendar parsing, and date format handling.
 *
 * @domain calendar
 * @bounded-context integration
 */
import { expect, test } from "@playwright/test"

// ── SSRF URL Validation ──

const PRIVATE_RANGES = [
  /^127\.\d+\.\d+\.\d+$/,       // loopback
  /^10\.\d+\.\d+\.\d+$/,         // 10.x.x.x
  /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16-31.x.x
  /^192\.168\./,                  // 192.168.x.x
  /^0\.0\.0\.0$/,                 // unspecified
  /^169\.254\./,                  // link-local
  /^fc00:/i,                      // IPv6 ULA
  /^fe80:/i,                      // IPv6 link-local
  /^::1$/,                        // IPv6 loopback
]

function isPrivateIP(host: string): boolean {
  return PRIVATE_RANGES.some((re) => re.test(host))
}

function validateCalDAVUrl(url: string, isProduction: boolean): { ok: boolean; error?: string } {
  try {
    const parsed = new URL(url)
    if (isProduction && parsed.protocol !== "https:") {
      return { ok: false, error: "HTTPS required in production" }
    }
    if (parsed.hostname === "localhost" || isPrivateIP(parsed.hostname)) {
      return { ok: false, error: "Private/localhost URLs not allowed" }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: "Invalid URL" }
  }
}

// ── iCal Parsing ──

interface ParsedEvent {
  uid?: string
  summary?: string
  dtstart?: string
  dtend?: string
  description?: string
  location?: string
}

function parseICalEvents(icalData: string): ParsedEvent[] {
  const events: ParsedEvent[] = []
  const vevents = icalData.split("BEGIN:VEVENT")
  for (let i = 1; i < vevents.length; i++) {
    const block = vevents[i]!.split("END:VEVENT")[0]!
    const event: ParsedEvent = {}
    const lines = block.split(/\r?\n/)
    for (const line of lines) {
      const colonIdx = line.indexOf(":")
      if (colonIdx === -1) continue
      // Handle properties with parameters (e.g., DTSTART;VALUE=DATE:20250115)
      const rawKey = line.slice(0, colonIdx)
      const key = rawKey.split(";")[0]!.trim()
      const value = line.slice(colonIdx + 1).trim()
      switch (key) {
        case "UID": event.uid = value; break
        case "SUMMARY": event.summary = value; break
        case "DTSTART": event.dtstart = value; break
        case "DTEND": event.dtend = value; break
        case "DESCRIPTION": event.description = value; break
        case "LOCATION": event.location = value; break
      }
    }
    if (event.uid || event.summary) events.push(event)
  }
  return events
}

// ── Tests ──

test("SSRF: blocks localhost URLs", () => {
  const result = validateCalDAVUrl("https://localhost/caldav", false)
  expect(result.ok).toBe(false)
  expect(result.error).toContain("Private")
})

test("SSRF: blocks private IP ranges", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1"]) {
    const result = validateCalDAVUrl(`https://${ip}/caldav`, false)
    expect(result.ok).toBe(false)
  }
})

test("SSRF: allows public URLs", () => {
  const result = validateCalDAVUrl("https://caldav.example.com/calendar", false)
  expect(result.ok).toBe(true)
})

test("SSRF: production requires HTTPS", () => {
  const httpResult = validateCalDAVUrl("http://caldav.example.com/calendar", true)
  expect(httpResult.ok).toBe(false)
  expect(httpResult.error).toContain("HTTPS")

  const httpsResult = validateCalDAVUrl("https://caldav.example.com/calendar", true)
  expect(httpsResult.ok).toBe(true)
})

test("SSRF: rejects invalid URLs", () => {
  const result = validateCalDAVUrl("not-a-url", false)
  expect(result.ok).toBe(false)
})

test("iCal: parses single timed event", () => {
  const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:ev-1@example.com
SUMMARY:Team Meeting
DTSTART:20250115T100000Z
DTEND:20250115T110000Z
DESCRIPTION:Weekly standup
LOCATION:Office
END:VEVENT
END:VCALENDAR`

  const events = parseICalEvents(ical)
  expect(events).toHaveLength(1)
  expect(events[0]!.uid).toBe("ev-1@example.com")
  expect(events[0]!.summary).toBe("Team Meeting")
  expect(events[0]!.dtstart).toBe("20250115T100000Z")
  expect(events[0]!.description).toBe("Weekly standup")
  expect(events[0]!.location).toBe("Office")
})

test("iCal: parses all-day event with VALUE=DATE", () => {
  const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:ev-2@example.com
SUMMARY:Holiday
DTSTART;VALUE=DATE:20250115
DTEND;VALUE=DATE:20250116
END:VEVENT
END:VCALENDAR`

  const events = parseICalEvents(ical)
  expect(events).toHaveLength(1)
  expect(events[0]!.dtstart).toBe("20250115")
  expect(events[0]!.dtend).toBe("20250116")
})

test("iCal: parses multiple events in one calendar", () => {
  const ical = `BEGIN:VCALENDAR
BEGIN:VEVENT
UID:ev-a
SUMMARY:Event A
DTSTART:20250115T080000Z
DTEND:20250115T090000Z
END:VEVENT
BEGIN:VEVENT
UID:ev-b
SUMMARY:Event B
DTSTART:20250115T140000Z
DTEND:20250115T150000Z
END:VEVENT
BEGIN:VEVENT
UID:ev-c
SUMMARY:Event C
DTSTART:20250116T080000Z
DTEND:20250116T090000Z
END:VEVENT
END:VCALENDAR`

  const events = parseICalEvents(ical)
  expect(events).toHaveLength(3)
  expect(events.map((e) => e.summary)).toEqual(["Event A", "Event B", "Event C"])
})

test("iCal: handles empty calendar gracefully", () => {
  const ical = "BEGIN:VCALENDAR\nEND:VCALENDAR"
  const events = parseICalEvents(ical)
  expect(events).toHaveLength(0)
})
