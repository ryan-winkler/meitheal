/**
 * CalDAV Client — Minimal server-side CalDAV sync
 *
 * Fetches events from external CalDAV servers (Nextcloud, Radicale, Baikal)
 * using native `fetch` — zero npm dependencies.
 *
 * Security:
 *   - SSRF protection: rejects private IPs, localhost, metadata URLs; every
 *     request goes through the shared outbound policy (checked again at
 *     connect time), and hrefs and redirects must stay on the configured origin
 *   - XXE prevention: safe XML parsing (no external entity resolution)
 *   - Timeout: 10s AbortController on all requests
 *
 * Protocol flow:
 *   1. PROPFIND Depth:1 → discover calendar collections
 *   2. REPORT calendar-query → fetch VEVENT within time range
 *   3. Parse iCalendar → extract event fields
 *
 * MVP scope:
 *   - VEVENT only (no VTODO, VJOURNAL)
 *   - Supports VEVENT recurrence expansion (RRULE / EXDATE)
 *   - Read-only (no write-back to CalDAV)
 *
 * @domain calendar
 * @bounded-context integration
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { classifyNetworkHost, fetchOutbound, normalizeNetworkHost } from "@meitheal/integration-core"
import { shiftCalendarDay } from "../../lib/date"
import { expandRRuleOccurrences, normalizeRRule, RecurrenceScanLimitError } from "./recurrence"

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["caldav", "calendar"],
  redactPatterns: [...defaultRedactionPatterns, /password=\S+/gi, /Authorization:\s*\S+/gi],
  auditEnabled: false,
})
const SYS_REQ = "caldav-system"

// ─── Types ──────────────────────────────────────────────────────────

export interface CalDAVConfig {
  url: string
  username: string
  password: string
}

export interface CalDAVCalendar {
  href: string
  displayName: string
  ctag?: string | undefined
  color?: string | undefined
}

export interface CalDAVEvent {
  uid: string
  summary: string
  dtstart: string
  dtend?: string | undefined
  duration?: string | undefined
  /** Inclusive end date (YYYY-MM-DD) for all-day events where iCal DTEND is exclusive */
  inclusiveEndDate?: string | undefined
  description?: string | undefined
  location?: string | undefined
  allDay: boolean
  rrule?: string | undefined
  exdates?: string[] | undefined
  recurrenceId?: string | undefined
  /** RECURRENCE-ID RANGE parameter: the override also applies to every later instance */
  recurrenceRange?: "THISANDFUTURE" | undefined
  tzid?: string | undefined
  cancelled?: boolean | undefined
  /** Raw href on the CalDAV server for dedup */
  href: string
}

// ─── SSRF Protection ────────────────────────────────────────────────

function isCgnatHost(hostname: string): boolean {
  const octets = hostname.split(".")
  if (
    octets.length === 4 &&
    octets.every((p) => p.length >= 1 && p.length <= 3 && [...p].every((c) => c >= "0" && c <= "9") && Number(p) <= 255)
  ) {
    const second = Number(octets[1])
    return Number(octets[0]) === 100 && second >= 64 && second <= 127
  }
  const tail = hostname.startsWith("::ffff:")
    ? hostname.slice(7)
    : hostname.startsWith("::")
      ? hostname.slice(2)
      : ""
  if (!tail) return false
  const parts = tail.split(":")
  if (
    parts.length !== 2 ||
    !parts.every((p) => p.length >= 1 && p.length <= 4 && [...p].every((c) => (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")))
  ) {
    return false
  }
  const hi = Number.parseInt(parts[0]!, 16)
  return (hi & 0xffc0) === 0x6440
}

/**
 * Validate a CalDAV URL for SSRF safety.
 * Rejects private IPs, localhost, metadata endpoints, and non-HTTPS in production.
 */
export function validateCalDAVUrl(rawUrl: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(rawUrl)

    // Must be HTTP(S)
    if (!["http:", "https:"].includes(url.protocol)) {
      return { valid: false, error: "Only HTTP/HTTPS protocols are allowed" }
    }

    const hostname = normalizeNetworkHost(url.hostname)
    const hostSafety = classifyNetworkHost(url.hostname)
    if (!hostname || hostSafety === "unconditional") {
      return { valid: false, error: `Hostname "${hostname}" is blocked for security` }
    }
    if (hostSafety === "private" || isCgnatHost(hostname)) {
      return { valid: false, error: "Private/internal IP addresses are not allowed" }
    }

    // Warn on HTTP (but allow for local testing)
    if (url.protocol === "http:" && process.env.NODE_ENV === "production") {
      return { valid: false, error: "HTTPS is required for CalDAV connections in production" }
    }

    return { valid: true }
  } catch {
    return { valid: false, error: "Invalid URL format" }
  }
}

// ─── HTTP Helpers ───────────────────────────────────────────────────

const TIMEOUT_MS = 10_000

/** Max response body size (5MB) — prevents OOM from oversized calendar responses */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64")
}

/** Most redirects a CalDAV request follows (all must stay on the configured origin). */
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Resolve a server-supplied href against the configured CalDAV URL and refuse
 * anything on another origin, so a server response cannot send the user's
 * credentials to a different host.
 */
export function resolveCalDAVHref(baseUrl: string, href: string): URL {
  const base = new URL(baseUrl)
  if ((base.protocol !== "http:" && base.protocol !== "https:") || base.origin === "null") {
    throw new Error("Only HTTP/HTTPS URLs are supported")
  }
  if (base.username || base.password) {
    throw new Error("CalDAV URL must not include embedded credentials")
  }
  const resolved = new URL(href, base)
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS URLs are supported")
  }
  if (resolved.username || resolved.password) {
    throw new Error("CalDAV href must not include embedded credentials")
  }
  if (resolved.protocol !== base.protocol || resolved.origin !== base.origin) {
    throw new Error(`CalDAV server returned an href on another origin (${resolved.origin})`)
  }
  return resolved
}

