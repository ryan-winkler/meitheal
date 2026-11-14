/**
 * CalDAV Client — Minimal server-side CalDAV sync
 *
 * Fetches events from external CalDAV servers (Nextcloud, Radicale, Baikal)
 * using native `fetch` — zero npm dependencies.
 *
 * Security:
 *   - SSRF protection: rejects private IPs, localhost, metadata URLs
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
import { fromZonedTime } from "date-fns-tz";
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { shiftCalendarDay } from "../../lib/date";
import { expandRRuleOccurrences, normalizeRRule } from "./recurrence";

const logger = createLogger({
  service: "meitheal-web", env: process.env.NODE_ENV ?? "development",
  minLevel: "info", enabledCategories: ["caldav", "calendar"],
  redactPatterns: [...defaultRedactionPatterns, /password=\S+/gi, /Authorization:\s*\S+/gi],
  auditEnabled: false,
});
const SYS_REQ = "caldav-system";

// ─── Types ──────────────────────────────────────────────────────────

export interface CalDAVConfig {
  url: string;
  username: string;
  password: string;
}

export interface CalDAVCalendar {
  href: string;
  displayName: string;
  ctag?: string | undefined;
  color?: string | undefined;
}

export interface CalDAVEvent {
  uid: string;
  summary: string;
  dtstart: string;
  dtend?: string | undefined;
  /** Inclusive end date (YYYY-MM-DD) for all-day events where iCal DTEND is exclusive */
  inclusiveEndDate?: string | undefined;
  description?: string | undefined;
  location?: string | undefined;
  allDay: boolean;
  rrule?: string | undefined;
  exdates?: string[] | undefined;
  recurrenceId?: string | undefined;
  tzid?: string | undefined;
  /** Raw href on the CalDAV server for dedup */
  href: string;
}

// ─── SSRF Protection ────────────────────────────────────────────────

/** Private/reserved IP ranges that MUST be rejected */
const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // RFC 6598 CGNAT
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i,
  /^::1$/,
  /^::$/,
  /^::ffff:/i,
  /^0+(?::0+){4}:ffff:/i,
];

const BLOCKED_HOSTNAMES = [
  "localhost", "metadata.google.internal", "instance-data",
  "metadata.internal", "169.254.169.254",
];

function normalizeHostname(rawHostname: string): string {
  const lower = rawHostname.toLowerCase().replace(/\.+$/, "");
  if (lower.startsWith("[") && lower.endsWith("]")) {
    return lower.slice(1, -1);
  }
  return lower;
}

/**
 * Validate a CalDAV URL for SSRF safety.
 * Rejects private IPs, localhost, metadata endpoints, and non-HTTPS in production.
 */
