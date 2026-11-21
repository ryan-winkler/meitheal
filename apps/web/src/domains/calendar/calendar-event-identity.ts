/**
 * Calendar Event Identity & Loop-Prevention Helpers
 *
 * Pure helpers shared by HA Calendar (including Google Calendar via HA)
 * and WebDAV/CalDAV inbound sync to:
 *   - Detect Meitheal-originated events (outbound write-backs & due-date reminders),
 *     even when Google Calendar wraps descriptions in HTML.
 *   - Normalize HTML-formatted calendar descriptions without corrupting plain-text
 *     angle brackets ("a < b > c").
 *
 * All parsing is strictly linear O(n) to avoid regex backtracking and
 * multi-character sanitization issues.
 *
 * @domain calendar
 * @bounded-context integration
 */

const HTML_TAG_PATTERN = /<\/?(?:p|br|a|div|span|ul|ol|li|b|i|strong|em|tr|td|th|h[1-6])(?:\s|>|\/)/i
const BLOCK_CLOSE_TAGS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"])
const REMINDER_EMOJIS = ["📋", "🎯", "📖", "✅", "⚡"] as const

/** Detect whether a description contains HTML markup (e.g. Google Calendar rich text). */
export function isHtmlDescription(input: string | null | undefined): boolean {
  if (!input) return false
  return HTML_TAG_PATTERN.test(input)
}

/**
 * Convert HTML-formatted calendar descriptions to plain text using a single-pass
 * character scanner. Block closing tags and `<br>` become newlines so adjacent
 * HTML blocks do not run together. Decodes `&amp;` last to prevent double-unescaping.
 */
export function stripHtmlTags(input: string): string {
  const out: string[] = []
  let i = 0
  const len = input.length

  while (i < len) {
    const ch = input[i]
    if (ch === "<") {
      const closeIdx = input.indexOf(">", i + 1)
      if (closeIdx === -1) {
        out.push(input.slice(i))
        break
      }
      const rawTag = input.slice(i + 1, closeIdx).trim()
      const isClosing = rawTag.startsWith("/")
      const tagBody = isClosing ? rawTag.slice(1).trim() : rawTag
      let nameEnd = 0
      while (nameEnd < tagBody.length) {
        const c = tagBody.charCodeAt(nameEnd)
        const isAlphaNum =
          (c >= 65 && c <= 90) ||
          (c >= 97 && c <= 122) ||
          (c >= 48 && c <= 57)
        if (!isAlphaNum) break
        nameEnd++
      }
      const tagName = tagBody.slice(0, nameEnd).toLowerCase()
      if (tagName === "br" || (isClosing && BLOCK_CLOSE_TAGS.has(tagName))) {
        out.push("\n")
      }
      i = closeIdx + 1
    } else {
      out.push(ch!)
      i++
    }
  }

  return out
    .join("")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
}

/**
 * Return plain-text description for persistence: strips HTML only when actual
 * HTML tags are detected so plain-text angle brackets stay intact.
 */
export function normalizeCalendarDescription(input: string | null | undefined): string | null {
  if (!input) return null
  const normalized = isHtmlDescription(input) ? stripHtmlTags(input) : input
  const trimmed = normalized.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Check whether a token is a valid Meitheal ticket key (e.g. MTH-30, HOME-12) or "Task". */
function isTicketKeyOrTask(token: string): boolean {
  if (token.toLowerCase() === "task") return true
  const dashIdx = token.indexOf("-")
  if (dashIdx < 2 || dashIdx > 10) return false
  if (token.indexOf("-", dashIdx + 1) !== -1) return false

  for (let i = 0; i < dashIdx; i++) {
    const c = token.charCodeAt(i)
    const isUpper = c >= 65 && c <= 90
    const isDigit = c >= 48 && c <= 57
    if (!isUpper && !isDigit) return false
  }

  const numPart = token.slice(dashIdx + 1)
  if (numPart.length === 0 || numPart.length > 12) return false
  const firstDigit = numPart.charCodeAt(0)
  if (firstDigit < 49 || firstDigit > 57) return false // 1-9
  for (let i = 1; i < numPart.length; i++) {
    const c = numPart.charCodeAt(i)
    if (c < 48 || c > 57) return false
  }
  return true
}

function stripLeadingReminderEmoji(input: string): { hadEmoji: boolean; rest: string } {
  for (const emoji of REMINDER_EMOJIS) {
    if (input.startsWith(emoji)) {
      return { hadEmoji: true, rest: input.slice(emoji.length).trimStart() }
    }
  }
  return { hadEmoji: false, rest: input }
}

/** If `input` starts with `[emoji] <TICKET_KEY|Task>: `, return the remainder; else null. */
function consumeTicketPrefix(input: string): string | null {
  const { rest } = stripLeadingReminderEmoji(input.trimStart())
  const colonIdx = rest.indexOf(":")
  if (colonIdx <= 0 || colonIdx > 24) return null
  const token = rest.slice(0, colonIdx)
  if (!isTicketKeyOrTask(token)) return null
  return rest.slice(colonIdx + 1).trimStart()
}

function isMeithealMarkerLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  const lower = trimmed.toLowerCase()

  if (lower === "added from meitheal") return true

  // Exact reminder line: "Task MTH-30 is due." or "Task HOME-12 is due."
  if (lower.startsWith("task ") && lower.endsWith(" is due.")) {
    const mid = trimmed.slice(5, trimmed.length - 8).trim()
    if (mid.length > 0 && isTicketKeyOrTask(mid)) return true
  }

  // Exact ticket deep-link line: "Open MTH-30 in Meitheal: ..." or "Open in Meitheal: ..."
  if (lower.startsWith("open in meitheal:")) return true
  if (lower.startsWith("open ")) {
    const markerIdx = lower.indexOf(" in meitheal:")
    if (markerIdx > 5) {
      const mid = trimmed.slice(5, markerIdx).trim()
      if (mid.length > 0 && isTicketKeyOrTask(mid)) return true
    }
  }

  return false
}

/**
 * Detect whether a calendar event was generated by Meitheal (write-back or
 * due-date reminder) so inbound sync never re-imports it into a feedback loop.
 */
export function isMeithealOriginatedEvent(
  summary: string | null | undefined,
  description: string | null | undefined,
): boolean {
  if (description) {
    const plain = isHtmlDescription(description) ? stripHtmlTags(description) : description
    const lines = plain.split(/\r?\n/)
    for (const line of lines) {
      if (isMeithealMarkerLine(line)) return true
    }
  }

  if (summary) {
    const trimmed = summary.trim()
    if (trimmed.length > 0) {
      // Due-date reminder format: "📋 MTH-30: Title — DUE" or "📋 Title — DUE"
      const { hadEmoji, rest } = stripLeadingReminderEmoji(trimmed)
      if (hadEmoji && rest.length > 5 && rest.toUpperCase().endsWith("— DUE")) {
        return true
      }
      // Recursive nested prefix loop artifact: "📋 MTH-34: 📋 MTH-30: ..."
      const afterFirst = consumeTicketPrefix(trimmed)
      if (afterFirst !== null && consumeTicketPrefix(afterFirst) !== null) {
        return true
      }
    }
  }

  return false
}