async function caldavFetch(
  url: string, method: string, body: string | null,
  username: string, password: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const urlCheck = validateCalDAVUrl(url)
  if (!urlCheck.valid) {
    throw new Error(`CalDAV URL validation failed: ${urlCheck.error}`)
  }
  const origin = new URL(url)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    let target = origin
    let currentMethod = method
    let currentBody = body
    let res: Response
    // Redirects are followed by hand so every hop stays on the configured
    // origin and passes both CalDAV and connect-time outbound checks before credentials are re-sent.
    for (let hop = 0; ; hop++) {
      const requestHeaders: Record<string, string> = {
        Authorization: basicAuthHeader(username, password),
        ...extraHeaders,
      }
      if (currentBody !== null) {
        requestHeaders["Content-Type"] = "application/xml; charset=utf-8"
      }
      res = await fetchOutbound(target, {
        method: currentMethod,
        headers: requestHeaders,
        body: currentBody,
        signal: controller.signal,
        redirect: "manual",
      })
      const location = res.headers.get("location")
      if (!REDIRECT_STATUSES.has(res.status) || !location) break
      await res.body?.cancel().catch(() => undefined)
      if (hop >= MAX_REDIRECTS) throw new Error(`CalDAV server redirected more than ${MAX_REDIRECTS} times`)
      const next = new URL(location, target)
      if (next.protocol !== origin.protocol || next.origin !== origin.origin) {
        throw new Error(`CalDAV server redirected to another origin (${next.origin}); update the CalDAV URL instead`)
      }
      const nextCheck = validateCalDAVUrl(next.toString())
      if (!nextCheck.valid) {
        throw new Error(nextCheck.error)
      }
      target = next
      if (res.status === 303) {
        currentMethod = "GET"
        currentBody = null
      }
    }

    // Guard: check Content-Length header before reading body
    const contentLength = res.headers.get("content-length")
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => undefined)
      throw new Error(`CalDAV response too large (${contentLength} bytes, max ${MAX_RESPONSE_BYTES})`)
    }

    const text = await res.text()

    // Guard: check actual body size after reading
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`CalDAV response body too large (${text.length} chars, max ${MAX_RESPONSE_BYTES})`)
    }

    return { status: res.status, text }
  } finally {
    clearTimeout(timeout)
  }
}

// ─── XML Parsing (XXE-safe) ─────────────────────────────────────────

const XML_NAMED_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" }

/**
 * Decode XML character data in one pass. SabreDAV servers (Nextcloud, Baïkal)
 * escape the CR of iCalendar CRLF line endings as `&#13;`, and `&amp;` appears in
 * hrefs and text, so RRULE, UNTIL and STATUS values must be decoded before parsing.
 */
export function decodeXmlText(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#x([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g, (match, dec, hex, named) => {
    if (named) return XML_NAMED_ENTITIES[named as string] ?? match
    const code = dec ? Number.parseInt(dec as string, 10) : Number.parseInt(hex as string, 16)
    if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match
    return String.fromCodePoint(code)
  })
}

function unwrapCdata(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
    return trimmed.slice(9, -3).trim()
  }
  return decodeXmlText(trimmed).trim()
}

/**
 * ASCII-only lowercase. `String#toLowerCase` can change the string length (for example
 * U+0130 becomes two code points), which would shift every offset taken from the
 * lowered copy and slice the original XML in the wrong place.
 */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32))
}

function isTagBoundaryChar(ch: string | undefined): boolean {
  return ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r"
}

