import { assertBoardStorageWriter, assertNoInboundReferences, matchesSql, moveBoardStorageTables, normalizeSql, tableDefinitions } from "./board-storage-schema.mjs"
import { storageEncodingColumn } from "./0016_ordinary_boards.mjs"
import { customBoardKeyObjects, CUSTOM_BOARD_KEYS_SCHEMA_VERSION } from "./0017_custom_board_keys.mjs"
import { TASK_EXPERIENCE_SCHEMA_VERSION } from "./0018_task_experience.mjs"

const laneColumns = {
  id: "TEXT PRIMARY KEY",
  key: "TEXT NOT NULL",
  label: "TEXT NOT NULL",
  icon: "TEXT NOT NULL DEFAULT '📌'",
  position: "INTEGER NOT NULL DEFAULT 0",
  wip_limit: "INTEGER NOT NULL DEFAULT 0",
  includes: "TEXT NOT NULL DEFAULT '[]'",
  built_in: "INTEGER NOT NULL DEFAULT 0",
  created_at: "INTEGER NOT NULL",
  updated_at: "INTEGER NOT NULL",
}

const laneColumnNames = Object.keys(laneColumns)
const legacyLaneDefinitions = Object.entries(laneColumns).map(([name, type]) =>
  `${name} ${type}${name === "key" ? " UNIQUE" : ""}`,
).join(", ")
const laneDefinitions = Object.entries(laneColumns).map(([name, type]) => `${name} ${type}`).join(", ")
const legacyLaneSql = `CREATE TABLE kanban_lanes (${legacyLaneDefinitions})`
const legacyLaneIndexSql = "CREATE INDEX kanban_lanes_position_idx ON kanban_lanes (position)"

const taskColumns = {
  task_board_id: `TEXT REFERENCES task_boards(id) ON DELETE RESTRICT CHECK (
    task_board_id IS NULL
    OR (task_board_id <> 'household'
      AND area_id IS '__meitheal_no_area__' AND project_id IS NULL AND goal_id IS NULL)
  )`,
  board_column_id: `TEXT REFERENCES kanban_lanes(id) ON DELETE RESTRICT
    CHECK (board_column_id IS NULL OR task_board_id IS NOT NULL)`,
}

const boardTableSql = `CREATE TABLE task_boards (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'shared' CHECK (visibility IN ('shared', 'restricted')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived', 'retired')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision > 0),
  ticket_prefix TEXT NOT NULL UNIQUE,
  ticket_high_water INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(ticket_high_water) = 'integer' AND ticket_high_water BETWEEN 0 AND 9007199254740991),
  project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`

const memberTableSql = `CREATE TABLE board_members (
  board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
  ha_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager')),
  PRIMARY KEY (board_id, ha_user_id)
)`

const scopedLaneSql = `CREATE TABLE kanban_lanes (
  ${laneDefinitions},
  board_id TEXT NOT NULL DEFAULT 'household' REFERENCES task_boards(id) ON DELETE RESTRICT,
  UNIQUE (board_id, key)
)`

const taskPlacementCheck = `WHEN NEW.task_board_id IS NOT NULL AND NEW.board_column_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM kanban_lanes WHERE id = NEW.board_column_id AND board_id = NEW.task_board_id
) BEGIN
  SELECT RAISE(ABORT, 'Board column must belong to the task Board');
END`

const areaReservationCheck = `WHEN NEW.id = '__meitheal_no_area__' BEGIN
  SELECT RAISE(ABORT, 'Area ID is reserved for named Board tasks');
END`

