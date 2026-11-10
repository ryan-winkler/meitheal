import { getStatusDef, STATUS } from "../../../lib/status-config"
import { openTaskDependenciesSql } from "./task-dependencies"
import { taskTimestampMs } from "./task-timestamp"

export const inactivityPageSize = 25
export const inactivityDayMs = 86_400_000
export const inactivityUpcomingMs = 7 * inactivityDayMs
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

const acceptedStatusSql = (status: string) => [status, ...(getStatusDef(status)?.aliases ?? [])]
  .map(value => `'${value}'`).join(", ")
const activeStatuses = acceptedStatusSql(STATUS.ACTIVE)
const openStatuses = `${acceptedStatusSql(STATUS.PENDING)}, ${activeStatuses}`

export const inactivityTaskSql = `tasks.deferred_at IS NULL
  AND lower(tasks.status) IN (${openStatuses})
  AND tasks.task_kind IS NOT 'routine_instance'
  AND (lower(tasks.status) NOT IN (${activeStatuses})
    OR NOT EXISTS (${openTaskDependenciesSql("tasks.id")}))
  AND ${created} > 0 AND ${updated} > 0
  AND EXISTS (SELECT 1 FROM areas WHERE areas.id = tasks.area_id)
  AND ${unscheduled}
  AND NOT EXISTS (SELECT 1 FROM calendar_confirmations WHERE task_id = tasks.id)`

export const validInactivityRevisionSql = "length(CAST(revision AS BLOB)) = 32 AND revision NOT GLOB '*[^0-9a-f]*'"
const validatedDays = `CASE WHEN ${validInactivityRevisionSql} THEN days ELSE 0 END`
const defaultDays = `(SELECT ${validatedDays} FROM task_inactivity_policy WHERE scope = 'default')`

export function inactivityDaysSql(simulate = false, area = "tasks.area_id"): string {
  const areaDays = `(SELECT ${validatedDays} FROM task_inactivity_policy WHERE area_id = ${area})`
  const base = simulate ? `CASE WHEN input.area_id IS NULL THEN COALESCE(input.proposed, ${defaultDays}) ELSE ${defaultDays} END` : defaultDays
  const override = simulate ? `CASE WHEN input.area_id IS NOT NULL THEN COALESCE(input.proposed, ${areaDays}) ELSE ${areaDays} END` : areaDays
  return `COALESCE(NULLIF((${override}), -1), (${base}), 0)`
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