function findNextOpenTag(lowerXml: string, localName: string, fromIndex: number): {
  contentStart: number
  selfClosing: boolean
  tagName: string
} | null {
  let cursor = fromIndex
  while (cursor < lowerXml.length) {
    const lt = lowerXml.indexOf("<", cursor)
    if (lt === -1) return null
    if (lowerXml.startsWith("</", lt) || lowerXml.startsWith("<!", lt) || lowerXml.startsWith("<?", lt)) {
      const close = lowerXml.indexOf(">", lt + 2)
      cursor = close === -1 ? lowerXml.length : close + 1
      continue
    }
    const gt = lowerXml.indexOf(">", lt + 1)
    if (gt === -1) return null
    const header = lowerXml.slice(lt + 1, gt)
    let endName = 0
    while (endName < header.length && !isTagBoundaryChar(header[endName])) {
      endName++
    }
    const fullTagName = header.slice(0, endName)
    const colonIdx = fullTagName.indexOf(":")
    const tagLocal = colonIdx === -1 ? fullTagName : fullTagName.slice(colonIdx + 1)
    if (tagLocal === localName) {
      const selfClosing = header.trimEnd().endsWith("/")
      return { contentStart: gt + 1, selfClosing, tagName: fullTagName }
    }
    cursor = gt + 1
  }
  return null
}

function extractTagContents(xml: string, localName: string): string[] {
  const lower = asciiLower(xml)
  const target = asciiLower(localName)
  const results: string[] = []
  // A closing tag missing after one opening tag is missing after every later one with the
  // same name, so remember it instead of rescanning the rest of the document each time.
  const unclosed = new Set<string>()
  let cursor = 0

  while (cursor < lower.length) {
    const open = findNextOpenTag(lower, target, cursor)
    if (!open) break
    if (open.selfClosing) {
      cursor = open.contentStart
      continue
    }
    if (unclosed.has(open.tagName)) {
      cursor = open.contentStart
      continue
    }
    const closeToken = `</${open.tagName}>`
    const closeIdx = lower.indexOf(closeToken, open.contentStart)
    if (closeIdx === -1) {
      unclosed.add(open.tagName)
      cursor = open.contentStart
      continue
    }
    results.push(xml.slice(open.contentStart, closeIdx))
    cursor = closeIdx + closeToken.length
  }

  return results
}

/**
 * Parse XML string safely with linear tag scanning to prevent XXE
 * declarations and regular-expression backtracking (ReDoS).
 */
export function extractXmlResponses(xml: string): Array<{ href: string; props: Record<string, string> }> {
  // Reject DOCTYPE/ENTITY declarations fail-closed (handles internal DTD subsets too).
  // CDATA sections are character data, not markup: an HTML invite description
  // (X-ALT-DESC "<!DOCTYPE HTML ...>") inside CDATA calendar-data is not a declaration.
  const markup = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(markup)) {
    throw new Error("Rejected CalDAV XML response containing unsafe DOCTYPE or ENTITY declaration")
  }

  const responses: Array<{ href: string; props: Record<string, string> }> = []
  for (const block of extractTagContents(xml, "response")) {
    const hrefRaw = extractTagContents(block, "href")[0]
    if (hrefRaw === undefined) continue

    const href = unwrapCdata(hrefRaw)
    const props: Record<string, string> = {}

    const dnRaw = extractTagContents(block, "displayname")[0]
    if (dnRaw !== undefined) props.displayname = unwrapCdata(dnRaw)

    const ctagRaw = extractTagContents(block, "getctag")[0]
    if (ctagRaw !== undefined) props.ctag = unwrapCdata(ctagRaw)

    const colorRaw = extractTagContents(block, "calendar-color")[0]
    if (colorRaw !== undefined) props.color = unwrapCdata(colorRaw)

    const calDataRaw = extractTagContents(block, "calendar-data")[0]
    if (calDataRaw !== undefined) props.calendarData = unwrapCdata(calDataRaw)

    if (findNextOpenTag(asciiLower(block), "calendar", 0) !== null) {
      props.isCalendar = "true"
    }

    responses.push({ href, props })
  }

  return responses
}

// ─── iCalendar Parsing ──────────────────────────────────────────────

function unescapeICalText(raw: string): string {
  return raw.replace(/\\([\\,;nN])/g, (_match, ch: string) => {
    if (ch === "n" || ch === "N") return "\n"
    return ch
  })
}

