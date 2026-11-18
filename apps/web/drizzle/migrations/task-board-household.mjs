import { matchesSql, tableDefinitions } from "./board-storage-schema.mjs"

const ticketRef = `ticket_ref TEXT CHECK (ticket_ref IS NULL OR (
  ticket_number IS NULL AND length(ticket_ref) BETWEEN 10 AND 25
  AND instr(ticket_ref, char(0)) = 0
  AND substr(ticket_ref, 1, 8) NOT GLOB '*[^A-Z2-7]*'
  AND substr(ticket_ref, 9, 1) = '-'
  AND substr(ticket_ref, 10, 1) GLOB '[1-9]'
  AND substr(ticket_ref, 10) NOT GLOB '*[^0-9]*'
  AND CAST(substr(ticket_ref, 10) AS INTEGER) <= 9007199254740991
))`
const ticketRefIndex = `CREATE UNIQUE INDEX tasks_ticket_ref_unique_idx ON tasks(ticket_ref)
  WHERE ticket_ref IS NOT NULL`
const unavailable = "BEGIN SELECT RAISE(ABORT, 'Only the Household Board is available'); END"
const householdBoard = "id IS 'household' AND visibility IS 'shared' AND state IS 'active' AND project_id IS NULL"
const taskScopeColumns = ["task_board_id", "board_column_id", "ticket_ref"]
const namedTask = (prefix = "") => taskScopeColumns.map(column => `${prefix}${column} IS NOT NULL`).join(" OR ")
const boardScopedTables = ["kanban_lanes", "task_drafts", "task_draft_receipts"]
const guardedTables = [
  ["tasks", namedTask("NEW."), `UPDATE OF ${taskScopeColumns.join(", ")}`],
  ...boardScopedTables.map(table => [table, "NEW.board_id IS NOT 'household'", "UPDATE OF board_id"]),
]

const triggers = Object.fromEntries([
  ["task_boards_household_v19_insert", `BEFORE INSERT ON task_boards ${unavailable}`],
  ["task_boards_household_v19_update", `BEFORE UPDATE ON task_boards WHEN NOT (
    NEW.id IS 'household' AND NEW.visibility IS 'shared' AND NEW.state IS 'active' AND NEW.project_id IS NULL
  ) ${unavailable}`],
  ["task_boards_household_v19_delete", `BEFORE DELETE ON task_boards ${unavailable}`],
  ["board_members_household_v19_insert", `BEFORE INSERT ON board_members ${unavailable}`],
  ...guardedTables.flatMap(([table, predicate, update]) => [
    [`${table}_household_v19_insert`, `BEFORE INSERT ON ${table} WHEN ${predicate} ${unavailable}`],
    [`${table}_household_v19_update`, `BEFORE ${update} ON ${table} WHEN ${predicate} ${unavailable}`],
  ]),
].map(([name, body]) => [name, `CREATE TRIGGER ${name} ${body}`]))

const namedTables = new Set(["tasks", "kanban_lanes", "task_boards"])
const replacedNames = [
  "task_boards_household_v19_insert", "task_boards_household_v19_update",
  "kanban_lanes_household_v19_insert", "kanban_lanes_household_v19_update",
  "tasks_household_v19_insert", "tasks_household_v19_update",
]
const validPlacement = `(
  (NEW.task_board_id IS NULL AND NEW.ticket_ref IS NULL AND NEW.board_column_id IS NULL)
  OR (NEW.task_board_id IS NOT NULL AND NEW.board_column_id IS NOT NULL AND NEW.ticket_ref IS NOT NULL
    AND EXISTS (SELECT 1 FROM task_boards WHERE id = NEW.task_board_id
      AND NEW.ticket_ref GLOB ticket_prefix || '-[1-9]*')
    AND EXISTS (SELECT 1 FROM kanban_lanes WHERE id = NEW.board_column_id AND board_id = NEW.task_board_id))
)`
const namedPhaseTriggers = {
  ...Object.fromEntries(Object.entries(triggers).filter(([name]) => !replacedNames.includes(name))),
  task_boards_household_identity_insert: `CREATE TRIGGER task_boards_household_identity_insert
    BEFORE INSERT ON task_boards WHEN NEW.id = 'household' OR length(NEW.ticket_prefix) <> 8
      OR NEW.ticket_prefix GLOB '*[^A-Z2-7]*'
    BEGIN SELECT RAISE(ABORT, 'Invalid named Board identity'); END`,
  task_boards_household_identity_update: `CREATE TRIGGER task_boards_household_identity_update
    BEFORE UPDATE ON task_boards WHEN OLD.id = 'household' AND NOT (
      NEW.id IS 'household' AND NEW.visibility IS 'shared' AND NEW.state IS 'active' AND NEW.project_id IS NULL
    ) ${unavailable}`,
  tasks_require_named_placement_insert: `CREATE TRIGGER tasks_require_named_placement_insert
    BEFORE INSERT ON tasks WHEN NOT ${validPlacement}
    BEGIN SELECT RAISE(ABORT, 'Invalid task Board placement'); END`,
  tasks_require_named_placement_update: `CREATE TRIGGER tasks_require_named_placement_update
    BEFORE UPDATE OF task_board_id, board_column_id, ticket_ref ON tasks
    WHEN NOT ${validPlacement} OR NEW.task_board_id IS NOT OLD.task_board_id OR NEW.ticket_ref IS NOT OLD.ticket_ref
    BEGIN SELECT RAISE(ABORT, 'Invalid task Board placement or ticket reference'); END`,
}

