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
  await installTaskStallTriggers(tx, stallExpressions)
}

export async function validateTaskActivityTriggers(db) {
  await validateTaskInactivityTriggers(db)
  await validateTaskStallTriggers(db, stallExpressions)
}
