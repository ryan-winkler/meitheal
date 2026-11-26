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

export interface QuickAddUserCandidate {
  id: string
  name?: string | null
  displayName?: string | null
  username?: string | null
}

/**
 * Resolve a raw Quick Add @mention handle against accessible household users.
 * Returns null if no user matches so task creation never submits an invalid assignee ID.
 */
export function resolveQuickAddAssignee(
  rawAssignee: string | null | undefined,
  users: readonly QuickAddUserCandidate[],
): { matchedId: string | null; displayName: string | null } {
  const needle = typeof rawAssignee === "string" ? rawAssignee.trim().replace(/^@+/, "").toLowerCase() : ""
  if (!needle || users.length === 0) return { matchedId: null, displayName: null }

  const normalized = users
    .filter((u): u is QuickAddUserCandidate => Boolean(u && typeof u.id === "string" && u.id.trim()))
    .map(user => ({
      id: user.id.trim(),
      label: String(user.displayName || user.name || user.username || user.id).trim(),
      keys: [user.id, user.username, user.name, user.displayName]
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map(v => v.trim().toLowerCase()),
    }))

  const exact = normalized.find(u => u.keys.includes(needle))
  if (exact) return { matchedId: exact.id, displayName: exact.label }

  const tokenExact = normalized.find(u => u.keys.some(k => k.split(/[\s._-]+/).includes(needle)))
  if (tokenExact) return { matchedId: tokenExact.id, displayName: tokenExact.label }

  const prefix = normalized.find(u => u.keys.some(k => k.startsWith(needle)))
  if (prefix) return { matchedId: prefix.id, displayName: prefix.label }

  return { matchedId: null, displayName: null }
}

let cachedQuickAddUsers: { users: QuickAddUserCandidate[]; fetchedAt: number } | null = null

export async function fetchQuickAddUsers(signal?: AbortSignal): Promise<QuickAddUserCandidate[]> {
  if (typeof window !== "undefined") {
    const preloaded = (window as unknown as { __meitheal_users?: QuickAddUserCandidate[] }).__meitheal_users
    if (Array.isArray(preloaded) && preloaded.length > 0) return preloaded
  }
  const now = Date.now()
  if (cachedQuickAddUsers && now - cachedQuickAddUsers.fetchedAt < 30_000) {
    return cachedQuickAddUsers.users
  }
  try {
    const res = await fetch("/api/users", { cache: "no-store", signal })
    if (!res.ok) return []
    const data = await res.json().catch(() => null) as { users?: QuickAddUserCandidate[] } | null
    const users = Array.isArray(data?.users) ? data.users : []
    cachedQuickAddUsers = { users, fetchedAt: now }
    return users
  } catch {
    return []
  }
}

export interface QuickAddPayloadOptions {
  /** When supplied, resolves @mentions against valid users and omits unmatched handles. */
  users?: readonly QuickAddUserCandidate[]
}

/** Build the create payload for quick add text. defaultDueDate applies only when the text names no date. */
export function quickAddPayload(
  text: string,
  defaultDueDate: string | null = null,
  options?: QuickAddPayloadOptions,
): { payload: TaskCreatePayload; parsed: ParsedTask; unresolvedAssignee: string | null } {
  const parsed = parseQuickTask(text)
  const payload: TaskCreatePayload = { title: parsed.title || text.trim() }
  const dueDate = parsed.dueDate ?? defaultDueDate
  if (dueDate) payload.due_date = dueDate
  if (parsed.priority) payload.priority = parsed.priority
  if (parsed.labels.length > 0) payload.labels = JSON.stringify(parsed.labels)
  let unresolvedAssignee: string | null = null
  if (parsed.assignee) {
    if (options?.users) {
      const resolved = resolveQuickAddAssignee(parsed.assignee, options.users)
      if (resolved.matchedId) payload.assigned_to = resolved.matchedId
      else unresolvedAssignee = parsed.assignee
    } else {
      payload.assigned_to = parsed.assignee
    }
  }

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
        return { name, qty, unit: "pcs", category: "" }
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
  return { payload, parsed, unresolvedAssignee }
}

export function formatQuickAddPreviewText(text: string, users: readonly QuickAddUserCandidate[]): string {
  const { parsed } = quickAddPayload(text, null, { users })
  const assigneeHint = parsed.assignee
    ? (() => {
        const resolved = resolveQuickAddAssignee(parsed.assignee, users)
        return resolved.displayName ? `@${resolved.displayName}` : `@${parsed.assignee} (unmatched)`
      })()
    : null
  return [
    parsed.dueDate && `Due ${parsed.dueDate}`,
    parsed.priority && `P${parsed.priority}`,
    ...parsed.labels.map(l => `#${l}`),
    assigneeHint,
  ].filter(Boolean).join(" · ")
}

