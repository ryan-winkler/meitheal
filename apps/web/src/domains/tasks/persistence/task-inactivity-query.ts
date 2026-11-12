import { activeStatuses, inactivityDaysSql, openStatuses } from "../../../../drizzle/task-activity-sql.mjs"
import { openTaskDependenciesSql } from "./task-dependencies"
import { taskTimestampMs } from "./task-timestamp"

export { inactivityDaysSql, validInactivityRevisionSql } from "../../../../drizzle/task-activity-sql.mjs"

export const inactivityPageSize = 25
export const inactivityDayMs = 86_400_000
export const inactivityUpcomingMs = 7 * inactivityDayMs
export const inactivityStallMs = 14 * inactivityDayMs
export const inactivityRuleActor = "inactivity-rule"

const created = taskTimestampMs("tasks.created_at")
const updated = taskTimestampMs("tasks.updated_at")
const lastComment = `(SELECT MAX(${taskTimestampMs("comment.created_at")})
  FROM comments comment WHERE comment.task_id = tasks.id)`
const touched = `CASE WHEN typeof(tasks.inactivity_touched_at) = 'integer'
  THEN tasks.inactivity_touched_at ELSE 0 END`

export const inactivityClockSql = `MAX(${created}, ${updated}, ${touched}, COALESCE(${lastComment}, 0))`

const protectedFields = [
  "due_date", "reminder_at", "start_date", "end_date", "time_block_start", "time_block_end",
  "recurrence_rule", "routine_template_id", "spawned_for_date", "source_template_id",
]
const unscheduled = protectedFields.map(field => `NULLIF(trim(tasks.${field}, char(9,10,11,12,13,32)), '') IS NULL`).join(" AND ")

export const inactivityOpenTaskSql = `tasks.deferred_at IS NULL
  AND lower(tasks.status) IN (${openStatuses})
  AND ${created} > 0 AND ${updated} > 0
  AND EXISTS (SELECT 1 FROM areas WHERE areas.id = tasks.area_id)`

export const inactivityProtectionSql = `tasks.task_kind IS NOT 'routine_instance'
  AND (lower(tasks.status) NOT IN (${activeStatuses})
    OR NOT EXISTS (${openTaskDependenciesSql("tasks.id")}))
  AND ${unscheduled}
  AND NOT EXISTS (SELECT 1 FROM calendar_confirmations WHERE task_id = tasks.id)`

export const inactivityTaskSql = `${inactivityOpenTaskSql} AND ${inactivityProtectionSql}`

// A malformed persisted timestamp cannot make a task appear stalled.
export const inactivitySpikeSql = `CASE WHEN typeof(tasks.last_activity_spike_at) = 'integer'
  AND tasks.last_activity_spike_at BETWEEN 1 AND 9007199254740991 THEN tasks.last_activity_spike_at END`

export function inactivityStallSinceSql(now: string) {
  return `CASE WHEN MAX(spike_at, last_activity) <= ${now} - ${inactivityStallMs}
    THEN MAX(spike_at, last_activity) + ${inactivityStallMs} END`
}

/** Read the current policy and clock again inside the same audited write batch. */
export function inactivityWriteGuard(now: number) {
  const days = inactivityDaysSql()
  return {
    sql: `${inactivityTaskSql} AND (${days}) BETWEEN 1 AND 365
      AND ${inactivityClockSql} + (${days}) * ${inactivityDayMs} <= ?`,
    args: [now],
  }
}