const scopedObjects = {
  kanban_lanes_position_idx: "CREATE INDEX kanban_lanes_position_idx ON kanban_lanes (board_id, position)",
  tasks_task_board_kanban_idx: `CREATE INDEX tasks_task_board_kanban_idx ON tasks
    (task_board_id, is_promoted DESC, (kanban_position IS NULL), kanban_position, priority, created_at DESC, id)
    WHERE deferred_at IS NULL`,
  tasks_task_board_deferred_idx: `CREATE INDEX tasks_task_board_deferred_idx
    ON tasks (task_board_id, deferred_at DESC, id) WHERE deferred_at IS NOT NULL`,
  tasks_board_column_idx: `CREATE INDEX tasks_board_column_idx
    ON tasks (board_column_id) WHERE board_column_id IS NOT NULL`,
  task_boards_identity_guard: `CREATE TRIGGER task_boards_identity_guard
    BEFORE UPDATE OF id, ticket_prefix ON task_boards
    WHEN NEW.id IS NOT OLD.id OR NEW.ticket_prefix IS NOT OLD.ticket_prefix BEGIN
      SELECT RAISE(ABORT, 'Board ID and ticket prefix are immutable');
    END`,
  task_boards_replacement_guard: `CREATE TRIGGER task_boards_replacement_guard BEFORE INSERT ON task_boards
    WHEN EXISTS (SELECT 1 FROM task_boards WHERE
      (id = NEW.id AND (ticket_prefix IS NOT NEW.ticket_prefix OR NEW.ticket_high_water < ticket_high_water))
      OR (id IS NOT NEW.id AND (ticket_prefix = NEW.ticket_prefix OR project_id = NEW.project_id))) BEGIN
      SELECT RAISE(ABORT, 'Board ID and ticket prefix are immutable and ticket high-water cannot decrease');
    END`,
  task_boards_ticket_high_water_guard: `CREATE TRIGGER task_boards_ticket_high_water_guard
    BEFORE UPDATE OF ticket_high_water ON task_boards WHEN NEW.ticket_high_water < OLD.ticket_high_water BEGIN
      SELECT RAISE(ABORT, 'Board ticket high-water cannot decrease');
    END`,
  kanban_lanes_board_guard: `CREATE TRIGGER kanban_lanes_board_guard BEFORE UPDATE OF board_id ON kanban_lanes
    WHEN NEW.board_id IS NOT OLD.board_id BEGIN
      SELECT RAISE(ABORT, 'Lane Board is immutable');
    END`,
  kanban_lanes_replacement_guard: `CREATE TRIGGER kanban_lanes_replacement_guard BEFORE INSERT ON kanban_lanes
    WHEN EXISTS (SELECT 1 FROM kanban_lanes WHERE id = NEW.id AND board_id IS NOT NEW.board_id) BEGIN
      SELECT RAISE(ABORT, 'Lane Board is immutable');
    END`,
  tasks_board_placement_insert: `CREATE TRIGGER tasks_board_placement_insert
    BEFORE INSERT ON tasks ${taskPlacementCheck}`,
  tasks_board_placement_update: `CREATE TRIGGER tasks_board_placement_update
    BEFORE UPDATE OF task_board_id, board_column_id ON tasks ${taskPlacementCheck}`,
  areas_board_reservation_insert: `CREATE TRIGGER areas_board_reservation_insert
    BEFORE INSERT ON areas ${areaReservationCheck}`,
  areas_board_reservation_update: `CREATE TRIGGER areas_board_reservation_update
    BEFORE UPDATE OF id ON areas ${areaReservationCheck}`,
}

const laneStagingName = "kanban_lanes_board_migration"

export const taskBoardStorageObjectNames = Object.freeze([
  "task_boards", "board_members", laneStagingName,
  ...Object.keys(scopedObjects).filter(name => name !== "kanban_lanes_position_idx"),
])

async function validateLegacyLanes(tx) {
  const { rows: columns } = await tx.execute("SELECT name, hidden FROM pragma_table_xinfo('kanban_lanes') ORDER BY cid")
  if (columns.length !== laneColumnNames.length ||
      columns.some((column, index) => column.name !== laneColumnNames[index] || Number(column.hidden) !== 0)) {
    throw new Error("Cannot replace kanban_lanes with unexpected columns")
  }

  const { rows } = await tx.execute(`SELECT name, sql FROM sqlite_schema
    WHERE tbl_name = 'kanban_lanes' COLLATE NOCASE AND sql IS NOT NULL`)
  const lane = rows.find(row => row.name === "kanban_lanes")
  const index = rows.find(row => row.name === "kanban_lanes_position_idx")
  if (rows.length !== 2 || !matchesSql(lane?.sql, legacyLaneSql) || !matchesSql(index?.sql, legacyLaneIndexSql)) {
    throw new Error("Cannot replace kanban_lanes with unexpected schema objects")
  }

  await assertNoInboundReferences(tx, ["kanban_lanes"])
}

