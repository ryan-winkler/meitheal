/**
 * Natural Language Task Parser
 *
 * @domain tasks
 * @bounded-context tasks
 *
 * Parses task titles to extract structured metadata:
 * - Dates: "tomorrow", "next monday", "jan 15", "2025-01-15"
 * - Priorities: "!!" → P1, "!" → P2, "p1"-"p5"
 * - Labels: "#label", "#multi-word-label"
 * - Assignees: "@name"
 *
 * @kcs This is a pure function module — no side effects, no DB access.
 * Used by NewTaskModal for live parse preview and by quick-add APIs.
 *
 * Examples:
 *   "Buy groceries tomorrow !!" → { title: "Buy groceries", due_date: "2025-01-16", priority: 1 }
 *   "Fix bug #frontend @ryan p2" → { title: "Fix bug", labels: ["frontend"], assignee: "ryan", priority: 2 }
 *   "Meeting next monday" → { title: "Meeting", due_date: "2025-01-20" }
 */

export interface ParsedTask {
  /** Cleaned title with extracted tokens removed */
  title: string
  /** ISO date string (YYYY-MM-DD) or null */
  dueDate: string | null
  /** Priority 1-5 or null */
  priority: number | null
  /** Extracted labels */
  labels: string[]
  /** Assignee name or null */
  assignee: string | null
  /** Whether any NLP extraction occurred */
  hasExtractions: boolean
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
}

const MONTH_NAMES: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
}

/**
 * Parse a natural language task title and extract structured metadata.
 */
