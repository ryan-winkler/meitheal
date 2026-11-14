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
 *   - Single events only (no RRULE expansion)
 *   - Read-only (no write-back to CalDAV)
 *
 * @domain calendar
 * @bounded-context integration
 */
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability";
import { classifyNetworkHost } from "@meitheal/integration-core";

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
  description?: string | undefined;
  location?: string | undefined;
  allDay: boolean;
  /** Raw href on the CalDAV server for dedup */
  href: string;
}

// ─── SSRF Protection ────────────────────────────────────────────────

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

    const rawHostname = url.hostname.toLowerCase();
    const unbracketed = rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
    const hostname = unbracketed.replace(/\.+$/, "");
    const hostSafety = classifyNetworkHost(hostname);
    if (hostSafety === "unconditional") {
      return { valid: false, error: `Hostname "${hostname}" is blocked for security` };
    }
    if (hostSafety === "private") {
      return { valid: false, error: "Private/internal IP addresses are not allowed" };
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
    throw new Error(urlCheck.error);
  }
  const parsed = new URL(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(parsed.href, { // nosemgrep
      method,
      redirect: "error",
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        Authorization: basicAuthHeader(username, password),
        ...extraHeaders,
      },
      body,
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

/**
 * Parse XML string safely. Uses regex-based extraction to avoid
 * XXE vulnerabilities from DOM parsers with external entity resolution.
 *
 * This is intentionally minimal — we only need to extract specific
 * CalDAV/WebDAV properties, not build a full DOM.
 */
function extractXmlResponses(xml: string): Array<{ href: string; props: Record<string, string> }> {
  // Strip any DOCTYPE declarations (XXE prevention)
  const safeXml = xml.replace(/<!DOCTYPE[^>]*>/gi, "");

  const responses: Array<{ href: string; props: Record<string, string> }> = [];

  // Match each <d:response> or <D:response> or <response> block
  const responseRegex = /<(?:[a-zA-Z]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?response>/gi;
  let match;

  while ((match = responseRegex.exec(safeXml)) !== null) {
    const block = match[1]!;

    // Extract href
    const hrefMatch = block.match(/<(?:[a-zA-Z]+:)?href[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?href>/i);
    if (!hrefMatch) continue;

    const href = hrefMatch[1]!.trim();
    const props: Record<string, string> = {};

    // Extract displayname
    const dnMatch = block.match(/<(?:[a-zA-Z]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?displayname>/i);
    if (dnMatch) props.displayname = dnMatch[1]!.trim();

    // Extract getctag
    const ctagMatch = block.match(/<(?:[a-zA-Z]+:)?getctag[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?getctag>/i);
    if (ctagMatch) props.ctag = ctagMatch[1]!.trim();

    // Extract calendar-color
    const colorMatch = block.match(/<(?:[a-zA-Z]+:)?calendar-color[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?calendar-color>/i);
    if (colorMatch) props.color = colorMatch[1]!.trim();

    // Extract calendar-data (iCalendar content)
    const calDataMatch = block.match(/<(?:[a-zA-Z]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z]+:)?calendar-data>/i);
    if (calDataMatch) props.calendarData = calDataMatch[1]!.trim();

    // Check for resourcetype calendar
    if (block.match(/<(?:[a-zA-Z]+:)?calendar\s*\/?\s*>/i)) {
      props.isCalendar = "true";
    }

    responses.push({ href, props });
  }

  return responses;
}

// ─── iCalendar Parsing ──────────────────────────────────────────────

/**
 * Parse a VEVENT from iCalendar text.
 * Handles common field formats: date-time, date-only, quoted-printable.
 */
function parseVEvents(ical: string, eventHref: string): CalDAVEvent[] {
  const events: CalDAVEvent[] = [];

  // Unfold continuation lines (RFC 5545 §3.1)
  const unfolded = ical.replace(/\r?\n[ \t]/g, "");

  // Extract each VEVENT block
  const veventRegex = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/gi;
  let match;

  while ((match = veventRegex.exec(unfolded)) !== null) {
    const block = match[1]!;

    const getField = (name: string): string | undefined => {
      // Handle fields with params like DTSTART;VALUE=DATE:20260305
      const prefix = name.toUpperCase();
      const line = block.split(/\r?\n/).find((l) => {
        const upper = l.toUpperCase();
        return upper.startsWith(`${prefix}:`) || upper.startsWith(`${prefix};`);
      });
      if (!line) return undefined;
      // Strip parameters, keep value after last colon
      const parts = line.slice(prefix.length + 1).split(":");
      return parts[parts.length - 1]!.trim();
    };

    const uid = getField("UID");
    const summary = getField("SUMMARY");
    const dtstart = getField("DTSTART");

    if (!uid || !summary || !dtstart) continue;

    const dtend = getField("DTEND");
    const description = getField("DESCRIPTION")?.replace(/\\n/g, "\n").replace(/\\,/g, ",");
    const location = getField("LOCATION")?.replace(/\\,/g, ",");

    // All-day: DTSTART is date-only (YYYYMMDD, 8 chars, no T)
    const allDay = dtstart.length === 8 && !dtstart.includes("T");

    events.push({
      uid,
      summary,
      dtstart: formatICalDate(dtstart),
      dtend: dtend ? formatICalDate(dtend) : undefined,
      description,
      location,
      allDay,
      href: eventHref,
    });
  }

  return events;
}

/** Convert iCal date (YYYYMMDD or YYYYMMDDTHHmmSSZ) to ISO 8601 */
function formatICalDate(icalDate: string): string {
  if (icalDate.length === 8) {
    // Date only: YYYYMMDD → YYYY-MM-DD
    return `${icalDate.slice(0, 4)}-${icalDate.slice(4, 6)}-${icalDate.slice(6, 8)}`;
  }
  // DateTime: YYYYMMDDTHHmmSS[Z] → ISO
  const base = icalDate.replace(/[^0-9TZ]/g, "");
  const d = base.slice(0, 4) + "-" + base.slice(4, 6) + "-" + base.slice(6, 8);
  if (base.includes("T") && base.length >= 15) {
    const t = base.slice(9, 11) + ":" + base.slice(11, 13) + ":" + base.slice(13, 15);
    return d + "T" + t + (base.endsWith("Z") ? "Z" : "");
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

  // Build absolute URL for the calendar
  const baseUrl = new URL(config.url);
  const parsedCalUrl = new URL(calendarHref, baseUrl);
  if (parsedCalUrl.origin !== baseUrl.origin) {
    throw new Error(`CalDAV calendar href escaped configured origin: ${parsedCalUrl.origin}`);
  }
  const calUrlCheck = validateCalDAVUrl(parsedCalUrl.toString());
  if (!calUrlCheck.valid) {
    throw new Error(calUrlCheck.error);
  }
  const calUrl = parsedCalUrl.toString();

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
    const events: CalDAVEvent[] = [];

    for (const resp of responses) {
      if (resp.props.calendarData) {
        const parsed = parseVEvents(resp.props.calendarData, resp.href);
        events.push(...parsed);
      }
    }

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
