import { TASK_STATUS, TASK_STATUS_ALIASES } from "@meitheal/domain-tasks/status-values"

/** @param {(typeof TASK_STATUS)[keyof typeof TASK_STATUS]} status */
function acceptedStatusSql(status) {
  return [status, ...TASK_STATUS_ALIASES[status]].map(value => `'${value}'`).join(", ")
}

export const activeStatuses = acceptedStatusSql(TASK_STATUS.ACTIVE)
export const openStatuses = `${acceptedStatusSql(TASK_STATUS.PENDING)}, ${activeStatuses}`
export const completeStatuses = acceptedStatusSql(TASK_STATUS.COMPLETE)

export const validInactivityRevisionSql = "length(revision) = 32 AND length(CAST(revision AS BLOB)) = 32 AND revision NOT GLOB '*[^0-9a-f]*'"
const validatedDays = `CASE WHEN ${validInactivityRevisionSql} THEN days ELSE 0 END`
const defaultDays = `(SELECT ${validatedDays} FROM task_inactivity_policy WHERE scope = 'default')`

export function inactivityDaysSql(simulate = false, area = "tasks.area_id") {
  const areaDays = `(SELECT ${validatedDays} FROM task_inactivity_policy WHERE area_id = ${area})`
  const base = simulate ? `CASE WHEN input.area_id IS NULL THEN COALESCE(input.proposed, ${defaultDays}) ELSE ${defaultDays} END` : defaultDays
  const override = simulate ? `CASE WHEN input.area_id IS NOT NULL THEN COALESCE(input.proposed, ${areaDays}) ELSE ${areaDays} END` : areaDays
  return `COALESCE(NULLIF((${override}), -1), (${base}), 0)`
}

/** Normalize the epoch and legacy ISO values stored by task writers. */
export function taskTimestampMs(column) {
  return `MAX(0, COALESCE(CASE
    WHEN typeof(${column}) IN ('integer', 'real') AND ${column} <= 9007199254740991
      THEN CAST(${column} AS INTEGER)
    WHEN typeof(${column}) = 'text'
      AND substr(${column}, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(substr(${column}, 1, 10), '+0 days') = substr(${column}, 1, 10)
      THEN CAST(strftime('%s', ${column}) AS INTEGER) * 1000
        + CAST(substr(strftime('%f', ${column}), 4, 3) AS INTEGER)
  END, 0))`
}

/** @param {string[]} names */
export function activityTriggerCatalogQuery(names) {
  return {
    sql: `SELECT name, type, tbl_name, sql FROM sqlite_schema
          WHERE name COLLATE NOCASE IN (${names.map(() => "?").join(", ")})`,
    args: names,
  }
}

/** @param {import("@libsql/core/api").Row[]} rows @param {string} name */
export function findActivityTrigger(rows, name) {
  return rows.find(row => String(row.name).toLowerCase() === name)
}

/** @param {Pick<import("@libsql/core/api").Client, "execute">} db
 * @param {string[][]} definitions @param {string} family @param {boolean} createMissing */
export async function reconcileActivityTriggerDefinitions(db, definitions, family, createMissing) {
  const { rows } = await db.execute(activityTriggerCatalogQuery(definitions.map(([name]) => name)))
  for (const definition of definitions) {
    const object = findActivityTrigger(rows, definition[0])
    if (!object && createMissing) {
      await db.execute(definition[2])
    } else {
      validateActivityTriggerDefinition(object, definition, family)
    }
  }
}

/** @param {import("@libsql/core/api").Row | undefined} object
 * @param {string[]} definition @param {string} family */
export function validateActivityTriggerDefinition(object, [name, table, sql], family) {
  if (object?.type !== "trigger" || object.name !== name || object.tbl_name !== table ||
    typeof object.sql !== "string" || object.sql.trim() !== sql.trim()) {
    throw new Error(`Unexpected task ${family} trigger: ${name}`)
  }
}