function parseICalPropertyLine(line: string): {
  name: string
  params: Record<string, string>
  value: string
} | null {
  // The name/value separator is the first colon outside a quoted parameter value
  // (DESCRIPTION;ALTREP="cid:part1@example.org":Meeting notes).
  let colonIdx = -1
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ":" && !quoted) {
      colonIdx = i
      break
    }
  }
  if (colonIdx === -1) return null

  const left = line.slice(0, colonIdx)
  const value = line.slice(colonIdx + 1).trim()
  const segments: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < left.length; i++) {
    const ch = left[i]!
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ";" && !inQuotes) {
      segments.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  segments.push(current)

  const name = segments[0]?.trim().toUpperCase()
  if (!name) return null

  const params: Record<string, string> = {}
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!
    const eqIdx = seg.indexOf("=")
    if (eqIdx === -1) continue
    const pKey = seg.slice(0, eqIdx).trim().toUpperCase()
    let pVal = seg.slice(eqIdx + 1).trim()
    if (pVal.startsWith('"') && pVal.endsWith('"') && pVal.length >= 2) {
      pVal = pVal.slice(1, -1)
    }
    if (pKey) params[pKey] = pVal
  }

  return { name, params, value }
}

function isValidTimeZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tzid })
    return true
  } catch {
    return false
  }
}

function safeTimeZone(tzid?: string): string {
  return tzid && isValidTimeZone(tzid) ? tzid : "UTC"
}

function eventEndFromDuration(start: string, duration: string, allDay: boolean, timezone: string): string | undefined {
  const parts = /^\+?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/i.exec(duration)
  if (!parts || /T$/i.test(duration) || (allDay && /T/i.test(duration))) return
  const [, weeks = "0", days = "0", hours = "0", minutes = "0", seconds = "0"] = parts
  const calendarDays = Number(weeks) * 7 + Number(days)
  const clockMs = (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000
  if (calendarDays === 0 && clockMs === 0) return

  try {
    // Weeks and days follow the calendar in the event's zone. The time part is elapsed time.
    const afterDays = calendarDays > 0 ? shiftWallClock(start, calendarDays * 86_400_000, timezone, allDay) : start
    if (clockMs === 0) return afterDays
    const zoned = /Z$/i.test(afterDays)
    const instant = Date.parse(zoned ? afterDays : `${afterDays}Z`)
    const end = new Date(instant + clockMs).toISOString().slice(0, 19)
    return zoned ? `${end}Z` : end
  } catch {
    // An out-of-range or malformed date must not discard the other events in the response.
    return undefined
  }
}

/**
 * Parse VEVENT blocks from iCalendar text.
 * Uses colon-safe property parsing (`indexOf(":")`), handles TZID, RRULE, EXDATE,
 * RECURRENCE-ID, DURATION, nested subcomponents (VALARM), and exclusive all-day ends.
 */
export function parseVEvents(ical: string, eventHref: string): CalDAVEvent[] {
  const events: CalDAVEvent[] = []

  // Unfold continuation lines (RFC 5545 §3.1)
  const unfolded = ical.replace(/\r?\n[ \t]/g, "")

  // Extract each VEVENT block
  const veventRegex = /BEGIN:VEVENT\b([\s\S]*?)END:VEVENT/gi
  let match

  while ((match = veventRegex.exec(unfolded)) !== null) {
    const block = match[1]!
    const lines = block.split(/\r?\n/)

    let uid: string | undefined
    let summary: string | undefined
    let dtstartRaw: string | undefined
    let dtstartParams: Record<string, string> = {}
    let dtendRaw: string | undefined
    let dtendParams: Record<string, string> = {}
    let duration: string | undefined
    let description: string | undefined
    let location: string | undefined
    let rrule: string | undefined
    let recurrenceIdRaw: string | undefined
    let recurrenceIdParams: Record<string, string> = {}
    let cancelled = false
    const exdates: string[] = []

    let nestedDepth = 0

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      if (/^BEGIN:/i.test(line)) {
        nestedDepth++
        continue
      }
      if (/^END:/i.test(line)) {
        nestedDepth = Math.max(0, nestedDepth - 1)
        continue
      }
      if (nestedDepth > 0) continue // Ignore VALARM or other nested subcomponents

      const prop = parseICalPropertyLine(line)
      if (!prop) continue

      switch (prop.name) {
        case "UID":
          uid = prop.value
          break
        case "SUMMARY":
          summary = unescapeICalText(prop.value)
          break
        case "DTSTART":
          dtstartRaw = prop.value
          dtstartParams = prop.params
          break
        case "DTEND":
          dtendRaw = prop.value
          dtendParams = prop.params
          break
        case "DURATION":
          duration = prop.value
          break
        case "DESCRIPTION":
          description = unescapeICalText(prop.value)
          break
        case "LOCATION":
          location = unescapeICalText(prop.value)
          break
        case "RRULE":
          rrule = normalizeRRule(prop.value) ?? undefined
          break
        case "RECURRENCE-ID":
          recurrenceIdRaw = prop.value
          recurrenceIdParams = prop.params
          break
        case "STATUS":
          if (prop.value.trim().toUpperCase() === "CANCELLED") cancelled = true
          break
        case "EXDATE": {
          const exIsDate = prop.params.VALUE?.toUpperCase() === "DATE"
          for (const item of prop.value.split(",")) {
            const trimmed = item.trim()
            if (!trimmed) continue
            const itemAllDay = exIsDate || (/^\d{8}$/.test(trimmed) && !trimmed.includes("T"))
            exdates.push(formatICalDate(trimmed, prop.params.TZID, itemAllDay))
          }
          break
        }
      }
    }

    const effectiveDtstartRaw = dtstartRaw ?? (cancelled ? recurrenceIdRaw : undefined)
    const effectiveDtstartParams = dtstartRaw ? dtstartParams : recurrenceIdParams
    if (!uid || !effectiveDtstartRaw || (!summary && !cancelled)) continue

    const allDay =
      effectiveDtstartParams.VALUE?.toUpperCase() === "DATE" ||
      (/^\d{8}$/.test(effectiveDtstartRaw) && !effectiveDtstartRaw.includes("T"))
    const rawTzid = effectiveDtstartParams.TZID
    const tzid = rawTzid && isValidTimeZone(rawTzid) ? rawTzid : undefined
    const dtstart = formatICalDate(effectiveDtstartRaw, tzid, allDay)

    let dtend: string | undefined
    if (dtendRaw) {
      const endAllDay =
        allDay ||
        dtendParams.VALUE?.toUpperCase() === "DATE" ||
        (/^\d{8}$/.test(dtendRaw) && !dtendRaw.includes("T"))
      dtend = formatICalDate(dtendRaw, dtendParams.TZID ?? tzid, endAllDay)
    } else if (duration) {
      dtend = eventEndFromDuration(dtstart, duration, allDay, safeTimeZone(tzid))
    }
    const inclusiveEndDate = allDay ? (dtend && dtend > dtstart ? shiftCalendarDay(dtend, -1) : dtstart) : undefined

    let recurrenceId: string | undefined
    if (recurrenceIdRaw) {
      const recAllDay =
        recurrenceIdParams.VALUE?.toUpperCase() === "DATE" ||
        (/^\d{8}$/.test(recurrenceIdRaw) && !recurrenceIdRaw.includes("T"))
      recurrenceId = formatICalDate(recurrenceIdRaw, recurrenceIdParams.TZID ?? tzid, recAllDay)
    }

    const parsedEvent: CalDAVEvent = {
      uid,
      summary: summary ?? "",
      dtstart,
      dtend,
      duration: !dtendRaw && dtend ? duration : undefined,
      inclusiveEndDate,
      description,
      location,
      allDay,
      rrule,
      exdates: exdates.length > 0 ? exdates : undefined,
      recurrenceId,
      recurrenceRange: recurrenceId && recurrenceIdParams.RANGE?.toUpperCase() === "THISANDFUTURE" ? "THISANDFUTURE" : undefined,
      tzid,
      href: eventHref,
      cancelled: cancelled || undefined,
    }
    events.push(parsedEvent)
  }

  return events
}

