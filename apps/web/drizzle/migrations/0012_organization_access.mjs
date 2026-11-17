import { matchesSql } from "./board-storage-schema.mjs"

export const ORGANIZATION_ACCESS_SCHEMA_VERSION = 22
export const ORGANIZATION_ACCESS_MIGRATION = "0012_organization_access.mjs"

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
  area_id TEXT NOT NULL CHECK (length(area_id) BETWEEN 1 AND 150)
) STRICT`

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readOrganizationAccessMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM main.app_settings WHERE key = 'schema_version'")
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
    args: [ORGANIZATION_ACCESS_MIGRATION],
  })
  const { rows: storage } = await db.execute(
    `SELECT name, type, sql FROM main.sqlite_schema WHERE name COLLATE NOCASE
      IN ('organization_access_policies', 'home_assistant_task_areas')`,
  )
  const matches = (name, sql) => storage.some(entry =>
    entry.name === name && entry.type === "table" && matchesSql(entry.sql, sql))

  const current = Number(version?.value) >= ORGANIZATION_ACCESS_SCHEMA_VERSION
  if ((current ? 1 : 0) !== ledger.length ||
    (current && (ledger[0]?.name !== ORGANIZATION_ACCESS_MIGRATION || storage.length !== 2 ||
      !matches("organization_access_policies", policyTable) || !matches("home_assistant_task_areas", areaTable))) ||
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
    { sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)", args: [ORGANIZATION_ACCESS_MIGRATION, now] },
    { sql: "UPDATE main.app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(ORGANIZATION_ACCESS_SCHEMA_VERSION), now] },
  ])
  if (!await readOrganizationAccessMigrationState(tx)) throw new Error("Cannot commit organization access storage")
  return true
}