export function validateCalDAVUrl(rawUrl: string): { valid: boolean; error?: string } {
  try {
    const url = new URL(rawUrl);

    // Must be HTTP(S)
    if (!["http:", "https:"].includes(url.protocol)) {
      return { valid: false, error: "Only HTTP/HTTPS protocols are allowed" };
    }

    // Block known dangerous hostnames
    const hostname = normalizeHostname(url.hostname);
    if (!hostname || BLOCKED_HOSTNAMES.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
      return { valid: false, error: `Hostname "${hostname}" is blocked for security` };
    }

    // Block private IP ranges
    for (const range of PRIVATE_RANGES) {
      if (range.test(hostname)) {
        return { valid: false, error: "Private/internal IP addresses are not allowed" };
      }
    }

    // Warn on HTTP (but allow for local testing)
    if (url.protocol === "http:" && process.env.NODE_ENV === "production") {
      return { valid: false, error: "HTTPS is required for CalDAV connections in production" };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
}

// ─── HTTP Helpers ───────────────────────────────────────────────────

const TIMEOUT_MS = 10_000;

/** Max response body size (5MB) — prevents OOM from oversized calendar responses */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

async function caldavFetch(
  url: string, method: string, body: string | null,
  username: string, password: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const urlCheck = validateCalDAVUrl(url);
  if (!urlCheck.valid) {
    throw new Error(`CalDAV URL validation failed: ${urlCheck.error}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Authorization: basicAuthHeader(username, password),
        ...extraHeaders,
      },
      body,
      redirect: "error",
      signal: controller.signal,
    });

    // Guard: check Content-Length header before reading body
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new Error(`CalDAV response too large (${contentLength} bytes, max ${MAX_RESPONSE_BYTES})`);
    }

    const text = await res.text();

    // Guard: check actual body size after reading
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new Error(`CalDAV response body too large (${text.length} chars, max ${MAX_RESPONSE_BYTES})`);
    }

    return { status: res.status, text };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── XML Parsing (XXE-safe) ─────────────────────────────────────────

function unwrapCdata(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) {
    return trimmed.slice(9, -3).trim();
  }
  return trimmed;
}

function isTagBoundaryChar(ch: string | undefined): boolean {
  return ch === ">" || ch === "/" || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function findNextOpenTag(lowerXml: string, localName: string, fromIndex: number): {
  contentStart: number;
  selfClosing: boolean;
  tagName: string;
} | null {
  let cursor = fromIndex;
  while (cursor < lowerXml.length) {
    const lt = lowerXml.indexOf("<", cursor);
    if (lt === -1) return null;
    if (lowerXml.startsWith("</", lt) || lowerXml.startsWith("<!", lt) || lowerXml.startsWith("<?", lt)) {
      const close = lowerXml.indexOf(">", lt + 2);
      cursor = close === -1 ? lowerXml.length : close + 1;
      continue;
    }
    const gt = lowerXml.indexOf(">", lt + 1);
    if (gt === -1) return null;
    const header = lowerXml.slice(lt + 1, gt);
    let endName = 0;
    while (endName < header.length && !isTagBoundaryChar(header[endName])) {
      endName++;
    }
    const fullTagName = header.slice(0, endName);
    const colonIdx = fullTagName.indexOf(":");
    const tagLocal = colonIdx === -1 ? fullTagName : fullTagName.slice(colonIdx + 1);
    if (tagLocal === localName) {
      const selfClosing = header.trimEnd().endsWith("/");
      return { contentStart: gt + 1, selfClosing, tagName: fullTagName };
    }
    cursor = gt + 1;
  }
  return null;
}

function extractTagContents(xml: string, localName: string): string[] {
  const lower = xml.toLowerCase();
  const target = localName.toLowerCase();
  const results: string[] = [];
  let cursor = 0;

  while (cursor < lower.length) {
    const open = findNextOpenTag(lower, target, cursor);
    if (!open) break;
    if (open.selfClosing) {
      cursor = open.contentStart;
      continue;
    }
    const closeToken = `</${open.tagName}>`;
    const closeIdx = lower.indexOf(closeToken, open.contentStart);
    if (closeIdx === -1) {
      cursor = open.contentStart;
      continue;
    }
    results.push(xml.slice(open.contentStart, closeIdx));
    cursor = closeIdx + closeToken.length;
  }

  return results;
}

/**
 * Parse XML string safely with linear tag scanning to prevent XXE
 * declarations and regular-expression backtracking (ReDoS).
 */
export function extractXmlResponses(xml: string): Array<{ href: string; props: Record<string, string> }> {
  // Reject DOCTYPE/ENTITY declarations fail-closed (handles internal DTD subsets too).
  if (/<!(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error("Rejected CalDAV XML response containing unsafe DOCTYPE or ENTITY declaration");
  }

  const responses: Array<{ href: string; props: Record<string, string> }> = [];
  for (const block of extractTagContents(xml, "response")) {
    const hrefRaw = extractTagContents(block, "href")[0];
    if (hrefRaw === undefined) continue;

    const href = unwrapCdata(hrefRaw);
    const props: Record<string, string> = {};

    const dnRaw = extractTagContents(block, "displayname")[0];
    if (dnRaw !== undefined) props.displayname = unwrapCdata(dnRaw);

    const ctagRaw = extractTagContents(block, "getctag")[0];
    if (ctagRaw !== undefined) props.ctag = unwrapCdata(ctagRaw);

    const colorRaw = extractTagContents(block, "calendar-color")[0];
    if (colorRaw !== undefined) props.color = unwrapCdata(colorRaw);

    const calDataRaw = extractTagContents(block, "calendar-data")[0];
    if (calDataRaw !== undefined) props.calendarData = unwrapCdata(calDataRaw);

    if (findNextOpenTag(block.toLowerCase(), "calendar", 0) !== null) {
      props.isCalendar = "true";
    }

    responses.push({ href, props });
  }

  return responses;
}

// ─── iCalendar Parsing ──────────────────────────────────────────────

function unescapeICalText(raw: string): string {
  return raw.replace(/\\([\\,;nN])/g, (_match, ch: string) => {
    if (ch === "n" || ch === "N") return "\n";
    return ch;
  });
}

function parseICalPropertyLine(line: string): {
  name: string;
  params: Record<string, string>;
  value: string;
} | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;

  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1).trim();
  const segments: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < left.length; i++) {
    const ch = left[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ";" && !inQuotes) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  segments.push(current);

  const name = segments[0]?.trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const eqIdx = seg.indexOf("=");
    if (eqIdx === -1) continue;
    const pKey = seg.slice(0, eqIdx).trim().toUpperCase();
    let pVal = seg.slice(eqIdx + 1).trim();
    if (pVal.startsWith('"') && pVal.endsWith('"') && pVal.length >= 2) {
      pVal = pVal.slice(1, -1);
    }
    if (pKey) params[pKey] = pVal;
  }

  return { name, params, value };
}

function isValidTimeZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse VEVENT blocks from iCalendar text.
 * Uses colon-safe property parsing (`indexOf(":")`), handles TZID, RRULE, EXDATE,
 * RECURRENCE-ID, nested subcomponents (VALARM), and exclusive all-day DTEND.
 */
export function parseVEvents(ical: string, eventHref: string): CalDAVEvent[] {
  const events: CalDAVEvent[] = [];

  // Unfold continuation lines (RFC 5545 §3.1)
  const unfolded = ical.replace(/\r?\n[ \t]/g, "");

  // Extract each VEVENT block
  const veventRegex = /BEGIN:VEVENT\b([\s\S]*?)END:VEVENT/gi;
  let match;

  while ((match = veventRegex.exec(unfolded)) !== null) {
    const block = match[1]!;
    const lines = block.split(/\r?\n/);

    let uid: string | undefined;
    let summary: string | undefined;
    let dtstartRaw: string | undefined;
    let dtstartParams: Record<string, string> = {};
    let dtendRaw: string | undefined;
    let dtendParams: Record<string, string> = {};
    let description: string | undefined;
    let location: string | undefined;
    let rrule: string | undefined;
    let recurrenceIdRaw: string | undefined;
    let recurrenceIdParams: Record<string, string> = {};
    const exdates: string[] = [];

    let nestedDepth = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (/^BEGIN:/i.test(line)) {
        nestedDepth++;
        continue;
      }
      if (/^END:/i.test(line)) {
        nestedDepth = Math.max(0, nestedDepth - 1);
        continue;
      }
      if (nestedDepth > 0) continue; // Ignore VALARM or other nested subcomponents

      const prop = parseICalPropertyLine(line);
      if (!prop) continue;

      switch (prop.name) {
        case "UID":
          uid = prop.value;
          break;
        case "SUMMARY":
          summary = unescapeICalText(prop.value);
          break;
        case "DTSTART":
          dtstartRaw = prop.value;
          dtstartParams = prop.params;
          break;
        case "DTEND":
          dtendRaw = prop.value;
          dtendParams = prop.params;
          break;
        case "DESCRIPTION":
          description = unescapeICalText(prop.value);
          break;
        case "LOCATION":
          location = unescapeICalText(prop.value);
          break;
        case "RRULE":
          rrule = normalizeRRule(prop.value) ?? undefined;
          break;
        case "RECURRENCE-ID":
          recurrenceIdRaw = prop.value;
          recurrenceIdParams = prop.params;
          break;
        case "EXDATE": {
          const exIsDate = prop.params.VALUE?.toUpperCase() === "DATE";
          for (const item of prop.value.split(",")) {
            const trimmed = item.trim();
            if (!trimmed) continue;
            const itemAllDay = exIsDate || (/^\d{8}$/.test(trimmed) && !trimmed.includes("T"));
            exdates.push(formatICalDate(trimmed, prop.params.TZID, itemAllDay));
          }
          break;
        }
      }
    }

    if (!uid || !summary || !dtstartRaw) continue;

    const allDay =
      dtstartParams.VALUE?.toUpperCase() === "DATE" ||
      (/^\d{8}$/.test(dtstartRaw) && !dtstartRaw.includes("T"));
    const tzid = dtstartParams.TZID;
    const dtstart = formatICalDate(dtstartRaw, tzid, allDay);

    let dtend: string | undefined;
    let inclusiveEndDate: string | undefined;
    if (dtendRaw) {
      const endAllDay =
        allDay ||
        dtendParams.VALUE?.toUpperCase() === "DATE" ||
        (/^\d{8}$/.test(dtendRaw) && !dtendRaw.includes("T"));
      dtend = formatICalDate(dtendRaw, dtendParams.TZID ?? tzid, endAllDay);
      if (allDay) {
        inclusiveEndDate = dtend > dtstart ? shiftCalendarDay(dtend, -1) : dtstart;
      }
    } else if (allDay) {
      inclusiveEndDate = dtstart;
    }

    let recurrenceId: string | undefined;
    if (recurrenceIdRaw) {
      const recAllDay =
        recurrenceIdParams.VALUE?.toUpperCase() === "DATE" ||
        (/^\d{8}$/.test(recurrenceIdRaw) && !recurrenceIdRaw.includes("T"));
      recurrenceId = formatICalDate(recurrenceIdRaw, recurrenceIdParams.TZID ?? tzid, recAllDay);
    }

    const parsedEvent: CalDAVEvent = {
      uid,
      summary,
      dtstart,
      dtend,
      inclusiveEndDate,
      description,
      location,
      allDay,
      rrule,
      exdates: exdates.length > 0 ? exdates : undefined,
      recurrenceId,
      tzid,
      href: eventHref,
    };
    events.push(parsedEvent);
  }

  return events;
}

/** Expand RRULE recurring events and apply EXDATE / RECURRENCE-ID overrides within [start, end]. */
export function expandCalDAVEventsInWindow(
  parsedEvents: CalDAVEvent[],
  start: Date,
  end: Date,
): CalDAVEvent[] {
  const byUid = new Map<string, CalDAVEvent[]>();
  for (const evt of parsedEvents) {
    const group = byUid.get(evt.uid) ?? [];
    group.push(evt);
    byUid.set(evt.uid, group);
  }

  const expanded: CalDAVEvent[] = [];

  for (const [, group] of byUid) {
    const masters = group.filter(e => !e.recurrenceId);
    const overrides = group.filter(e => Boolean(e.recurrenceId));

    if (masters.length === 0) {
      for (const ov of overrides) {
        const occs = expandRRuleOccurrences({
          dtstart: ov.dtstart,
          dtend: ov.dtend,
          allDay: ov.allDay,
          timezone: ov.tzid ?? "UTC",
          windowStart: start,
          windowEnd: end,
        });
        if (occs.length > 0) expanded.push(ov);
      }
      continue;
    }

    for (const master of masters) {
      const overrideExdates = overrides
        .map(o => o.recurrenceId)
        .filter((d): d is string => Boolean(d));
      const combinedExdates = [...(master.exdates ?? []), ...overrideExdates];

      if (master.rrule) {
        const occs = expandRRuleOccurrences({
          dtstart: master.dtstart,
          dtend: master.dtend,
          rrule: master.rrule,
          exdates: combinedExdates,
          allDay: master.allDay,
          timezone: master.tzid ?? "UTC",
          windowStart: start,
          windowEnd: end,
        });
        for (const occ of occs) {
          expanded.push({
            ...master,
            dtstart: occ.start,
            dtend: occ.end,
            inclusiveEndDate: occ.inclusiveEndDate ?? master.inclusiveEndDate,
          });
        }
      } else {
        const occs = expandRRuleOccurrences({
          dtstart: master.dtstart,
          dtend: master.dtend,
          exdates: combinedExdates,
          allDay: master.allDay,
          timezone: master.tzid ?? "UTC",
          windowStart: start,
          windowEnd: end,
        });
        if (occs.length > 0) expanded.push(master);
      }
    }

    for (const ov of overrides) {
      const occs = expandRRuleOccurrences({
        dtstart: ov.dtstart,
        dtend: ov.dtend,
        allDay: ov.allDay,
        timezone: ov.tzid ?? "UTC",
        windowStart: start,
        windowEnd: end,
      });
      if (occs.length > 0) {
        const masterRRule = masters.find(m => m.rrule)?.rrule;
        expanded.push({
          ...ov,
          rrule: ov.rrule ?? masterRRule,
        });
      }
    }
  }

  expanded.sort((a, b) => {
    const aMs = Date.parse(a.dtstart);
    const bMs = Date.parse(b.dtstart);
    if (!Number.isNaN(aMs) && !Number.isNaN(bMs) && aMs !== bMs) return aMs - bMs;
    return a.dtstart.localeCompare(b.dtstart);
  });

  return expanded;
}

/** Convert iCal date (YYYYMMDD or YYYYMMDDTHHmmSS[Z] with optional TZID) to ISO 8601 */
function formatICalDate(icalDate: string, tzid?: string, allDay = false): string {
  const clean = icalDate.trim();
  if (allDay || (clean.length === 8 && !clean.includes("T"))) {
    const digits = clean.replace(/[^0-9]/g, "");
    if (digits.length >= 8) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
  }
  // DateTime: YYYYMMDDTHHmmSS[Z] → ISO
  const base = clean.replace(/[^0-9TZ]/gi, "").toUpperCase();
  if (base.length < 8) return clean;
  const d = base.slice(0, 4) + "-" + base.slice(4, 6) + "-" + base.slice(6, 8);
  if (base.includes("T") && base.length >= 15) {
    const t = base.slice(9, 11) + ":" + base.slice(11, 13) + ":" + base.slice(13, 15);
    if (base.endsWith("Z")) return `${d}T${t}Z`;
    if (tzid && isValidTimeZone(tzid)) {
      return fromZonedTime(`${d}T${t}`, tzid).toISOString().replace(/\.\d{3}Z$/, "Z");
    }
    return `${d}T${t}`;
  }
  return d;
}

// ─── CalDAV Operations ──────────────────────────────────────────────

/**
 * Discover calendars on a CalDAV server.
 * Sends PROPFIND Depth:1 to the base URL to find calendar collections.
 */
export async function discoverCalendars(config: CalDAVConfig): Promise<CalDAVCalendar[]> {
  const validation = validateCalDAVUrl(config.url);
  if (!validation.valid) {
    throw new Error(`CalDAV URL validation failed: ${validation.error}`);
  }

  logger.log("info", {
    event: "caldav.discovery.starting",
    domain: "caldav", component: "caldav-client",
    request_id: SYS_REQ, message: `Discovering calendars at ${new URL(config.url).hostname}`,
  });

  const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ical="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
    <ical:calendar-color/>
  </d:prop>
</d:propfind>`;

  try {
    const { status, text } = await caldavFetch(
      config.url, "PROPFIND", propfindBody,
      config.username, config.password,
      { Depth: "1" },
    );

    if (status === 401 || status === 403) {
      throw new Error("Authentication failed — check username and password");
    }
    if (status !== 207) {
      throw new Error(`Unexpected status ${status} from PROPFIND`);
    }

    const responses = extractXmlResponses(text);
    const calendars: CalDAVCalendar[] = [];

    for (const resp of responses) {
      if (resp.props.isCalendar === "true") {
        const cal: CalDAVCalendar = {
          href: resp.href,
          displayName: resp.props.displayname || resp.href.split("/").filter(Boolean).pop() || "Calendar",
        };
        if (resp.props.ctag !== undefined) cal.ctag = resp.props.ctag;
        if (resp.props.color !== undefined) cal.color = resp.props.color;
        calendars.push(cal);
      }
    }

    logger.log("info", {
      event: "caldav.discovery.success",
      domain: "caldav", component: "caldav-client",
      request_id: SYS_REQ, message: `Discovered ${calendars.length} calendar(s)`,
    });

    return calendars;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("CalDAV server connection timed out (10s)");
    }
    throw err;
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
): Promise<CalDAVEvent[]> {
  const validation = validateCalDAVUrl(config.url);
  if (!validation.valid) {
    throw new Error(`CalDAV URL validation failed: ${validation.error}`);
  }

  // Build absolute URL for the calendar and keep requests strictly same-origin & SSRF-validated
  const baseUrl = new URL(config.url);
  const resolvedCalUrl = new URL(calendarHref, baseUrl);
  if (resolvedCalUrl.origin !== baseUrl.origin) {
    throw new Error(`Rejected cross-origin CalDAV calendar href "${calendarHref}"`);
  }
  const calUrl = resolvedCalUrl.toString();
  const calValidation = validateCalDAVUrl(calUrl);
  if (!calValidation.valid) {
    throw new Error(`CalDAV calendar URL validation failed: ${calValidation.error}`);
  }

  const startStr = toICalUTC(start);
  const endStr = toICalUTC(end);

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
</c:calendar-query>`;

  try {
    const { status, text } = await caldavFetch(
      calUrl, "REPORT", reportBody,
      config.username, config.password,
      { Depth: "1" },
    );

    if (status === 401 || status === 403) {
      throw new Error("Authentication failed");
    }
    if (status !== 207) {
      throw new Error(`Unexpected status ${status} from REPORT`);
    }

    const responses = extractXmlResponses(text);
    const parsedEvents: CalDAVEvent[] = [];

    for (const resp of responses) {
      if (resp.props.calendarData) {
        const parsed = parseVEvents(resp.props.calendarData, resp.href);
        parsedEvents.push(...parsed);
      }
    }

    const events = expandCalDAVEventsInWindow(parsedEvents, start, end);

    logger.log("info", {
      event: "caldav.sync.success",
      domain: "caldav", component: "caldav-client",
      request_id: SYS_REQ,
      message: `Fetched ${events.length} events from CalDAV (${startStr} to ${endStr})`,
    });

    return events;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("CalDAV event fetch timed out (10s)");
    }
    throw err;
  }
}

/**
 * Test connection to a CalDAV server.
 * Returns success/failure with descriptive message.
 */
export async function testConnection(config: CalDAVConfig): Promise<{ ok: boolean; message: string; calendars?: CalDAVCalendar[] }> {
  try {
    const calendars = await discoverCalendars(config);
    return {
      ok: true,
      message: `Connected! Found ${calendars.length} calendar${calendars.length !== 1 ? "s" : ""}: ${calendars.map((c) => c.displayName).join(", ")}`,
      calendars,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return { ok: false, message };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Convert Date to iCal UTC format: YYYYMMDDTHHmmSSZ */
function toICalUTC(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}