function wallClockMs(value: string, timezone: string, allDay: boolean): number {
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(value.slice(0, 10))
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return Date.parse(`${formatInTimeZone(new Date(value), timezone, "yyyy-MM-dd'T'HH:mm:ss")}Z`)
  }
  return Date.parse(`${value.slice(0, 19)}Z`)
}

function shiftWallClock(value: string, deltaMs: number, timezone: string, allDay: boolean): string {
  const shifted = new Date(wallClockMs(value, timezone, allDay) + deltaMs)
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(value)) return shifted.toISOString().slice(0, 10)
  const wall = shifted.toISOString().slice(0, 19)
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return fromZonedTime(wall, timezone).toISOString().replace(/\.\d{3}Z$/, "Z")
  }
  return wall
}

/**
 * RECURRENCE-ID;RANGE=THISANDFUTURE: the override's changes (new time of day, title,
 * location, description) apply to the identified instance and every later one. The
 * time change is applied to the wall clock so it survives DST.
 */
function applyThisAndFutureOverride(
  master: CalDAVEvent,
  override: CalDAVEvent,
  occ: { start: string; end?: string | undefined; inclusiveEndDate?: string | undefined },
): CalDAVEvent {
  const timezone = safeTimeZone(master.tzid)
  const allDay = master.allDay
  const delta =
    wallClockMs(override.dtstart, timezone, override.allDay) -
    wallClockMs(override.recurrenceId!, timezone, override.allDay)
  const start = shiftWallClock(occ.start, delta, timezone, allDay)
  const result: CalDAVEvent = {
    ...master,
    summary: override.summary || master.summary,
    description: override.description ?? master.description,
    location: override.location ?? master.location,
    dtstart: start,
    dtend: occ.end,
    inclusiveEndDate: occ.inclusiveEndDate ?? master.inclusiveEndDate,
  }
  // The override's own length applies to every later instance, including when it adds an end
  // the master never had. Without an override end, the master's length is kept.
  const overrideSpan = override.dtend
    ? wallClockMs(override.dtend, timezone, override.allDay) - wallClockMs(override.dtstart, timezone, override.allDay)
    : null
  const duration = override.duration ?? (override.dtend ? undefined : master.duration)
  if (duration) {
    result.dtend = eventEndFromDuration(start, duration, allDay, timezone)
    if (allDay) result.inclusiveEndDate = result.dtend ? shiftCalendarDay(result.dtend, -1) : start
  } else if (overrideSpan !== null && Number.isFinite(overrideSpan) && overrideSpan >= 0) {
    const end = shiftWallClock(start, overrideSpan, timezone, allDay)
    result.dtend = end
    if (allDay) {
      // iCalendar all-day DTEND is exclusive.
      result.inclusiveEndDate = end > start ? shiftCalendarDay(end, -1) : start
    }
  } else {
    if (occ.end) result.dtend = shiftWallClock(occ.end, delta, timezone, allDay)
    if (allDay && occ.inclusiveEndDate) {
      result.inclusiveEndDate = shiftWallClock(occ.inclusiveEndDate, delta, timezone, true)
    }
  }
  return result
}

