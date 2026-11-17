import { matchesSql } from "./board-storage-schema.mjs"

export const ORGANIZATION_ACCESS_SCHEMA_VERSION = 23
export const ORGANIZATION_ACCESS_MIGRATION = "0013_organization_access.mjs"

const policyTable = `CREATE TABLE organization_access_policies (
  scope TEXT NOT NULL CHECK (scope IN ('feature', 'household', 'group', 'project')),
  scope_id TEXT NOT NULL,
  board_id TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL CHECK (audience IN ('everyone', 'selected', 'nobody')),
  selected_users TEXT NOT NULL CHECK (json_valid(selected_users) AND json_type(selected_users) = 'array'),
  revision TEXT NOT NULL,
  CHECK ((scope = 'feature' AND board_id = '') OR (scope <> 'feature' AND board_id <> '')),
  CHECK ((audience = 'selected' AND json_array_length(selected_users) > 0)
    OR (audience <> 'selected' AND json_array_length(selected_users) = 0)),
  PRIMARY KEY (scope, scope_id, board_id)
) STRICT`

const areaTable = `CREATE TABLE home_assistant_task_areas (
  task_id TEXT NOT NULL PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  area_id TEXT CHECK (area_id IS NULL OR length(area_id) BETWEEN 1 AND 150),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740991)
) STRICT`

const protectionTriggers = [
  ["organization_policy_protect_insert", "INSERT", "organization_access_policies", "NEW.audience = 'selected' OR NEW.scope <> 'feature'"],
  ["organization_policy_protect_update", "UPDATE", "organization_access_policies", "NEW.audience = 'selected' OR NEW.scope <> 'feature'"],
  ["task_home_area_protect_insert", "INSERT", "home_assistant_task_areas", "NEW.area_id IS NOT NULL"],
  ["task_home_area_protect_update", "UPDATE", "home_assistant_task_areas", "NEW.area_id IS NOT NULL"],
].map(([name, event, table, test]) => [name, `CREATE TRIGGER ${name} AFTER ${event} ON ${table}
  WHEN ${test}
  BEGIN
    INSERT INTO app_settings (key, value, updated_at)
    SELECT 'private_organization_data', '1', 0
    WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'private_organization_data');
  END`])

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readOrganizationAccessMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM main.app_settings WHERE key = 'schema_version'")
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
    args: [ORGANIZATION_ACCESS_MIGRATION],
  })
  const { rows: storage } = await db.execute(
    `SELECT name, type, sql FROM main.sqlite_schema WHERE name COLLATE NOCASE
      IN ('organization_access_policies', 'home_assistant_task_areas', 'organization_policy_protect_insert',
        'organization_policy_protect_update', 'task_home_area_protect_insert', 'task_home_area_protect_update')`,
  )
  const matches = (name, type, sql) => storage.some(entry =>
    entry.name === name && entry.type === type && matchesSql(entry.sql, sql))

  const current = Number(version?.value) >= ORGANIZATION_ACCESS_SCHEMA_VERSION
  if ((current ? 1 : 0) !== ledger.length ||
    (current && (ledger[0]?.name !== ORGANIZATION_ACCESS_MIGRATION || storage.length !== 2 + protectionTriggers.length ||
      !matches("organization_access_policies", "table", policyTable) || !matches("home_assistant_task_areas", "table", areaTable) ||
      protectionTriggers.some(([name, sql]) => !matches(name, "trigger", sql)))) ||
    (!current && storage.length)) {
    throw new Error("The Meitheal organization access schema markers disagree")
  }
  return current
}

/** @param {import("@libsql/client").Transaction} tx */
export async function applyOrganizationAccessMigration(tx) {
  if (await readOrganizationAccessMigrationState(tx)) return false
  const now = Date.now()
  await tx.batch([
    policyTable,
    areaTable,
    ...protectionTriggers.map(([, sql]) => sql),
    { sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)", args: [ORGANIZATION_ACCESS_MIGRATION, now] },
    { sql: "UPDATE main.app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(ORGANIZATION_ACCESS_SCHEMA_VERSION), now] },
  ])
  if (!await readOrganizationAccessMigrationState(tx)) throw new Error("Cannot commit organization access storage")
  return true
}
