import { matchesSql, tableDefinitions } from "./board-storage-schema.mjs"
import { ordinaryRetirementTriggers } from "./0016_ordinary_boards.mjs"

export const CUSTOM_BOARD_KEYS_SCHEMA_VERSION = 27
export const CUSTOM_BOARD_KEYS_MIGRATION = "0017_custom_board_keys.mjs"

export const customTicketRefColumn = `ticket_ref TEXT CHECK (ticket_ref IS NULL OR (
  ticket_number IS NULL
  AND length(ticket_ref) BETWEEN 4 AND 27
  AND instr(ticket_ref, char(0)) = 0
  AND instr(ticket_ref, '-') BETWEEN 3 AND 11
  AND substr(ticket_ref, 1, instr(ticket_ref, '-') - 1) NOT GLOB '*[^A-Z0-9]*'
  AND substr(ticket_ref, instr(ticket_ref, '-') + 1, 1) GLOB '[1-9]'
  AND substr(ticket_ref, instr(ticket_ref, '-') + 1) NOT GLOB '*[^0-9]*'
  AND CAST(substr(ticket_ref, instr(ticket_ref, '-') + 1) AS INTEGER) <= 9007199254740991
))`

const validPlacement = `(
  (NEW.task_board_id IS NULL AND NEW.ticket_ref IS NULL AND NEW.board_column_id IS NULL)
  OR (NEW.task_board_id IS NOT NULL AND NEW.board_column_id IS NOT NULL AND NEW.ticket_ref IS NOT NULL
    AND EXISTS (SELECT 1 FROM task_boards WHERE id = NEW.task_board_id
      AND NEW.ticket_ref GLOB ticket_prefix || '-[1-9]*')
    AND EXISTS (SELECT 1 FROM kanban_lanes WHERE id = NEW.board_column_id AND board_id = NEW.task_board_id))
)`

const ticketRefIndexSql = `CREATE UNIQUE INDEX tasks_ticket_ref_unique_idx ON tasks(ticket_ref)
  WHERE ticket_ref IS NOT NULL`

const namedPlacementInsertSql = `CREATE TRIGGER tasks_require_named_placement_insert
  BEFORE INSERT ON tasks WHEN NOT ${validPlacement}
  BEGIN SELECT RAISE(ABORT, 'Invalid task Board placement'); END`

export const customBoardKeyObjects = {
  task_boards_identity_guard: `CREATE TRIGGER task_boards_identity_guard
    BEFORE UPDATE OF id, ticket_prefix ON task_boards
    WHEN NEW.id IS NOT OLD.id
      OR (NEW.ticket_prefix IS NOT OLD.ticket_prefix AND (
        length(NEW.ticket_prefix) NOT BETWEEN 2 AND 10
        OR NEW.ticket_prefix GLOB '*[^A-Z0-9]*'
      )) BEGIN
      SELECT RAISE(ABORT, 'Board ID is immutable and ticket prefix must be 2 to 10 uppercase letters or numbers');
    END`,
  task_boards_ordinary_identity_insert: `CREATE TRIGGER task_boards_ordinary_identity_insert BEFORE INSERT ON task_boards
    WHEN length(NEW.ticket_prefix) NOT BETWEEN 2 AND 10 OR NEW.ticket_prefix GLOB '*[^A-Z0-9]*'
    BEGIN SELECT RAISE(ABORT, 'Invalid Board ticket prefix'); END`,
  tasks_require_named_placement_update: `CREATE TRIGGER tasks_require_named_placement_update
    BEFORE UPDATE OF task_board_id, board_column_id, ticket_ref ON tasks
    WHEN NOT ${validPlacement} OR NEW.task_board_id IS NOT OLD.task_board_id
      OR (NEW.ticket_ref IS NOT OLD.ticket_ref AND (
        OLD.ticket_ref IS NULL OR NEW.ticket_ref IS NULL
        OR substr(NEW.ticket_ref, instr(NEW.ticket_ref, '-') + 1) IS NOT substr(OLD.ticket_ref, instr(OLD.ticket_ref, '-') + 1)
      ))
    BEGIN SELECT RAISE(ABORT, 'Invalid task Board placement or ticket reference'); END`,
}

