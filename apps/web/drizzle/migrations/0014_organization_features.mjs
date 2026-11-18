import { matchesSql } from "./board-storage-schema.mjs"

export const ORGANIZATION_FEATURE_SCHEMA_VERSION = 24
export const ORGANIZATION_FEATURE_MIGRATION = "0014_organization_features.mjs"

const triggers = [
  ...["insert", "update"].map(event => [
    "organization_nobody_protect_" + event,
    `CREATE TRIGGER organization_nobody_protect_${event} AFTER ${event.toUpperCase()} ON organization_access_policies
      WHEN NEW.audience = 'nobody'
      BEGIN
        INSERT INTO app_settings (key, value, updated_at)
        SELECT 'private_organization_data', '1', 0
        WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'private_organization_data');
      END`,
  ]),
  ["routine_occurrence_date_fixed", `CREATE TRIGGER routine_occurrence_date_fixed BEFORE UPDATE OF due_date ON tasks
    WHEN OLD.task_kind = 'routine_instance' AND OLD.source_template_id IS NOT NULL
      AND OLD.due_date IS NOT NULL AND NEW.due_date IS NOT OLD.due_date
    BEGIN
      SELECT RAISE(ABORT, 'A Routine occurrence keeps its original date');
    END`],
]

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readOrganizationFeatureMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM main.app_settings WHERE key = 'schema_version'")
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
    args: [ORGANIZATION_FEATURE_MIGRATION],
  })
  const { rows } = await db.execute(`SELECT name, sql FROM main.sqlite_schema
    WHERE type = 'trigger' AND name IN ('organization_nobody_protect_insert', 'organization_nobody_protect_update', 'routine_occurrence_date_fixed')`)
  const current = Number(version?.value) >= ORGANIZATION_FEATURE_SCHEMA_VERSION
  if ((current ? 1 : 0) !== ledger.length ||
    (current && (ledger[0]?.name !== ORGANIZATION_FEATURE_MIGRATION || rows.length !== triggers.length ||
      triggers.some(([name, sql]) => !rows.some(row => row.name === name && matchesSql(row.sql, sql))))) ||
    (!current && rows.length)) throw new Error("The Meitheal organization feature schema markers disagree")
  return current
}

/** @param {import("@libsql/client").Transaction} tx */
export async function applyOrganizationFeatureMigration(tx) {
  if (await readOrganizationFeatureMigrationState(tx)) return false
  const now = Date.now()
  await tx.batch([
    ...triggers.map(([, sql]) => sql),
    `INSERT INTO app_settings (key, value, updated_at)
      SELECT 'private_organization_data', '1', 0 WHERE
        EXISTS (SELECT 1 FROM organization_access_policies WHERE audience = 'nobody')
        AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'private_organization_data')`,
    { sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)", args: [ORGANIZATION_FEATURE_MIGRATION, now] },
    { sql: "UPDATE main.app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(ORGANIZATION_FEATURE_SCHEMA_VERSION), now] },
  ])
  if (!await readOrganizationFeatureMigrationState(tx)) throw new Error("Cannot commit organization feature storage")
  return true
}
