import {
  activityTriggerCatalogQuery, completeStatuses, findActivityTrigger, inactivityDaysSql,
  openStatuses, taskTimestampMs, validateActivityTriggerDefinition,
} from "../task-activity-sql.mjs"
import { taskDeferralTriggerName, validateExistingTaskDeferralTrigger } from "./0004_task_deferral.mjs"
import {
  installTaskInactivityTriggers, taskInactivityTriggerDefinitions, validateTaskInactivityTriggers,
} from "./0007_task_inactivity.mjs"
import { installTaskStallTriggers, taskStallTriggerDefinitions, validateTaskStallTriggers } from "./0008_task_stall.mjs"

const stallExpressions = {
  newTaskDays: inactivityDaysSql(false, "NEW.area_id"),
  storedTaskDays: inactivityDaysSql(),
  openStatuses,
  completeStatuses,
  commentClock: taskTimestampMs("comment.created_at"),
}

function boardIdentity(alias) {
  return `COALESCE(${alias}.task_board_id, (SELECT id FROM task_boards WHERE storage_encoding = 'legacy_null_v1'))`
}
function placedArea(alias) {
  return `CASE WHEN ${alias}.task_board_id IS NULL THEN ${alias}.area_id ELSE (SELECT area_id FROM board_task_planning WHERE task_id = ${alias}.id) END`
}
function areaExists(alias) {
  return `EXISTS (SELECT 1 FROM areas WHERE id = (${placedArea(alias)}) AND (owner_board_id = ${alias}.task_board_id OR (owner_board_id IS NULL AND ${alias}.task_board_id IS NULL)))`
}
export const ordinaryStallExpressions = {
  ...stallExpressions,
  newTaskDays: inactivityDaysSql(false, placedArea("NEW"), boardIdentity("NEW")),
  storedTaskDays: inactivityDaysSql(false, placedArea("tasks"), boardIdentity("tasks")),
  newAreaExists: areaExists("NEW"), storedAreaExists: areaExists("tasks"),
}
export const ordinaryStallTriggerDefinitions = taskStallTriggerDefinitions(ordinaryStallExpressions)

async function currentStallExpressions(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  return Number(version?.value) >= 26 ? ordinaryStallExpressions : stallExpressions
}

const triggerGroups = [
  { family: "inactivity", definitions: taskInactivityTriggerDefinitions },
  { family: "stall", definitions: taskStallTriggerDefinitions(stallExpressions) },
]

export const taskWriteTriggerMetadata = activityTriggerCatalogQuery([
  taskDeferralTriggerName,
  ...triggerGroups.flatMap(group => group.definitions.map(([name]) => name)),
])

/** @param {import("@libsql/core/api").ResultSet} metadata */
export function validateExistingTaskWriteTriggers({ rows }) {
  validateExistingTaskDeferralTrigger(findActivityTrigger(rows, taskDeferralTriggerName))
  for (const { family, definitions } of triggerGroups) {
    for (const definition of definitions) {
      const trigger = findActivityTrigger(rows, definition[0])
      if (trigger) validateActivityTriggerDefinition(trigger, definition, family)
    }
  }
}

export async function installTaskActivityTriggers(tx) {
  await installTaskInactivityTriggers(tx)
  await installTaskStallTriggers(tx, await currentStallExpressions(tx))
}

export async function validateTaskActivityTriggers(db) {
  await validateTaskInactivityTriggers(db)
  await validateTaskStallTriggers(db, await currentStallExpressions(db))
}