/** Whether an expanded instance overlaps [windowStart, windowEnd] (all-day ends are exclusive). */
function instanceOverlapsWindow(
  evt: { dtstart: string; dtend?: string | undefined; inclusiveEndDate?: string | undefined; allDay: boolean },
  windowStart: Date,
  windowEnd: Date,
): boolean {
  if (evt.allDay) {
    const startMs = Date.parse(evt.dtstart.slice(0, 10))
    const endMs = Date.parse((evt.inclusiveEndDate ?? evt.dtstart).slice(0, 10)) + 86_400_000
    return endMs > windowStart.getTime() && startMs <= windowEnd.getTime()
  }
  const startMs = Date.parse(evt.dtstart)
  if (Number.isNaN(startMs)) return true
  const endMs = evt.dtend ? Date.parse(evt.dtend) : startMs
  return (Number.isNaN(endMs) ? startMs : endMs) >= windowStart.getTime() && startMs <= windowEnd.getTime()
}

/** Expand RRULE recurring events and apply EXDATE / RECURRENCE-ID overrides within [start, end]. */
export function expandCalDAVEventsInWindow(
  parsedEvents: CalDAVEvent[],
  start: Date,
  end: Date,
  onScanLimit?: () => void,
): CalDAVEvent[] {
  const byUid = new Map<string, CalDAVEvent[]>()
  for (const evt of parsedEvents) {
    const group = byUid.get(evt.uid) ?? []
    group.push(evt)
    byUid.set(evt.uid, group)
  }

  const expanded: CalDAVEvent[] = []

  eventSeries: for (const group of byUid.values()) {
    const startIndex = expanded.length
    const masters = group.filter(e => !e.recurrenceId)
    const overrides = group.filter(e => Boolean(e.recurrenceId))

    if (masters.length === 0) {
      for (const ov of overrides) {
        if (ov.cancelled) continue
        const occs = expandRRuleOccurrences({
          dtstart: ov.dtstart,
          dtend: ov.dtend,
          allDay: ov.allDay,
          timezone: safeTimeZone(ov.tzid),
          windowStart: start,
          windowEnd: end,
        })
        if (occs.length > 0) expanded.push(ov)
      }
      continue
    }

    for (const master of masters) {
      if (master.cancelled) continue
      const overrideExdates = overrides
        .map(o => o.recurrenceId)
        .filter((d): d is string => Boolean(d))
      const combinedExdates = [...(master.exdates ?? []), ...overrideExdates]

      if (master.rrule) {
        // Ranges (THISANDFUTURE) can move instances across the window edge in either direction,
        // so expand a wider window and check the moved instances against the requested one.
        const rangeOverrides = overrides
          .filter((o) => o.recurrenceRange === "THISANDFUTURE" && o.recurrenceId)
          .sort((a, b) => Date.parse(a.recurrenceId!) - Date.parse(b.recurrenceId!))
        const timezone = safeTimeZone(master.tzid)
        const maxShiftMs = rangeOverrides.reduce((max, o) => {
          if (o.cancelled) return max
          const shift = Math.abs(
            wallClockMs(o.dtstart, timezone, o.allDay) - wallClockMs(o.recurrenceId!, timezone, o.allDay),
          )
          return Number.isFinite(shift) ? Math.max(max, shift) : max
        }, 0)
        // A range can also lengthen every later instance, so one that starts before the window
        // can now reach into it. Pad by the longest override length as well.
        const maxSpanMs = rangeOverrides.reduce((max, o) => {
          if (o.cancelled || !o.dtend) return max
          const span = wallClockMs(o.dtend, timezone, o.allDay) - wallClockMs(o.dtstart, timezone, o.allDay)
          return Number.isFinite(span) ? Math.max(max, span) : max
        }, 0)
        const padMs = rangeOverrides.length > 0 ? maxShiftMs + maxSpanMs + 2 * 86_400_000 : 0
        const duration = master.allDay ? undefined : master.duration
        let occs
        try {
          occs = expandRRuleOccurrences({
            dtstart: master.dtstart,
            dtend: master.dtend,
            timedEndForStart: duration ? (start) => eventEndFromDuration(start, duration, false, timezone) : undefined,
            rrule: master.rrule,
            exdates: combinedExdates,
            allDay: master.allDay,
            timezone,
            windowStart: new Date(start.getTime() - padMs),
            windowEnd: new Date(end.getTime() + padMs),
          })
        } catch (error) {
          if (!(error instanceof RecurrenceScanLimitError) || !onScanLimit) throw error
          expanded.length = startIndex
          onScanLimit()
          continue eventSeries
        }
        for (const occ of occs) {
          const occMs = Date.parse(occ.start)
          const range = [...rangeOverrides].reverse().find((o) => Date.parse(o.recurrenceId!) <= occMs)
          // A cancelled range removes its instance and every later one.
          if (range?.cancelled) continue
          const instance: CalDAVEvent = range
            ? applyThisAndFutureOverride(master, range, occ)
            : {
              ...master,
              dtstart: occ.start,
              dtend: occ.end,
              inclusiveEndDate: occ.inclusiveEndDate ?? master.inclusiveEndDate,
            }
          if (padMs === 0 || instanceOverlapsWindow(instance, start, end)) expanded.push(instance)
        }
      } else {
        const occs = expandRRuleOccurrences({
          dtstart: master.dtstart,
          dtend: master.dtend,
          exdates: combinedExdates,
          allDay: master.allDay,
          timezone: safeTimeZone(master.tzid),
          windowStart: start,
          windowEnd: end,
        })
        if (occs.length > 0) expanded.push(master)
      }
    }

    for (const ov of overrides) {
      if (ov.cancelled) continue
      const occs = expandRRuleOccurrences({
        dtstart: ov.dtstart,
        dtend: ov.dtend,
        allDay: ov.allDay,
        timezone: safeTimeZone(ov.tzid),
        windowStart: start,
        windowEnd: end,
      })
      if (occs.length > 0) {
        const masterRRule = masters.find(m => m.rrule)?.rrule
        expanded.push({
          ...ov,
          rrule: ov.rrule ?? masterRRule,
        })
      }
    }
  }

  expanded.sort((a, b) => {
    const aMs = Date.parse(a.dtstart)
    const bMs = Date.parse(b.dtstart)
    if (!Number.isNaN(aMs) && !Number.isNaN(bMs) && aMs !== bMs) return aMs - bMs
    return a.dtstart.localeCompare(b.dtstart)
  })

  return expanded
}

