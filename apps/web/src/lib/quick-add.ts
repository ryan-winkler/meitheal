/**
 * Shared quick add: one parser for the Dashboard and Today quick add forms.
 *
 * @domain tasks
 * @bounded-context tasks
 * @kcs Pure module. "shopping:" and "errand:" create one checklist task.
 */
import { createChecklistItem } from "./checklist-items"
import { parseTaskInput, type ParsedTask } from "./nl-task-parser"
import type { TaskCreatePayload } from "./task-api-client"

/** Today's calendar day (YYYY-MM-DD) in the household timezone, not in UTC. */
export function householdToday(now = new Date()): string {
  const timeZone = typeof window !== "undefined" ? window.mSettings?.timezone : undefined
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  } catch {
    return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  }
}

/** The household calendar day a whole number of days from today (YYYY-MM-DD). */
export function householdDayFromToday(days: number, now = new Date()): string {
  const day = new Date(`${householdToday(now)}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() + days)
  return day.toISOString().slice(0, 10)
}

export function parseQuickTask(input: string): ParsedTask {
  if (typeof window !== "undefined" && window.__featureFlags?.nlp_parser === false) {
    return { title: input.trim(), dueDate: null, priority: null, labels: [], assignee: null, hasExtractions: false }
  }
  return parseTaskInput(input)
}

const CHECKLIST_LISTS = [
  { pattern: /^shopping:\s*(.+)/i, title: "Shopping", label: "shopping", taskKind: "shopping_item" as const },
  { pattern: /^errand:\s*(.+)/i, title: "Errands", label: "errands", taskKind: "checklist" as const },
] as const

function parseShoppingToken(raw: string): { name: string; qty: number } {
  const leading = raw.match(/^(\d+)\s*[x×]\s+(.+)$/i)
  if (leading) {
    const qty = Math.min(999, Math.max(1, Number(leading[1])))
    return { name: leading[2]!.trim(), qty }
  }
  const trailing = raw.match(/^(.+?)\s*(?:\((\d+)\)|[x×]\s*(\d+))$/i)
  if (trailing) {
    const qty = Math.min(999, Math.max(1, Number(trailing[2] ?? trailing[3])))
    return { name: trailing[1]!.trim(), qty }
  }
  return { name: raw, qty: 1 }
}

/** Build the create payload for quick add text. defaultDueDate applies only when the text names no date. */
export function quickAddPayload(text: string, defaultDueDate: string | null = null): { payload: TaskCreatePayload; parsed: ParsedTask } {
  const parsed = parseQuickTask(text)
  const payload: TaskCreatePayload = { title: parsed.title || text.trim() }
  const dueDate = parsed.dueDate ?? defaultDueDate
  if (dueDate) payload.due_date = dueDate
  if (parsed.priority) payload.priority = parsed.priority
  if (parsed.labels.length > 0) payload.labels = JSON.stringify(parsed.labels)
  if (parsed.assignee) payload.assigned_to = parsed.assignee

  const cleanedSource = (parsed.title || text).trim()
  for (const list of CHECKLIST_LISTS) {
    const match = cleanedSource.match(list.pattern) ?? text.trim().match(list.pattern)
    if (!match) continue
    const rawItems = match[1]!.split(",").map(item => item.trim()).filter(Boolean)
    payload.title = list.title
    payload.task_kind = list.taskKind
    payload.labels = JSON.stringify([...new Set([...parsed.labels, list.label])])
    if (list.taskKind === "shopping_item") {
      const structured = rawItems.map(entry => {
        const { name, qty } = parseShoppingToken(entry)
        return { name, qty, category: "" }
      })
      payload.custom_fields = JSON.stringify({ items: structured })
      payload.checklists = JSON.stringify(
        structured.map(item => createChecklistItem(item.qty > 1 ? `${item.qty}× ${item.name}` : item.name)),
      )
    } else {
      payload.checklists = JSON.stringify(rawItems.map(createChecklistItem))
    }
    break
  }
  return { payload, parsed }
}
