/**
 * Calendar Event Identity & Loop-Prevention Helpers
 *
 * Pure helpers shared by HA Calendar (including Google Calendar via HA),
 * due-date reminders, and WebDAV/CalDAV inbound sync to:
 *   - Detect Meitheal-originated events (outbound write-backs & due-date reminders),
 *     even when Google Calendar wraps descriptions in HTML, collapses lines onto a
 *     single line, normalizes dashes, or truncates long summaries.
 *   - Strip recursive Meitheal summary wrappers ("📋 MTH-15: ... — DUE") idempotently
 *     so outbound titles can never snowball into expanding chains.
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
const DUE_SUFFIXES = ["— DUE", "– DUE", "- DUE"] as const

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
  return isStrictTicketKey(token)
}

/** Check whether a token is a strict Meitheal ticket key (e.g. MTH-30, HOME-12). */
function isStrictTicketKey(token: string): boolean {
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

/** If `input` starts with `[emoji] <TICKET_KEY|Task>: `, return the remainder + metadata; else null. */
function consumeTicketPrefix(input: string): { hadEmoji: boolean; token: string; rest: string } | null {
  const { hadEmoji, rest } = stripLeadingReminderEmoji(input.trimStart())
  const colonIdx = rest.indexOf(":")
  if (colonIdx <= 0 || colonIdx > 24) return null
  const token = rest.slice(0, colonIdx)
  if (!isTicketKeyOrTask(token)) return null
  return { hadEmoji, token, rest: rest.slice(colonIdx + 1).trimStart() }
}

function endsWithDueSuffix(input: string): boolean {
  const upper = input.trimEnd().toUpperCase()
  for (const suffix of DUE_SUFFIXES) {
    if (upper.endsWith(suffix) && upper.length > suffix.length) {
      return true
    }
  }
  return false
}

function startsWithOpenInMeitheal(lower: string, original: string): boolean {
  if (lower.startsWith("open in meitheal:")) return true
  if (lower.startsWith("open ")) {
    const markerIdx = lower.indexOf(" in meitheal:")
    if (markerIdx > 5) {
      const mid = original.slice(5, markerIdx).trim()
      if (mid.length > 0 && isTicketKeyOrTask(mid)) return true
    }
  }
  return false
}

function isMeithealMarkerLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  const lower = trimmed.toLowerCase()

  if (lower === "added from meitheal") return true

  // Exact ticket deep-link line: "Open MTH-30 in Meitheal: ..." or "Open in Meitheal: ..."
  if (startsWithOpenInMeitheal(lower, trimmed)) return true

  // Reminder header line:
  //   "Task MTH-30 is due."
  //   "Task MTH-75 is due. Open in Meitheal: https://..."
  //   "Task MTH-75 is due. Open MTH-75 in Meitheal: https://..."
  //   "Task MTH-75 is due. Added from Meitheal"
  // Notice ordinary human notes like "Discuss whether Task HOME-12 is due." do NOT start with "Task ".
  if (lower.startsWith("task ")) {
    const dueIdx = lower.indexOf(" is due.", 5)
    if (dueIdx > 5 && dueIdx <= 32) {
      const mid = trimmed.slice(5, dueIdx).trim()
      if (mid.length > 0 && isTicketKeyOrTask(mid)) {
        const trailing = trimmed.slice(dueIdx + 8).trim()
        if (trailing.length === 0) return true
        const trailingLower = trailing.toLowerCase()
        if (
          trailingLower === "added from meitheal" ||
          startsWithOpenInMeitheal(trailingLower, trailing) ||
          trailing.startsWith("📋 ")
        ) {
          return true
        }
      }
    }
  }

  // Minimal reminder header collapsed onto one line:
  //   "Task reminder. Added from Meitheal" or "Task reminder. Open in Meitheal: ..."
  if (lower.startsWith("task reminder.")) {
    const trailing = trimmed.slice(14).trim()
    const trailingLower = trailing.toLowerCase()
    if (
      trailingLower === "added from meitheal" ||
      startsWithOpenInMeitheal(trailingLower, trailing)
    ) {
      return true
    }
  }

  // Write-back / reminder metadata line: "📋 MTH-30" or "📋 MTH-30 · Status: ..."
  if (trimmed.startsWith("📋 ")) {
    const rest = trimmed.slice(2).trimStart()
    const sepIdx = rest.indexOf(" ")
    const firstToken = sepIdx === -1 ? rest : rest.slice(0, sepIdx)
    if (isStrictTicketKey(firstToken)) {
      if (sepIdx === -1) return true
      const after = rest.slice(sepIdx).trimStart()
      if (after.startsWith("·")) return true
    }
  }

  return false
}

/**
 * Strip any leading Meitheal ticket prefixes ("📋 MTH-30: ") and trailing
 * "— DUE" / "– DUE" / "- DUE" wrappers so outbound reminders and write-backs
 * can never recursively nest prefixes or suffixes.
 */
export function stripCalendarReminderWrappers(summary: string): string {
  let clean = summary.trim()
  if (!clean) return summary

  // Strip up to 32 nested prefixes in linear time
  for (let depth = 0; depth < 32; depth++) {
    const parsed = consumeTicketPrefix(clean)
    if (!parsed) break
    // Only strip a bare "Task:" if it carried a reminder emoji; always strip emoji + ticket key or repeated ticket keys
    if (!parsed.hadEmoji && !isStrictTicketKey(parsed.token)) break
    clean = parsed.rest
  }

  // Strip leading reminder emoji if followed by a DUE suffix (e.g. "📋 Pay rent — DUE")
  const { hadEmoji, rest } = stripLeadingReminderEmoji(clean)
  if (hadEmoji && endsWithDueSuffix(rest)) {
    clean = rest
  }

  // Strip trailing "— DUE" / "– DUE" / "- DUE" repetitions
  for (let depth = 0; depth < 32; depth++) {
    const upper = clean.trimEnd().toUpperCase()
    let stripped = false
    for (const suffix of DUE_SUFFIXES) {
      if (upper.endsWith(suffix) && upper.length > suffix.length) {
        clean = clean.trimEnd().slice(0, clean.trimEnd().length - suffix.length).trimEnd()
        stripped = true
        break
      }
    }
    if (!stripped) break
  }

  return clean.trim() || summary.trim()
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
      const { hadEmoji, rest } = stripLeadingReminderEmoji(trimmed)
      // Due-date reminder format: "📋 MTH-30: Title — DUE" or "📋 Title — DUE" (including en-dash/hyphen)
      if (hadEmoji && endsWithDueSuffix(rest)) {
        return true
      }

      const firstPrefix = consumeTicketPrefix(trimmed)
      if (firstPrefix !== null) {
        // Emoji + strict ticket key ("📋 MTH-15: ..."), even if Google Calendar truncated "— DUE"
        if (firstPrefix.hadEmoji && isStrictTicketKey(firstPrefix.token)) {
          return true
        }
        // Strict ticket key + DUE suffix even if emoji was stripped ("MTH-15: Title — DUE")
        if (isStrictTicketKey(firstPrefix.token) && endsWithDueSuffix(firstPrefix.rest)) {
          return true
        }
        // Recursive nested prefix loop artifact: "📋 MTH-34: 📋 MTH-30: ..." or "MTH-34: MTH-30: ..."
        if (consumeTicketPrefix(firstPrefix.rest) !== null) {
          return true
        }
      }
    }
  }

  return false
}