export async function applyCustomBoardKeysMigration(tx) {
  const { rows: [version] } = await tx.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  if (Number(version?.value) >= CUSTOM_BOARD_KEYS_SCHEMA_VERSION) return false
  if (Number(version?.value) !== 26) {
    throw new Error("Custom Board keys migration requires validated schema 26")
  }

  const { rows: savedRefs } = await tx.execute(
    "SELECT id, ticket_ref FROM tasks WHERE ticket_ref IS NOT NULL",
  )

  const retiredTasksUpdate = ordinaryRetirementTriggers.find(([name]) => name === "board_retired_tasks_update")
  const dropRetired = savedRefs.length > 0 && retiredTasksUpdate

  await tx.batch([
    ...(dropRetired ? ["DROP TRIGGER IF EXISTS board_retired_tasks_update"] : []),
    "DROP INDEX IF EXISTS tasks_ticket_ref_unique_idx",
    "DROP TRIGGER IF EXISTS tasks_require_named_placement_insert",
    "DROP TRIGGER IF EXISTS tasks_require_named_placement_update",
    "DROP TRIGGER IF EXISTS task_boards_identity_guard",
    "DROP TRIGGER IF EXISTS task_boards_ordinary_identity_insert",
    "ALTER TABLE tasks DROP COLUMN ticket_ref",
    `ALTER TABLE tasks ADD COLUMN ${customTicketRefColumn}`,
  ])

  for (const row of savedRefs) {
    await tx.execute({
      sql: "UPDATE tasks SET ticket_ref = ? WHERE id = ?",
      args: [String(row.ticket_ref), String(row.id)],
    })
  }

  const now = Date.now()
  await tx.batch([
    ticketRefIndexSql,
    namedPlacementInsertSql,
    customBoardKeyObjects.tasks_require_named_placement_update,
    customBoardKeyObjects.task_boards_identity_guard,
    customBoardKeyObjects.task_boards_ordinary_identity_insert,
    ...(dropRetired ? [retiredTasksUpdate[1]] : []),
    {
      sql: "INSERT INTO __meitheal_migrations(name, applied_at) VALUES (?, ?)",
      args: [CUSTOM_BOARD_KEYS_MIGRATION, now],
    },
    {
      sql: "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(CUSTOM_BOARD_KEYS_SCHEMA_VERSION), now],
    },
  ])

  await readCustomBoardKeysMigrationState(tx)
  return true
}

export async function readCustomBoardKeysMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  const current = Number(version?.value) >= CUSTOM_BOARD_KEYS_SCHEMA_VERSION
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM __meitheal_migrations WHERE name = ? COLLATE NOCASE",
    args: [CUSTOM_BOARD_KEYS_MIGRATION],
  })
  if (
    ledger.length !== (current ? 1 : 0) ||
    (current && ledger[0]?.name !== CUSTOM_BOARD_KEYS_MIGRATION)
  ) {
    throw new Error("Custom Board keys schema markers disagree")
  }
  if (!current) return false

  for (const [name, definition] of Object.entries(customBoardKeyObjects)) {
    const { rows: [actual] } = await db.execute({
      sql: "SELECT sql FROM sqlite_schema WHERE name = ?",
      args: [name],
    })
    if (!matchesSql(actual?.sql, definition)) {
      throw new Error(`Unexpected custom Board key object: ${name}`)
    }
  }

  const { rows: [taskTable] } = await db.execute("SELECT sql FROM main.sqlite_schema WHERE name = 'tasks' AND type = 'table'")
  if (!tableDefinitions(String(taskTable?.sql ?? "")).some(definition => matchesSql(definition, customTicketRefColumn))) {
    throw new Error("Unexpected task Board ticket column")
  }
  return true
}