export const lifecycleHouseholdIdentitySql = namedPhaseTriggers.task_boards_household_identity_update.replace("NEW.state IS 'active'", "NEW.state IN ('active', 'retired')")

export const namedBoardPhaseTriggerNames = Object.keys(namedPhaseTriggers)

export async function applyNamedBoardStoragePhase(tx) {
  await tx.batch([
    ...replacedNames.map(name => `DROP TRIGGER ${name}`),
    ...Object.entries(namedPhaseTriggers).filter(([name]) => !Object.hasOwn(triggers, name)).map(([, sql]) => sql),
  ])
  await validateNamedBoardStoragePhase(tx)
}

export async function validateNamedBoardStoragePhase(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  const lifecycle = Number(version?.value) >= 25
  await validatePhaseObjects(db, lifecycle ? {
    ...namedPhaseTriggers, task_boards_household_identity_update: lifecycleHouseholdIdentitySql,
  } : namedPhaseTriggers, taskBoardHouseholdTriggerNames)
  const household = lifecycle ? householdBoard.replace("state IS 'active'", "state IN ('active', 'retired')") : householdBoard
  const { rows: invalid } = await db.execute(`SELECT 1 WHERE
    NOT EXISTS (SELECT 1 FROM main.task_boards WHERE ${household})
    OR EXISTS (SELECT 1 FROM main.board_members)
    OR EXISTS (SELECT 1 FROM main.tasks AS NEW WHERE NOT ${validPlacement})
    ${boardScopedTables.filter(table => !namedTables.has(table)).map(table =>
      `OR EXISTS (SELECT 1 FROM main.${table} WHERE board_id IS NOT 'household')`).join("\n")}`)
  if (invalid.length) throw new Error("Invalid named Board storage state")
}

// The next migration may remove these phase guards. The ticket column and index are permanent.
export const taskBoardHouseholdTriggerNames = Object.keys(triggers)
export const taskBoardHouseholdObjectNames = ["tasks_ticket_ref_unique_idx", ...taskBoardHouseholdTriggerNames]

export async function applyTaskBoardHouseholdPhase(tx) {
  await tx.batch([
    `ALTER TABLE tasks ADD COLUMN ${ticketRef}`,
    ticketRefIndex,
    ...Object.values(triggers),
  ])
  await validateTaskBoardHouseholdPhase(tx)
}

async function validatePhaseObjects(db, expectedTriggers, oldNames = []) {
  const names = [...new Set(["tasks_ticket_ref_unique_idx", ...Object.keys(expectedTriggers), ...oldNames])]
  const { rows } = await db.execute({
    sql: `SELECT name, sql FROM main.sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`,
    args: names,
  })
  const installed = new Map(rows.map(row => [row.name, row.sql]))
  for (const [name, definition] of Object.entries({ tasks_ticket_ref_unique_idx: ticketRefIndex, ...expectedTriggers })) {
    if (!matchesSql(installed.get(name), definition)) throw new Error(`Unexpected Household Board phase object: ${name}`)
  }

  if (oldNames.some(name => !Object.hasOwn(expectedTriggers, name) && installed.has(name))) {
    throw new Error("Household Board phase guard must not remain after the named storage migration")
  }

  const { rows: [taskTable] } = await db.execute("SELECT sql FROM main.sqlite_schema WHERE name = 'tasks' AND type = 'table'")
  if (!tableDefinitions(String(taskTable?.sql ?? "")).some(definition => matchesSql(definition, ticketRef))) {
    throw new Error("Unexpected task Board ticket column")
  }
}

export async function validateTaskBoardHouseholdPhase(db) {
  await validatePhaseObjects(db, triggers)
  const { rows: invalid } = await db.execute(`SELECT 1 WHERE
    NOT EXISTS (SELECT 1 FROM main.task_boards WHERE ${householdBoard})
    OR EXISTS (SELECT 1 FROM main.task_boards WHERE NOT (${householdBoard}))
    OR EXISTS (SELECT 1 FROM main.board_members)
    OR EXISTS (SELECT 1 FROM main.tasks WHERE ${namedTask()})
    ${boardScopedTables.map(table => `OR EXISTS (SELECT 1 FROM main.${table} WHERE board_id IS NOT 'household')`).join("\n")}`)
  if (invalid.length > 0) throw new Error("Version 19 requires a Household-only Board database")
}
