import { matchesSql } from "./board-storage-schema.mjs"

export const ORGANIZATION_LABEL_SCHEMA_VERSION = 22
export const ORGANIZATION_LABEL_MIGRATION = "0012_organization_labels.mjs"

const table = `CREATE TABLE organization_label_preferences (
    user_id TEXT NOT NULL,
    locale TEXT NOT NULL,
    forms TEXT NOT NULL CHECK (json_valid(forms) AND json_type(forms) = 'object'),
    revision TEXT NOT NULL,
    PRIMARY KEY (user_id, locale)
  ) STRICT`
const guard = (event) => `CREATE TRIGGER organization_label_protect_${event}
  AFTER ${event === "update" ? "UPDATE OF forms" : "INSERT"} ON organization_label_preferences
  WHEN NEW.forms <> '{}'
  BEGIN
    INSERT OR IGNORE INTO app_settings (key, value, updated_at)
    VALUES ('private_organization_data', '1', 0);
  END`

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readOrganizationLabelMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM main.app_settings WHERE key = 'schema_version'")
  const { rows: [record, duplicate] } = await db.execute({
    sql: "SELECT name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
    args: [ORGANIZATION_LABEL_MIGRATION],
  })
  const { rows: storage } = await db.execute(`SELECT name, type, sql FROM main.sqlite_schema
    WHERE name COLLATE NOCASE IN ('organization_label_preferences', 'organization_label_protect_insert', 'organization_label_protect_update')`)
  const matches = (name, type, sql) => storage.some(entry => entry.name === name && entry.type === type && matchesSql(entry.sql, sql))
  const applied = Number(version?.value) >= ORGANIZATION_LABEL_SCHEMA_VERSION
  if (duplicate || (applied ? record?.name !== ORGANIZATION_LABEL_MIGRATION : record !== undefined) ||
    (applied && (storage.length !== 3 || !matches("organization_label_preferences", "table", table) ||
      !matches("organization_label_protect_insert", "trigger", guard("insert")) ||
      !matches("organization_label_protect_update", "trigger", guard("update")))) ||
    (!applied && storage.length && (storage.length !== 1 || !matches("organization_label_preferences", "table", table)))) {
    throw new Error("The Meitheal organization label schema markers disagree")
  }
  return applied
}

/** @param {import("@libsql/client").Transaction} tx */
export async function applyOrganizationLabelMigration(tx) {
  if (await readOrganizationLabelMigrationState(tx)) return false
  const now = Date.now()
  await tx.batch([
    table.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS"),
    guard("insert"), guard("update"),
    // A previous candidate could already have cleared a label without wiping SQLite page history.
    `INSERT OR IGNORE INTO app_settings (key, value, updated_at)
      SELECT 'private_organization_data', '1', 0 FROM organization_label_preferences LIMIT 1`,
    { sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)", args: [ORGANIZATION_LABEL_MIGRATION, now] },
    { sql: "UPDATE main.app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(ORGANIZATION_LABEL_SCHEMA_VERSION), now] },
  ])
  if (!await readOrganizationLabelMigrationState(tx)) throw new Error("Cannot commit organization labels")
  return true
}
