import { ORGANIZATION_FEATURE_SCHEMA_VERSION } from "./0014_organization_features.mjs"
import { applyTaskBoardStorage, taskBoardStorageObjectNames, validateTaskBoardStorage } from "./0009_task_boards.mjs"
import { assertNoInboundReferences } from "./board-storage-schema.mjs"
import { applyTaskBoardDraftStorage, taskBoardDraftStagingNames, validateTaskBoardDraftStorage } from "./task-board-drafts.mjs"
import {
  applyTaskBoardHouseholdPhase, namedBoardPhaseTriggerNames, taskBoardHouseholdObjectNames, taskBoardHouseholdTriggerNames,
  validateNamedBoardStoragePhase, validateTaskBoardHouseholdPhase,
} from "./task-board-household.mjs"
import { applyTaskBoardTicketAllocator, taskBoardTicketTriggerNames, validateTaskBoardTicketAllocator } from "./task-board-tickets.mjs"
import { validateTaskActivityTriggers } from "./task-activity-schema.mjs"
import { validateTaskSchemaPrerequisites } from "./task-schema-prerequisites.mjs"

export const TASK_BOARD_SCHEMA_VERSION = 19
export const TASK_BOARD_MIGRATION = "0009_task_boards.mjs"

const tables = ["app_settings", "__meitheal_migrations"]
const predecessorMarkerRows = [
  {
    sql: "SELECT name, applied_at FROM main.__meitheal_migrations WHERE name IS NOT ? ORDER BY name",
    args: [TASK_BOARD_MIGRATION],
  },
  "SELECT key, value, updated_at FROM main.app_settings WHERE key IS NOT 'schema_version' ORDER BY key",
]
const reservedNames = [
  ...taskBoardStorageObjectNames, ...taskBoardDraftStagingNames,
  ...taskBoardHouseholdObjectNames, ...taskBoardTicketTriggerNames,
]
const scopedColumns = `SELECT 1 FROM pragma_table_xinfo('tasks', 'main')
  WHERE name COLLATE NOCASE IN ('task_board_id', 'board_column_id', 'ticket_ref')
  UNION ALL SELECT 1 FROM pragma_table_xinfo('kanban_lanes', 'main') WHERE name = 'board_id' COLLATE NOCASE
  UNION ALL SELECT 1 FROM pragma_table_xinfo('task_drafts', 'main') WHERE name = 'board_id' COLLATE NOCASE
  UNION ALL SELECT 1 FROM pragma_table_xinfo('task_draft_receipts', 'main') WHERE name = 'board_id' COLLATE NOCASE
  LIMIT 1`

/** Read the Board marker pair on the caller's pinned transaction or snapshot. */
export function* taskBoardMigrationStateSteps() {
  const names = [...tables, ...reservedNames]
  const [catalog] = yield [{
    sql: `SELECT lower(objects.name) AS name,
        CASE WHEN objects.type = 'table' THEN tables.type ELSE objects.type END AS type,
        lower(objects.tbl_name) AS table_name
      FROM main.sqlite_schema AS objects
      LEFT JOIN pragma_table_list() AS tables
        ON objects.type = 'table' AND tables."schema" = 'main' AND tables.name = objects.name
      WHERE objects.name COLLATE NOCASE IN (${names.map(() => "?").join(", ")})
        OR (objects.type = 'trigger' AND objects.tbl_name COLLATE NOCASE IN ('app_settings', '__meitheal_migrations'))
      UNION ALL SELECT lower(name), type, lower(tbl_name) FROM temp.sqlite_schema
      WHERE type = 'trigger' AND tbl_name COLLATE NOCASE IN ('app_settings', '__meitheal_migrations')`,
    args: names,
  }]
  if (catalog.rows.some(row => row.type === "trigger" && tables.includes(row.table_name))) {
    throw new Error("Unexpected trigger on a Meitheal Board schema marker table")
  }
  const found = new Map(catalog.rows.map(row => [row.name, row.type]))
  if (tables.some(name => found.has(name) && found.get(name) !== "table")) {
    throw new Error("The Meitheal Board schema markers must be stored in ordinary tables")
  }
  let version = null
  if (found.has("app_settings")) {
    const [setting] = yield ["SELECT value AS value FROM main.app_settings WHERE key = 'schema_version' LIMIT 2"]
    if (setting.rows.length > 0) {
      const value = setting.rows[0]?.value
      if (setting.rows.length !== 1 || typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error("The Meitheal database has an invalid schema version marker")
      }
      version = Number(value)
      if (version > ORGANIZATION_FEATURE_SCHEMA_VERSION) {
        throw new Error(`Meitheal database schema ${version} requires a newer App (this App supports ${ORGANIZATION_FEATURE_SCHEMA_VERSION})`)
      }
      if (version >= TASK_BOARD_SCHEMA_VERSION && value !== String(version)) {
        throw new Error("The Meitheal database has an invalid Board schema version marker")
      }
    }
  }

  let marked = false
  if (found.has("__meitheal_migrations")) {
    const [ledger] = yield [{
      sql: "SELECT name AS name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
      args: [TASK_BOARD_MIGRATION],
    }]
    if (ledger.rows.length > 0 && (ledger.rows.length !== 1 || ledger.rows[0]?.name !== TASK_BOARD_MIGRATION)) {
      throw new Error("The Meitheal database has an invalid Board migration ledger entry")
    }
    marked = ledger.rows.length === 1
  }

  if (marked !== (version !== null && version >= TASK_BOARD_SCHEMA_VERSION)) throw new Error("The Meitheal Board schema markers disagree")
  if (marked) {
    if (reservedNames.some(name => name.endsWith("_board_migration") && found.has(name))) {
      throw new Error("The Meitheal Board schema has unfinished staging tables")
    }
    return "household-v19"
  }
  const [columns] = yield [scopedColumns]
  if (reservedNames.some(name => found.has(name)) || columns.rows.length > 0) {
    throw new Error("The Meitheal database contains unmarked Board storage")
  }
  return "predecessor"
}

