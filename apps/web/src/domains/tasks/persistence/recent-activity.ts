import { createHash } from "node:crypto"
import type { Client, InStatement, InValue } from "@libsql/client"
import { getStatusDef, STATUS } from "../../../lib/status-config"

export interface RecentTaskActor {
  kind: "human" | "agent" | "system"
  personKey: string | null
}

export type RecentTaskAction = "added" | "edited" | "closed" | "reopened"
type Cursor = { at: number; id: number }

export function recentActivityPersonKey(id: string): string {
  return createHash("sha256").update(`recent-activity-person:${id}`).digest("hex").slice(0, 32)
}

export function taskAddedActivity(taskId: string, actor: RecentTaskActor, at: number): InStatement {
  return {
    sql: `INSERT INTO task_activity_log
            (task_id, field, actor, actor_type, event_type, summary, created_at, feed_action, feed_person_key)
          SELECT id, 'created', ?, ?, 'created', 'Task added', ?, 'added', ?
          FROM tasks WHERE id = ?`,
    args: [actor.kind, actor.kind, at, actor.personKey, taskId],
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
  const args: InValue[] = [actor.kind, actor.kind, eventId, at]
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
            (task_id, field, actor, actor_type, event_type, correlation_id, created_at, feed_action, feed_person_key)
          SELECT id, 'activity', ?, ?, 'field_change', ?, ?, ${action}, ?
          FROM tasks ${where} AND (${changes.join(" OR ")})`,
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
  { areaId, personKey, before }: { areaId?: string; personKey?: string; before?: Cursor },
) {
  const size = 25
  const conditions = ["activity.feed_action IN ('added', 'edited', 'closed', 'reopened')"]
  const args: InValue[] = []
  if (areaId) {
    conditions.push("task.area_id = ?")
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
                 activity.actor_type, task.id AS task_id, task.title, task.ticket_number, area.name AS area_name
          FROM task_activity_log AS activity
          JOIN tasks AS task ON task.id = activity.task_id
          LEFT JOIN areas AS area ON area.id = task.area_id
          WHERE ${conditions.join(" AND ")}
          ORDER BY activity.created_at DESC, activity.id DESC LIMIT ?`,
    args: [...args, size + 1],
  })
  const items = result.rows.slice(0, size).map(row => ({
    id: Number(row.id),
    at: Number(row.created_at),
    action: String(row.feed_action) as RecentTaskAction,
    personKey: row.feed_person_key == null ? null : String(row.feed_person_key),
    kind: String(row.actor_type),
    taskId: String(row.task_id),
    title: String(row.title),
    ticketNumber: row.ticket_number == null ? null : Number(row.ticket_number),
    areaName: row.area_name == null ? null : String(row.area_name),
  }))
  const last = items.at(-1)
  const next = last && result.rows.length > size ? { at: last.at, id: last.id } : null
  return { items, next }
}
