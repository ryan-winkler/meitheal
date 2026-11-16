import { matchesSql } from "./board-storage-schema.mjs"

export const PERSONAL_PILLAR_SCHEMA_VERSION = 20
export const PERSONAL_PILLAR_MIGRATION = "0010_personal_pillars.mjs"

const pillaredTable = `CREATE TABLE IF NOT EXISTS main.pillars (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  manifesto TEXT,
  icon TEXT NOT NULL DEFAULT '🏛️',
  color_hex TEXT NOT NULL DEFAULT '#6366f1',
  weight INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  slug TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`

const ownershipTriggers = [
  ["pillars_owner_insert", `CREATE TRIGGER main.pillars_owner_insert BEFORE INSERT ON pillars
    WHEN (NEW.user_id IS NOT 'default'
      AND (length(NEW.user_id) <> 64 OR NEW.user_id GLOB '*[^0-9a-f]*'))
      OR EXISTS (SELECT 1 FROM pillars WHERE id = NEW.id AND user_id IS NOT NEW.user_id)
    BEGIN SELECT RAISE(ABORT, 'Invalid Pillar owner'); END`],
  ["pillars_owner_immutable", `CREATE TRIGGER main.pillars_owner_immutable BEFORE UPDATE OF user_id ON pillars
    WHEN NEW.user_id IS NOT OLD.user_id
    BEGIN SELECT RAISE(ABORT, 'Pillar owner is immutable'); END`],
]

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
async function installPillarOwnershipTriggers(db) {
  for (const [name, sql] of ownershipTriggers) {
    await db.execute(sql.replace(`TRIGGER main.${name}`, `TRIGGER IF NOT EXISTS main.${name}`))
  }
}

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readPersonalPillarMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM main.app_settings WHERE key = 'schema_version'")
  const { rows: ledger } = await db.execute({
    sql: "SELECT name FROM main.__meitheal_migrations WHERE name = ? COLLATE NOCASE LIMIT 2",
    args: [PERSONAL_PILLAR_MIGRATION],
  })
  const current = version?.value === String(PERSONAL_PILLAR_SCHEMA_VERSION)
  if ((current ? 1 : 0) !== ledger.length || (current && ledger[0]?.name !== PERSONAL_PILLAR_MIGRATION)) {
    throw new Error("The Meitheal Personal Pillar schema markers disagree")
  }
  if (current) {
    const { rows } = await db.execute(`SELECT name, type, sql FROM main.sqlite_schema
      WHERE name COLLATE NOCASE IN ('pillars', 'pillars_owner_insert', 'pillars_owner_immutable')`)
    if (rows.find(row => row.name === "pillars")?.type !== "table") {
      throw new Error("Personal Pillar storage is missing")
    }
    for (const [name, sql] of ownershipTriggers) {
      const trigger = rows.find(row => row.name === name)
      if (trigger?.type !== "trigger" || !matchesSql(trigger.sql, sql.replace("TRIGGER main.", "TRIGGER "))) {
        throw new Error("Personal Pillar ownership guard is missing or changed")
      }
    }
  }
  return current
}

/** @param {import("@libsql/client").Transaction} tx */
export async function applyPersonalPillarMigration(tx) {
  if (await readPersonalPillarMigrationState(tx)) return false
  const { rows } = await tx.execute("SELECT type FROM main.sqlite_schema WHERE name = 'pillars' COLLATE NOCASE")
  if (rows.length) {
    if (rows.length !== 1 || rows[0]?.type !== "table") throw new Error("Pillars must be stored in an ordinary table")
    const { rows: scoped } = await tx.execute("SELECT 1 FROM main.pillars WHERE user_id IS NOT 'default' LIMIT 1")
    if (scoped.length) throw new Error("Pillars have owner data without a Personal Pillar migration record")
  }
  await tx.execute(pillaredTable)
  await installPillarOwnershipTriggers(tx)

  const now = Date.now()
  await tx.batch([
    { sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)", args: [PERSONAL_PILLAR_MIGRATION, now] },
    { sql: "UPDATE main.app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'",
      args: [String(PERSONAL_PILLAR_SCHEMA_VERSION), now] },
  ])
  if (!await readPersonalPillarMigrationState(tx)) throw new Error("Cannot commit Personal Pillar ownership")
  return true
}
