import { matchesSql } from "./board-storage-schema.mjs"

export const BOARD_ACCESS_SCHEMA_VERSION = 21
export const BOARD_ACCESS_MIGRATION = "0011_board_access.mjs"

const planningTables = ["areas", "projects", "goals", "pillars"]
const objects = {
  board_permissions: `CREATE TABLE board_permissions (
    board_id TEXT PRIMARY KEY NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
    deny_completion INTEGER NOT NULL DEFAULT 0 CHECK (deny_completion IN (0, 1)),
    deny_deletion INTEGER NOT NULL DEFAULT 0 CHECK (deny_deletion IN (0, 1)),
    deny_agent_deletion INTEGER NOT NULL DEFAULT 0 CHECK (deny_agent_deletion IN (0, 1))
  )`,
  board_access_grants: `CREATE TABLE board_access_grants (
    board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('ha_user', 'agent')),
    principal_id TEXT NOT NULL CHECK (length(principal_id) > 0),
    role TEXT NOT NULL CHECK (
      (principal_type = 'ha_user' AND role IN ('owner', 'member', 'viewer')) OR
      (principal_type = 'agent' AND role = 'service')
    ),
    deny_completion INTEGER NOT NULL DEFAULT 0 CHECK (deny_completion IN (0, 1)),
    deny_deletion INTEGER NOT NULL DEFAULT 0 CHECK (deny_deletion IN (0, 1)),
    PRIMARY KEY (board_id, principal_type, principal_id)
  )`,
  board_sidebar_preferences: `CREATE TABLE board_sidebar_preferences (
    board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
    ha_user_id TEXT NOT NULL CHECK (length(ha_user_id) > 0),
    PRIMARY KEY (board_id, ha_user_id)
  )`,
  board_goal_shares: `CREATE TABLE board_goal_shares (
    goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    area_id TEXT NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
    receiving_board_id TEXT NOT NULL REFERENCES task_boards(id) ON DELETE RESTRICT,
    PRIMARY KEY (goal_id, area_id, receiving_board_id)
  )`,
  board_goal_shares_area_idx: `CREATE INDEX board_goal_shares_area_idx
    ON board_goal_shares(area_id, receiving_board_id, goal_id)`,
  invalidate_area_goal_shares: `CREATE TRIGGER invalidate_area_goal_shares
    AFTER UPDATE OF owner_board_id ON areas
    WHEN NEW.owner_board_id IS NOT OLD.owner_board_id
    BEGIN DELETE FROM board_goal_shares WHERE area_id = OLD.id; END`,
  invalidate_owned_goal_shares: `CREATE TRIGGER invalidate_owned_goal_shares
    AFTER UPDATE OF owner_board_id ON goals
    WHEN NEW.owner_board_id IS NOT OLD.owner_board_id
    BEGIN DELETE FROM board_goal_shares WHERE goal_id = OLD.id; END`,
  board_access_epoch: `CREATE TABLE board_access_epoch (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision TEXT NOT NULL CHECK (length(revision) = 36)
  )`,
}

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readBoardAccessMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM main.app_settings WHERE key = 'schema_version'")
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
    args: [BOARD_ACCESS_MIGRATION],
  })
  const applied = version?.value === String(BOARD_ACCESS_SCHEMA_VERSION)
  if ((applied ? 1 : 0) !== ledger.length || (applied && ledger[0]?.name !== BOARD_ACCESS_MIGRATION)) {
    throw new Error("The Meitheal Board access schema markers disagree")
  }
  if (applied) {
    for (const [name, shape] of Object.entries(objects)) {
      const { rows: [object] } = await db.execute({
        sql: "SELECT sql FROM main.sqlite_schema WHERE name = ?",
        args: [name],
      })
      if (!matchesSql(object?.sql, shape)) throw new Error(`Unexpected Board access object: ${name}`)
    }
    for (const table of planningTables) {
      const { rows: keys } = await db.execute(`PRAGMA main.foreign_key_list(${table})`)
      if (!keys.some(key => key.from === "owner_board_id" && key.table === "task_boards" && key.to === "id" && key.on_delete === "RESTRICT")) {
        throw new Error(`Board ownership is missing from ${table}`)
      }
    }
  }
  return applied
}

/** @param {import("@libsql/client").Transaction} tx */
export async function applyBoardAccessMigration(tx) {
  if (await readBoardAccessMigrationState(tx)) return false
  for (const table of planningTables) {
    await tx.execute(`ALTER TABLE main.${table}
      ADD COLUMN owner_board_id TEXT REFERENCES task_boards(id) ON DELETE RESTRICT
      CHECK (owner_board_id IS NULL OR owner_board_id <> 'household')`)
  }
  await tx.batch(Object.values(objects))
  const now = Date.now()
  await tx.batch([
    { sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)", args: [BOARD_ACCESS_MIGRATION, now] },
    { sql: "UPDATE main.app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(BOARD_ACCESS_SCHEMA_VERSION), now] },
  ])
  if (!await readBoardAccessMigrationState(tx)) throw new Error("Cannot commit the Board access migration")
  return true
}
