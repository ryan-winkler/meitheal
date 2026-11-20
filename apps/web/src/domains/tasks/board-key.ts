/**
 * Board Key — Pure domain rules for human-readable Board ticket prefixes (e.g. MTH, WRK, GRD).
 *
 * Keeps Board Key formatting, validation, auto-suggestion, and ticket_ref rewriting
 * decoupled from persistence and UI layers.
 */

export const BOARD_KEY_MIN_LENGTH = 2
export const BOARD_KEY_MAX_LENGTH = 10
export const BOARD_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/

const RESERVED_KEYS = new Set([
  "API",
  "NEW",
  "EDIT",
  "ADMIN",
  "NULL",
  "UNDEFINED",
])

export type BoardKeyValidation =
  | { ok: true; key: string }
  | { ok: false; error: string }

/** Normalize user input into an uppercase alphanumeric Board Key candidate. */
export function normalizeBoardKey(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, BOARD_KEY_MAX_LENGTH)
}

/** Validate a user-supplied Board Key before persistence. */
export function validateBoardKey(raw: string): BoardKeyValidation {
  const trimmed = raw.trim().toUpperCase()
  if (!trimmed) {
    return { ok: false, error: "Enter a Board key of 2 to 10 letters or numbers." }
  }
  if (!/^[A-Z]/.test(trimmed)) {
    return { ok: false, error: "Board key must start with a letter (A–Z)." }
  }
  if (!BOARD_KEY_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error: `Use ${BOARD_KEY_MIN_LENGTH} to ${BOARD_KEY_MAX_LENGTH} uppercase letters or numbers (for example MTH or HOME2).`,
    }
  }
  if (RESERVED_KEYS.has(trimmed)) {
    return { ok: false, error: `"${trimmed}" is reserved. Choose another Board key.` }
  }
  return { ok: true, key: trimmed }
}

/**
 * Derive a short, memorable Board Key suggestion from a Board name.
 * - Multi-word names use initials (e.g. "Home Garden" -> "HG", "Side Hustle Lab" -> "SHL")
 * - Single-word names prefer consonants/leading letters up to 4 chars (e.g. "Garden" -> "GRD", "Work" -> "WRK")
 * - Always returns a valid key matching BOARD_KEY_PATTERN (fallback "BRD").
 */
export function suggestBoardKey(boardName: string): string {
  const cleaned = boardName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
  const words = cleaned
    .split(/[^A-Z0-9]+/)
    .map((part) => part.replace(/^[^A-Z]+/, ""))
    .filter((part) => part.length > 0)

  let candidate = ""
  if (words.length >= 2) {
    candidate = words
      .map((word) => word[0] ?? "")
      .join("")
      .slice(0, 4)
  } else if (words.length === 1) {
    const word = words[0]!
    if (word.length <= 4) {
      candidate = word
    } else {
      const consonants = word[0]! + word.slice(1).replace(/[AEIOU]/g, "")
      candidate = (consonants.length >= 3 ? consonants : word).slice(0, 3)
    }
  }

  candidate = normalizeBoardKey(candidate)
  if (!BOARD_KEY_PATTERN.test(candidate) || RESERVED_KEYS.has(candidate)) {
    const lettersOnly = cleaned.replace(/[^A-Z]/g, "").slice(0, 3)
    candidate = lettersOnly.length >= BOARD_KEY_MIN_LENGTH && !RESERVED_KEYS.has(lettersOnly)
      ? lettersOnly
      : "BRD"
  }
  return candidate
}

/** Rewrite an existing ticket reference (`OLD-42`) to use a new Board Key (`NEW-42`). */
export function rewriteTicketRefPrefix(
  ticketRef: string | null | undefined,
  newPrefix: string,
): string | null {
  if (!ticketRef) return null
  const dash = ticketRef.lastIndexOf("-")
  if (dash <= 0) return null
  const suffix = ticketRef.slice(dash + 1)
  if (!/^\d+$/.test(suffix)) return null
  return `${newPrefix}-${Number(suffix)}`
}

/**
 * Format a task's display ticket key, preferring the persisted/board-scoped `ticket_key`
 * and falling back gracefully to `${fallbackPrefix}-${ticketNumber}` when absent.
 */
export function formatBoardTicketKey(
  ticketKey: string | null | undefined,
  ticketNumber: number | null | undefined,
  fallbackPrefix = "MTH",
): string | null {
  if (typeof ticketKey === "string" && ticketKey.trim()) {
    return ticketKey.trim().toUpperCase()
  }
  if (typeof ticketNumber === "number" && Number.isSafeInteger(ticketNumber) && ticketNumber > 0) {
    return `${fallbackPrefix}-${ticketNumber}`
  }
  return null
}
