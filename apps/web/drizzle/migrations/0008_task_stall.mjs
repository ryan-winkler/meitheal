import { reconcileActivityTriggerDefinitions } from "../task-activity-sql.mjs"

const spike = "last_activity_spike_at"
const human = "inactivity_spike_human"
const validSpike = `typeof(${spike}) = 'integer' AND ${spike} BETWEEN 1 AND 9007199254740991`
const spikeDefinition = `${spike} INTEGER CHECK(${spike} IS NULL OR (${validSpike}))`
const humanDefinition = `${human} INTEGER NOT NULL DEFAULT 0 CHECK(typeof(${human}) = 'integer' AND ${human} IN (0, 1))`

// Using julianday can truncate the value to one millisecond before the current second.
const now = "(unixepoch('now') * 1000 + CAST(substr(strftime('%f','now'), 4, 3) AS INTEGER))"
const newAssignee = "NULLIF(trim(NEW.assigned_to, char(9,10,11,12,13,32)), '')"
const oldAssignee = "NULLIF(trim(OLD.assigned_to, char(9,10,11,12,13,32)), '')"
const advance = `${spike} = MAX(CASE WHEN ${validSpike} THEN ${spike} ELSE 0 END, ${now})`

function hasColumnDefinition(sql, definition) {
  if (typeof sql !== "string") return false
  // Ignore comments and quoted names/literals. Retain the only literal used in these declarations.
  const declarations = sql.replace(/--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
    token => token === "'integer'" ? token : token.startsWith("-") || token.startsWith("/") ? " " : "#")
  const normalized = declarations.replace(/\s+/g, " ")
  const idx = normalized.indexOf(definition)
  if (idx === -1) return false
  const before = normalized.slice(0, idx).trimEnd()
  const after = normalized.slice(idx + definition.length).trimStart()
  return (before.endsWith("(") || before.endsWith(",")) && (after.startsWith(",") || after.startsWith(")"))
}

async function reconcileColumn(db, table, name, definition, notNull, defaultValue, createMissing) {
  const { rows } = await db.execute(`PRAGMA table_info(${table})`)
  const column = rows.find(row => row.name === name)
  if (!column && createMissing) {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
    return
  }
  const { rows: [tableSchema] } = await db.execute({
    sql: "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?", args: [table],
  })
  if (!column || column.type !== "INTEGER" || column.notnull !== notNull ||
      column.dflt_value !== defaultValue || column.pk !== 0 || !hasColumnDefinition(tableSchema?.sql, definition)) {
    throw new Error(`Unexpected stall column: ${table}.${name}`)
  }
}

export async function applyTaskStallMigration(tx) {
  await reconcileColumn(tx, "tasks", spike, spikeDefinition, 0, null, true)
}

export async function validateTaskStallSchema(db) {
  await reconcileColumn(db, "tasks", spike, spikeDefinition, 0, null, false)
}

export function taskStallTriggerDefinitions({ newTaskDays, storedTaskDays, openStatuses, completeStatuses, commentClock }) {
  const newAreaEnabled = `(${newTaskDays}) BETWEEN 1 AND 365
    AND EXISTS (SELECT 1 FROM areas WHERE id = NEW.area_id)`
  const recentHuman = `FROM comments comment
    WHERE comment.task_id = NEW.task_id AND comment.${human} = 1 AND comment.owner_key IS NOT NULL
      AND ${commentClock} BETWEEN MAX(1, ${now} - (${storedTaskDays}) * 86400000 * 33 / 100) AND ${now}`
  return [
    ["tasks_stall_initial_assignment", "tasks", `CREATE TRIGGER tasks_stall_initial_assignment
      AFTER INSERT ON tasks WHEN ${newAssignee} IS NOT NULL AND ${newAreaEnabled}
      BEGIN
        UPDATE tasks SET ${advance} WHERE id = NEW.id;
      END`],
    ["tasks_stall_transition", "tasks", `CREATE TRIGGER tasks_stall_transition
      AFTER UPDATE OF assigned_to, status ON tasks
      WHEN ((${newAssignee} IS NOT NULL AND ${newAssignee} IS NOT ${oldAssignee})
        OR (lower(OLD.status) IN (${completeStatuses}) AND lower(NEW.status) IN (${openStatuses})))
        AND ${newAreaEnabled}
      BEGIN
        UPDATE tasks SET ${advance} WHERE id = NEW.id;
      END`],
    ["comments_stall_burst", "comments", `CREATE TRIGGER comments_stall_burst
      AFTER INSERT ON comments WHEN NEW.${human} = 1 AND NEW.owner_key IS NOT NULL
      BEGIN
        UPDATE tasks SET ${advance}
        WHERE id = NEW.task_id AND (${storedTaskDays}) BETWEEN 1 AND 365
          AND EXISTS (SELECT 1 FROM areas WHERE id = tasks.area_id)
          AND EXISTS (SELECT 1 ${recentHuman} AND comment.id = NEW.id)
          AND EXISTS (SELECT 1 ${recentHuman} LIMIT 1 OFFSET 2)
          AND EXISTS (SELECT 1 ${recentHuman} AND comment.owner_key <> NEW.owner_key);
      END`],
  ]
}

async function reconcileStallTriggers(db, expressions, createMissing) {
  await reconcileColumn(db, "comments", human, humanDefinition, 1, "0", createMissing)
  await reconcileActivityTriggerDefinitions(db, taskStallTriggerDefinitions(expressions), "stall", createMissing)
}

/** Expressions are compiled from versioned, trusted SQL helpers. */
export async function installTaskStallTriggers(tx, expressions) {
  await reconcileStallTriggers(tx, expressions, true)
}

export async function validateTaskStallTriggers(db, expressions) {
  await reconcileStallTriggers(db, expressions, false)
}
