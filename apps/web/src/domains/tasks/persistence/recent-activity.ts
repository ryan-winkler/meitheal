import { createHash } from "node:crypto"
import type { Client, InStatement, InValue } from "@libsql/client"
import { getStatusDef, STATUS } from "../../../lib/status-config"

export const VERIFIED_ORIGIN_KINDS = [
  "conversation_agent",
  "ha_automation",
  "ha_script",
  "webhook",
  "mcp",
  "agent_token",
] as const

export type VerifiedOriginKind = (typeof VERIFIED_ORIGIN_KINDS)[number]

export interface VerifiedActivityProvenance {
  tokenName: string
  originKind?: VerifiedOriginKind | null
  originName?: string | null
  originTarget?: string | null
}

export interface RecentTaskActor {
  kind: "human" | "agent" | "system"
  personKey: string | null
  provenance?: VerifiedActivityProvenance | null
}

export type RecentTaskAction = "added" | "edited" | "closed" | "reopened"
type Cursor = { at: number; id: number }

const ORIGIN_KIND_SET = new Set<string>(VERIFIED_ORIGIN_KINDS)

export function sanitizeOriginKind(value: unknown): VerifiedOriginKind | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return ORIGIN_KIND_SET.has(normalized) ? (normalized as VerifiedOriginKind) : null
}

/**
 * The Home Assistant integration percent-encodes UTF-8 origin names because
 * Node reads header values as Latin-1. Values that are not valid
 * percent-encoding (for example "100% done") are kept as sent.
 */
