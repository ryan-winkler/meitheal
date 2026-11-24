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

const legacyPredecessorStallExpressions = {
  ...stallExpressions,
  openStatuses: "'pending', 'todo', 'active', 'in_progress'",
  completeStatuses: "'complete', 'done'",
}
const legacyPredecessorStallDefinitions = new Map(
  taskStallTriggerDefinitions(legacyPredecessorStallExpressions).map(definition => [definition[0], definition]),
)

function matchesExactTriggerDefinition(trigger, definition) {
  if (!definition || trigger?.type !== "trigger") return false
  if (trigger.name !== definition[0] || trigger.tbl_name !== definition[1]) return false
  return typeof trigger.sql === "string" && trigger.sql.trim() === definition[2].trim()
}

async function currentStallExpressions(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  if (Number(version?.value) >= 26) return ordinaryStallExpressions
  const { rows } = await db.execute({
    sql: "SELECT name, type, tbl_name, sql FROM sqlite_schema WHERE name COLLATE NOCASE = ?",
    args: ["tasks_stall_transition"],
  })
  const existing = findActivityTrigger(rows, "tasks_stall_transition")
  const legacyDefinition = legacyPredecessorStallDefinitions.get("tasks_stall_transition")
  return matchesExactTriggerDefinition(existing, legacyDefinition) ? legacyPredecessorStallExpressions : stallExpressions
}

/** @type {Array<{ family: string, definitions: string[][], legacyDefinitions?: Map<string, string[]> }>} */
const triggerGroups = [
  { family: "inactivity", definitions: taskInactivityTriggerDefinitions },
  {
    family: "stall",
    definitions: taskStallTriggerDefinitions(stallExpressions),
    legacyDefinitions: legacyPredecessorStallDefinitions,
  },
]

export const taskWriteTriggerMetadata = activityTriggerCatalogQuery([
  taskDeferralTriggerName,
  ...triggerGroups.flatMap(group => group.definitions.map(([name]) => name)),
])

/** @param {import("@libsql/core/api").ResultSet} metadata */
export function validateExistingTaskWriteTriggers({ rows }) {
  validateExistingTaskDeferralTrigger(findActivityTrigger(rows, taskDeferralTriggerName))
  for (const { family, definitions, legacyDefinitions } of triggerGroups) {
    for (const definition of definitions) {
      const trigger = findActivityTrigger(rows, definition[0])
      if (!trigger) continue
      const legacy = legacyDefinitions?.get(definition[0])
      const expected = matchesExactTriggerDefinition(trigger, legacy) ? legacy : definition
      validateActivityTriggerDefinition(trigger, expected, family)
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