export async function readTaskBoardMigrationState(db) {
  const steps = taskBoardMigrationStateSteps()
  let state = steps.next()
  while (!state.done) state = steps.next([await db.execute(state.value[0])])
  return state.value
}

export async function validateTaskBoardUpgrade(db, { namedStorage = false } = {}) {
  if (await readTaskBoardMigrationState(db) !== "household-v19") throw new Error("The Household Board upgrade is pending")
  await assertNoInboundReferences(db, tables)
  const allowedTriggers = namedStorage ? namedBoardPhaseTriggerNames : taskBoardHouseholdTriggerNames
  await validateTaskBoardStorage(db, allowedTriggers)
  await validateTaskBoardDraftStorage(db, allowedTriggers)
  await validateTaskBoardTicketAllocator(db)
  if (namedStorage) await validateNamedBoardStoragePhase(db)
  else await validateTaskBoardHouseholdPhase(db)
}

/** The caller owns commit/rollback, and must have already prepared the v18 schema and ledger. */
export async function applyTaskBoardUpgrade(tx, predecessorMigrationNames) {
  if (typeof tx.commit !== "function" || tx.closed) throw new Error("The Board upgrade requires a write transaction")
  if (await readTaskBoardMigrationState(tx) === "household-v19") {
    await validateTaskBoardUpgrade(tx)
    return
  }

  await assertNoInboundReferences(tx, tables)
  const priorMarkers = await tx.batch(predecessorMarkerRows)
  const applied = new Set(priorMarkers[0].rows.map(row => row.name))
  if (predecessorMigrationNames.length === 0 || predecessorMigrationNames.some(name => !applied.has(name))) {
    throw new Error("Complete the predecessor migrations before applying Board storage")
  }
  await validateTaskSchemaPrerequisites(tx)
  await validateTaskActivityTriggers(tx)
  await applyTaskBoardStorage(tx)
  await applyTaskBoardDraftStorage(tx)
  await applyTaskBoardTicketAllocator(tx)
  await applyTaskBoardHouseholdPhase(tx)

  const now = Date.now()
  await tx.batch([
    { sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)", args: [TASK_BOARD_MIGRATION, now] },
    {
      sql: `INSERT INTO main.app_settings (key, value, updated_at) VALUES ('schema_version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [String(TASK_BOARD_SCHEMA_VERSION), now],
    },
  ])
  const retainedMarkers = await tx.batch(predecessorMarkerRows)
  if (priorMarkers.some((result, index) => JSON.stringify(result.rows) !== JSON.stringify(retainedMarkers[index].rows))) {
    throw new Error("The Board upgrade changed unrelated migration or App settings rows")
  }
  await validateTaskBoardUpgrade(tx)
}