export function parseTaskInput(input: string, referenceDate?: Date): ParsedTask {
  const now = referenceDate ?? new Date()
  let remaining = input.trim()
  const result: ParsedTask = {
    title: "",
    dueDate: null,
    priority: null,
    labels: [],
    assignee: null,
    hasExtractions: false,
  }

  // ── Extract priority markers ──────────────────────────────

  // "!!" → P1, "!" → P2 (at word boundaries)
  if (/\s*!!\s*/.test(remaining)) {
    result.priority = 1
    remaining = remaining.replace(/\s*!!\s*/, " ")
    result.hasExtractions = true
  } else if (/\s*!\s*$/.test(remaining) || /\s*!\s+/.test(remaining)) {
    result.priority = 2
    remaining = remaining.replace(/\s*!\s*/, " ")
    result.hasExtractions = true
  }

  // "p1"-"p5" or "P1"-"P5" at word boundaries
  const priorityMatch = remaining.match(/\b[pP]([1-5])\b/)
  if (priorityMatch && result.priority === null) {
    result.priority = parseInt(priorityMatch[1]!, 10)
    remaining = remaining.replace(priorityMatch[0], " ")
    result.hasExtractions = true
  }

  // ── Extract labels (#tag) ─────────────────────────────────

  const labelRegex = /#([a-zA-Z0-9][\w-]*)/g
  let labelMatch
  while ((labelMatch = labelRegex.exec(remaining)) !== null) {
    result.labels.push(labelMatch[1]!)
    result.hasExtractions = true
  }
  remaining = remaining.replace(/#[a-zA-Z0-9][\w-]*/g, " ")

  // ── Extract assignee (@name) ──────────────────────────────

  const assigneeMatch = remaining.match(/@([a-zA-Z][\w.-]*)/)
  if (assigneeMatch) {
    result.assignee = assigneeMatch[1]!
    remaining = remaining.replace(assigneeMatch[0], " ")
    result.hasExtractions = true
  }

  // ── Extract dates ─────────────────────────────────────────

  const lc = remaining.toLowerCase()

  // "today"
  if (/\btoday\b/.test(lc)) {
    result.dueDate = formatDate(now)
    remaining = remaining.replace(/\btoday\b/i, " ")
    result.hasExtractions = true
  }

  // "tomorrow"
  else if (/\btomorrow\b/.test(lc)) {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    result.dueDate = formatDate(d)
    remaining = remaining.replace(/\btomorrow\b/i, " ")
    result.hasExtractions = true
  }

  // "next <day>" — e.g. "next monday"
  else {
    const nextDayMatch = remaining.match(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i)
    if (nextDayMatch) {
      const targetDay = DAY_NAMES[nextDayMatch[1]!.toLowerCase()]
      if (targetDay !== undefined) {
        const d = new Date(now)
        const currentDay = d.getDay()
        let daysAhead = targetDay - currentDay
        if (daysAhead <= 0) daysAhead += 7
        daysAhead += 7 // "next" implies the week after
        // But if daysAhead > 13, adjust (edge case: "next monday" when today is tuesday)
        if (daysAhead > 13) daysAhead -= 7
        d.setDate(d.getDate() + daysAhead)
        result.dueDate = formatDate(d)
        remaining = remaining.replace(nextDayMatch[0], " ")
        result.hasExtractions = true
      }
    }
  }

  // "this <day>" — e.g. "this friday"
  if (!result.dueDate) {
    const thisDayMatch = remaining.match(/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i)
    if (thisDayMatch) {
      const targetDay = DAY_NAMES[thisDayMatch[1]!.toLowerCase()]
      if (targetDay !== undefined) {
        const d = new Date(now)
        const currentDay = d.getDay()
        let daysAhead = targetDay - currentDay
        if (daysAhead <= 0) daysAhead += 7
        d.setDate(d.getDate() + daysAhead)
        result.dueDate = formatDate(d)
        remaining = remaining.replace(thisDayMatch[0], " ")
        result.hasExtractions = true
      }
    }
  }

  // "<day>" standalone — e.g. "monday" (assumes next occurrence)
  if (!result.dueDate) {
    const dayMatch = remaining.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)
    if (dayMatch) {
      const targetDay = DAY_NAMES[dayMatch[1]!.toLowerCase()]
      if (targetDay !== undefined) {
        const d = new Date(now)
        const currentDay = d.getDay()
        let daysAhead = targetDay - currentDay
        if (daysAhead <= 0) daysAhead += 7
        d.setDate(d.getDate() + daysAhead)
        result.dueDate = formatDate(d)
        remaining = remaining.replace(dayMatch[0], " ")
        result.hasExtractions = true
      }
    }
  }

  // "in X days/weeks" — e.g. "in 3 days", "in 2 weeks"
  if (!result.dueDate) {
    const inMatch = remaining.match(/\bin\s+(\d+)\s+(day|days|week|weeks)\b/i)
    if (inMatch) {
      const count = parseInt(inMatch[1]!, 10)
      const unit = inMatch[2]!.toLowerCase()
      const d = new Date(now)
      if (unit === "day" || unit === "days") {
        d.setDate(d.getDate() + count)
      } else {
        d.setDate(d.getDate() + count * 7)
      }
      result.dueDate = formatDate(d)
      remaining = remaining.replace(inMatch[0], " ")
      result.hasExtractions = true
    }
  }

  // "Jan 15" or "January 15" — month + day
  if (!result.dueDate) {
    const monthDayMatch = remaining.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i)
    if (monthDayMatch) {
      const month = MONTH_NAMES[monthDayMatch[1]!.toLowerCase()]
      const day = parseInt(monthDayMatch[2]!, 10)
      if (month !== undefined && day >= 1 && day <= 31) {
        const d = new Date(now.getFullYear(), month, day)
        // If date is past, assume next year
        if (d < now) d.setFullYear(d.getFullYear() + 1)
        result.dueDate = formatDate(d)
        remaining = remaining.replace(monthDayMatch[0], " ")
        result.hasExtractions = true
      }
    }
  }

  // ISO date "2025-01-15"
  if (!result.dueDate) {
    const isoMatch = remaining.match(/\b(\d{4}-\d{2}-\d{2})\b/)
    if (isoMatch) {
      result.dueDate = isoMatch[1]!
      remaining = remaining.replace(isoMatch[0], " ")
      result.hasExtractions = true
    }
  }

  // ── Clean up title ────────────────────────────────────────

  result.title = remaining.replace(/\s+/g, " ").trim()
  if (!result.title && input.trim()) {
    result.title = input.trim() // Fallback: if nothing left, use original
  }

  return result
}

function formatDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}