export function decodeOriginHeader(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  if (!/%[0-9a-fA-F]{2}/.test(value)) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const INVISIBLE_FORMAT_CHARS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/g

export function sanitizeOriginName(value: unknown): string | null {
  if (typeof value !== "string") return null
  // C0/C1 controls become spaces. Invisible and bidi formatting characters (U+200B-200F,
  // U+202A-202E, U+2066-2069, U+FEFF...) are removed so an origin name cannot reorder or
  // hide the verified token name it is displayed next to.
  // Controls become spaces first, so a control character inside the label below
  // ("(via\u0001token …)") cannot slip past the label check and turn into a space after it.
  const cleaned = value
    .replace(INVISIBLE_FORMAT_CHARS, "")
    .replace(/[\r\n\t\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    // The feed appends the verified token as `(via token "…")`; an origin name cannot
    // carry its own copy of that label to pose as a different token.
    .trim()
  // Removing one label can join the pieces of another ("(via (via token "A")token "B")"), so
  // repeat until none is left. Each pass shortens the text, so the loop always ends.
  let withoutLabels = cleaned
  for (let pass = 0; pass < 64; pass++) {
    const next = withoutLabels.replace(/\(\s*via\s+token\b[^)]*\)?/gi, " ").replace(/\s+/g, " ").trim()
    if (next === withoutLabels) break
    withoutLabels = next
  }
  const result = withoutLabels.slice(0, 120).trim()
  return result || null
}

/**
 * Origin targets are caller-supplied, so each origin kind may only link to the
 * Home Assistant page that kind has, or to Meitheal settings. Home Assistant
 * targets never carry a query string or fragment, which keeps links such as
 * `/auth/authorize?client_id=…` out of the feed.
 */
const HA_TARGET_PREFIXES: Partial<Record<VerifiedOriginKind, string>> = {
  ha_automation: "/config/automation",
  ha_script: "/config/script",
  conversation_agent: "/config/voice-assistants",
}

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

export function isSettingsOriginTarget(target: string): boolean {
  return target === "/settings"
    || target.startsWith("/settings#")
    || target.startsWith("/settings?")
    || target.startsWith("/settings/")
}

export function sanitizeOriginTarget(value: unknown, kind?: VerifiedOriginKind | null): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 512) return null
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\")) return null
  if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed, "https://meitheal.local")
    if (parsed.origin !== "https://meitheal.local" || !parsed.pathname.startsWith("/")) return null
  } catch {
    return null
  }
  if (isSettingsOriginTarget(trimmed)) {
    // Judge the path the browser will actually request: "/settings/../auth/authorize" starts
    // with "/settings/" as written but normalizes to "/auth/authorize".
    const writtenPath = trimmed.split(/[?#]/, 1)[0]
    const inSettings = parsed.pathname === "/settings" || parsed.pathname.startsWith("/settings/")
    return inSettings && writtenPath === parsed.pathname ? trimmed : null
  }
  if (parsed.search || parsed.hash) return null
  const prefixes = kind
    ? [HA_TARGET_PREFIXES[kind]].filter((prefix): prefix is string => typeof prefix === "string")
    : Object.values(HA_TARGET_PREFIXES)
  return prefixes.some(prefix => matchesPathPrefix(parsed.pathname, prefix)) ? trimmed : null
}

function serializeProvenanceSummary(actor: RecentTaskActor): string | null {
  if (actor.kind !== "agent" || !actor.provenance) return null
  const tokenName = sanitizeOriginName(actor.provenance.tokenName)
  if (!tokenName) return null
  const originKind = sanitizeOriginKind(actor.provenance.originKind)
  const originName = sanitizeOriginName(actor.provenance.originName)
  const originTarget = sanitizeOriginTarget(actor.provenance.originTarget, originKind)
  return JSON.stringify({
    v: 1,
    tokenName,
    ...(originKind ? { originKind } : {}),
    ...(originName ? { originName } : {}),
    ...(originTarget ? { originTarget } : {}),
  })
}

function parseProvenanceSummary(
  summary: unknown,
  fallbackSource: unknown,
  fallbackCreatedBy: unknown,
  feedAction: unknown,
): VerifiedActivityProvenance | null {
  let parsed: Record<string, unknown> | null = null
  if (typeof summary === "string" && summary.startsWith("{")) {
    try {
      const candidate: unknown = JSON.parse(summary)
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      parsed = null
    }
  }
  const summaryToken = parsed ? sanitizeOriginName(parsed.tokenName) : null
  // Rows written before provenance existed carry no token in `summary`. Only the
  // "added" row can be credited to the creating token; a later edit, close or
  // reopen may have come from a different token, so it stays unattributed.
  const fallbackToken = feedAction === "added" && fallbackSource === "agent"
    ? sanitizeOriginName(fallbackCreatedBy)
    : null
  const tokenName = summaryToken ?? fallbackToken
  if (!tokenName) return null
  const originKind = parsed ? sanitizeOriginKind(parsed.originKind) : "agent_token"
  return {
    tokenName,
    originKind,
    originName: parsed ? sanitizeOriginName(parsed.originName) : null,
    originTarget: parsed ? sanitizeOriginTarget(parsed.originTarget, originKind) : null,
  }
}

export function recentActivityPersonKey(id: string): string {
  return createHash("sha256").update(`recent-activity-person:${id}`).digest("hex").slice(0, 32)
}

export function taskAddedActivity(taskId: string, actor: RecentTaskActor, at: number): InStatement {
  const summary = serializeProvenanceSummary(actor) ?? "Task added"
  return {
    sql: `INSERT INTO task_activity_log
            (task_id, field, actor, actor_type, event_type, summary, created_at, feed_action, feed_person_key)
          SELECT id, 'created', ?, ?, 'created', ?, ?, 'added', ?
          FROM tasks WHERE id = ? AND task_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')`,
    args: [actor.kind, actor.kind, summary, at, actor.personKey, taskId],
  }
}

function statusValues(status: string): readonly string[] {
  return [status, ...(getStatusDef(status)?.aliases ?? [])]
}

function statusMatches(status: string): string {
  return `lower(status) IN (${statusValues(status).map(() => "?").join(", ")})`
}

/** Read the old row with the same guards as the following task update. */
export function taskChangedActivity(
  fields: Record<string, InValue>,
  where: string,
  whereArgs: InValue[],
  actor: RecentTaskActor,
  at: number,
  eventId: string,
): InStatement {
  const summary = serializeProvenanceSummary(actor)
  const args: InValue[] = [actor.kind, actor.kind, summary, eventId, at]
  let action = "'edited'"
  if (typeof fields.status === "string") {
    action = fields.status === STATUS.COMPLETE
      ? `CASE WHEN ${statusMatches(STATUS.COMPLETE)} THEN 'edited' ELSE 'closed' END`
      : `CASE WHEN ${statusMatches(STATUS.COMPLETE)} THEN 'reopened' ELSE 'edited' END`
    args.push(...statusValues(STATUS.COMPLETE))
  }
  args.push(actor.personKey, ...whereArgs)
  const changes = Object.entries(fields).map(([column, value]) => {
    if (column === "status" && typeof value === "string") {
      args.push(...statusValues(value))
      return `NOT (${statusMatches(value)})`
    }
    args.push(value)
    return `${column} IS NOT ?`
  })

  return {
    sql: `INSERT INTO task_activity_log
            (task_id, field, actor, actor_type, event_type, summary, correlation_id, created_at, feed_action, feed_person_key)
          SELECT id, 'activity', ?, ?, 'field_change', ?, ?, ?, ${action}, ?
          FROM tasks ${where} AND task_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND (${changes.join(" OR ")})`,
    args,
  }
}

/** A trigger may ignore an update. Remove only this batch's uncommitted event in that case. */
export function discardUnappliedTaskActivity(eventId: string): InStatement {
  return {
    sql: "DELETE FROM task_activity_log WHERE id = last_insert_rowid() AND changes() = 0 AND correlation_id = ?",
    args: [eventId],
  }
}

export async function readRecentActivity(
  client: Client,
  { areaId, personKey, before }: { areaId?: string | undefined; personKey?: string | undefined; before?: Cursor | undefined },
) {
  const size = 25
  const conditions = ["activity.feed_action IN ('added', 'edited', 'closed', 'reopened')"]
  const args: InValue[] = []
  if (areaId) {
    conditions.push("area.id = ?")
    args.push(areaId)
  }
  if (personKey) {
    conditions.push("activity.feed_person_key = ?")
    args.push(personKey)
  }
  if (before) {
    conditions.push("(activity.created_at, activity.id) < (?, ?)")
    args.push(before.at, before.id)
  }
  const result = await client.execute({
    sql: `SELECT activity.id, activity.created_at, activity.feed_action, activity.feed_person_key,
                 activity.actor_type, activity.summary,
                 task.id AS task_id, task.title, task.ticket_number, task.created_by, task.source,
                 area.name AS area_name
          FROM task_activity_log AS activity
          JOIN tasks AS task ON task.id = activity.task_id AND task.task_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')
          LEFT JOIN areas AS area ON area.id = task.area_id AND area.owner_board_id IS NULL AND area.retired_at IS NULL
          WHERE ${conditions.join(" AND ")}
          ORDER BY activity.created_at DESC, activity.id DESC LIMIT ?`,
    args: [...args, size + 1],
  })
  const items = result.rows.slice(0, size).map(row => {
    const kind = String(row.actor_type)
    // Only expose verified token/origin provenance for rows recorded by an authenticated agent token.
    const provenance = kind === "agent"
      ? parseProvenanceSummary(row.summary, row.source, row.created_by, row.feed_action)
      : null
    return {
      id: Number(row.id),
      at: Number(row.created_at),
      action: String(row.feed_action) as RecentTaskAction,
      personKey: row.feed_person_key == null ? null : String(row.feed_person_key),
      kind,
      provenance,
      taskId: String(row.task_id),
      title: String(row.title),
      ticketNumber: row.ticket_number == null ? null : Number(row.ticket_number),
      areaName: row.area_name == null ? null : String(row.area_name),
    }
  })
  const last = items.at(-1)
  const next = last && result.rows.length > size ? { at: last.at, id: last.id } : null
  return { items, next }
}