/** Convert iCal date (YYYYMMDD or YYYYMMDDTHHmmSS[Z] with optional TZID) to ISO 8601 */
function formatICalDate(icalDate: string, tzid?: string, allDay = false): string {
  const clean = icalDate.trim()
  if (allDay || (clean.length === 8 && !clean.includes("T"))) {
    const digits = clean.replace(/[^0-9]/g, "")
    if (digits.length >= 8) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    }
  }
  // DateTime: YYYYMMDDTHHmmSS[Z] → ISO
  const base = clean.replace(/[^0-9TZ]/gi, "").toUpperCase()
  if (base.length < 8) return clean
  const d = base.slice(0, 4) + "-" + base.slice(4, 6) + "-" + base.slice(6, 8)
  if (base.includes("T") && base.length >= 15) {
    const t = base.slice(9, 11) + ":" + base.slice(11, 13) + ":" + base.slice(13, 15)
    if (base.endsWith("Z")) return `${d}T${t}Z`
    if (tzid && isValidTimeZone(tzid)) {
      return fromZonedTime(`${d}T${t}`, tzid).toISOString().replace(/\.\d{3}Z$/, "Z")
    }
    return `${d}T${t}`
  }
  return d
}

// ─── CalDAV Operations ──────────────────────────────────────────────