/** Applies Board storage inside the caller's write transaction, which must roll back on failure. */
export async function applyTaskBoardStorage(tx) {
  await assertBoardStorageWriter(tx, ["tasks", "areas", "projects", "kanban_lanes", laneStagingName, "task_boards", "board_members"])
  await validateLegacyLanes(tx)
  const { rows: reservedAreas } = await tx.execute("SELECT 1 FROM areas WHERE id = '__meitheal_no_area__' LIMIT 1")
  if (reservedAreas.length > 0) throw new Error("Cannot reserve the named Board Area ID because an Area already uses it")
  await moveBoardStorageTables(tx, { kanban_lanes: laneStagingName })

  const now = Date.now()
  const names = laneColumnNames.join(", ")
  await tx.batch([
    boardTableSql,
    {
      sql: `INSERT INTO task_boards (id, name, ticket_prefix, created_at, updated_at)
        VALUES ('household', 'Household', 'MTH', ?, ?)`,
      args: [now, now],
    },
    memberTableSql,
    scopedLaneSql,
    `INSERT INTO kanban_lanes (rowid, ${names}) SELECT rowid, ${names} FROM ${laneStagingName}`,
    `DROP TABLE ${laneStagingName}`,
    ...Object.entries(taskColumns).map(([name, definition]) => `ALTER TABLE tasks ADD COLUMN ${name} ${definition}`),
    ...Object.values(scopedObjects),
  ])
  await validateTaskBoardStorage(tx)
  const { rows: violations } = await tx.execute(`SELECT 1 FROM pragma_foreign_key_check('task_boards')
    UNION ALL SELECT 1 FROM pragma_foreign_key_check('board_members')
    UNION ALL SELECT 1 FROM pragma_foreign_key_check('kanban_lanes')
    UNION ALL SELECT 1 FROM pragma_foreign_key_check('tasks') WHERE parent IN ('task_boards', 'kanban_lanes')
    LIMIT 1`)
  if (violations.length > 0) throw new Error("Board storage has foreign key violations")
}

/** Validates the Board storage owned by this migration. */
export async function validateTaskBoardStorage(db, allowedObjects = []) {
  const { rows: [version] } = await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  const ordinary = Number(version?.value) >= 26
  const customKeys = Number(version?.value) >= CUSTOM_BOARD_KEYS_SCHEMA_VERSION
  const taskExperience = Number(version?.value) >= TASK_EXPERIENCE_SCHEMA_VERSION
  const objects = {
    task_boards: ordinary ? boardTableSql.replace(/\)\s*$/, `, ${storageEncodingColumn})`) : boardTableSql,
    board_members: memberTableSql,
    kanban_lanes: taskExperience ? scopedLaneSql.replace(/\bUNIQUE\s*\(/, "color TEXT, UNIQUE (") : scopedLaneSql,
    ...scopedObjects,
    ...(customKeys ? { task_boards_identity_guard: customBoardKeyObjects.task_boards_identity_guard } : {}),
  }
  const names = Object.keys(objects)
  const { rows } = await db.execute({
    sql: `SELECT name, sql FROM main.sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})
      OR (tbl_name COLLATE NOCASE IN ('task_boards', 'board_members', 'kanban_lanes') AND sql IS NOT NULL)`,
    args: names,
  })
  const unexpected = rows.find(row => !Object.hasOwn(objects, row.name) && !allowedObjects.includes(row.name))
  if (unexpected) throw new Error(`Unexpected Board storage object: ${unexpected.name}`)
  const found = new Map(rows.map(row => [row.name, row.sql]))
  for (const [name, expected] of Object.entries(objects)) {
    if (!matchesSql(found.get(name), expected)) throw new Error(`Unexpected Board storage object: ${name}`)
  }

  const { rows: [taskTable] } = await db.execute("SELECT sql FROM main.sqlite_schema WHERE name = 'tasks' AND type = 'table'")
  const taskDefinitions = tableDefinitions(String(taskTable?.sql ?? ""))
  const { rows: keys } = await db.execute("PRAGMA main.foreign_key_list(tasks)")
  for (const [name, parent] of [["task_board_id", "task_boards"], ["board_column_id", "kanban_lanes"]]) {
    const key = keys.filter(row => row.from === name)
    const definition = normalizeSql(`${name} ${taskColumns[name]}`)
    if (key.length !== 1 || key[0].table !== parent || key[0].to !== "id" || key[0].on_delete !== "RESTRICT" ||
        keys.filter(row => row.id === key[0].id).length !== 1 ||
        !taskDefinitions.includes(definition)) {
      throw new Error(`Unexpected task Board column: ${name}`)
    }
  }

  const { rows: [household] } = await db.execute("SELECT ticket_prefix FROM main.task_boards WHERE id = 'household'")
  const validHouseholdPrefix = customKeys
    ? /^[A-Z0-9]{2,10}$/.test(String(household?.ticket_prefix ?? ""))
    : household?.ticket_prefix === "MTH"
  if (!validHouseholdPrefix) throw new Error("Household Board is missing its reserved identity")
}