/**
 * Discover calendars on a CalDAV server.
 * Sends PROPFIND Depth:1 to the base URL to find calendar collections.
 */
export async function discoverCalendars(config: CalDAVConfig): Promise<CalDAVCalendar[]> {
  const validation = validateCalDAVUrl(config.url)
  if (!validation.valid) {
    throw new Error(`CalDAV URL validation failed: ${validation.error}`)
  }

  logger.log("info", {
    event: "caldav.discovery.starting",
    domain: "caldav", component: "caldav-client",
    request_id: SYS_REQ, message: `Discovering calendars at ${new URL(config.url).hostname}`,
  })

  const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
    <ical:calendar-color/>
  </d:prop>
</d:propfind>`

  try {
    const { status, text } = await caldavFetch(
      config.url, "PROPFIND", propfindBody,
      config.username, config.password,
      { Depth: "1" },
    )

    if (status === 401 || status === 403) {
      throw new Error("Authentication failed — check username and password")
    }
    if (status !== 207) {
      throw new Error(`Unexpected status ${status} from PROPFIND`)
    }

    const responses = extractXmlResponses(text)
    const calendars: CalDAVCalendar[] = []

    for (const resp of responses) {
      if (resp.props.isCalendar === "true") {
        const cal: CalDAVCalendar = {
          href: resp.href,
          displayName: resp.props.displayname || resp.href.split("/").filter(Boolean).pop() || "Calendar",
        }
        if (resp.props.ctag !== undefined) cal.ctag = resp.props.ctag
        if (resp.props.color !== undefined) cal.color = resp.props.color
        calendars.push(cal)
      }
    }

    logger.log("info", {
      event: "caldav.discovery.success",
      domain: "caldav", component: "caldav-client",
      request_id: SYS_REQ, message: `Discovered ${calendars.length} calendar(s)`,
    })

    return calendars
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("CalDAV server connection timed out (10s)")
    }
    throw err
  }
}

/**
 * Fetch events from a CalDAV calendar within a time range.
 * Uses REPORT calendar-query with time-range filter.
 */
export async function listCalDAVEvents(
  config: CalDAVConfig,
  calendarHref: string,
  start: Date,
  end: Date,
): Promise<{ events: CalDAVEvent[]; skippedSeries: number }> {
  const validation = validateCalDAVUrl(config.url)
  if (!validation.valid) {
    throw new Error(`CalDAV URL validation failed: ${validation.error}`)
  }

  // Build absolute URL for the calendar; it must stay on the configured origin
  const parsedCalUrl = resolveCalDAVHref(config.url, calendarHref)
  const calUrl = parsedCalUrl.toString()
  const calValidation = validateCalDAVUrl(calUrl)
  if (!calValidation.valid) {
    throw new Error(`CalDAV calendar URL validation failed: ${calValidation.error}`)
  }

  const startStr = toICalUTC(start)
  const endStr = toICalUTC(end)

  const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        <c:time-range start="${startStr}" end="${endStr}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`

  try {
    const { status, text } = await caldavFetch(
      calUrl, "REPORT", reportBody,
      config.username, config.password,
      { Depth: "1" },
    )

    if (status === 401 || status === 403) {
      throw new Error("Authentication failed")
    }
    if (status !== 207) {
      throw new Error(`Unexpected status ${status} from REPORT`)
    }

    const responses = extractXmlResponses(text)
    const parsedEvents: CalDAVEvent[] = []

    for (const resp of responses) {
      if (resp.props.calendarData) {
        const parsed = parseVEvents(resp.props.calendarData, resp.href)
        parsedEvents.push(...parsed)
      }
    }

    let skippedSeries = 0
    const events = expandCalDAVEventsInWindow(parsedEvents, start, end, () => { skippedSeries++ })

    logger.log("info", {
      event: "caldav.sync.success",
      domain: "caldav", component: "caldav-client",
      request_id: SYS_REQ,
      message: `Fetched ${events.length} events from CalDAV (${startStr} to ${endStr})`,
    })

    return { events, skippedSeries }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("CalDAV event fetch timed out (10s)")
    }
    throw err
  }
}

/**
 * Test connection to a CalDAV server.
 * Returns success/failure with descriptive message.
 */
export async function testConnection(config: CalDAVConfig): Promise<{ ok: boolean; message: string; calendars?: CalDAVCalendar[] }> {
  try {
    const calendars = await discoverCalendars(config)
    return {
      ok: true,
      message: `Connected! Found ${calendars.length} calendar${calendars.length !== 1 ? "s" : ""}: ${calendars.map((c) => c.displayName).join(", ")}`,
      calendars,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed"
    return { ok: false, message }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Convert Date to iCal UTC format: YYYYMMDDTHHmmSSZ */
function toICalUTC(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}
