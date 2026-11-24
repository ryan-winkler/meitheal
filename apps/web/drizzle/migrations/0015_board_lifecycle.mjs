import { taskReactionStorageSql } from "./task-reaction-schema.mjs"
import { matchesSql } from "./board-storage-schema.mjs"
import { lifecycleHouseholdIdentitySql } from "./task-board-household.mjs"
import { ordinaryRetirementTriggers } from "./0016_ordinary_boards.mjs"

export const BOARD_LIFECYCLE_SCHEMA_VERSION = 25
export const BOARD_LIFECYCLE_MIGRATION = "0015_board_lifecycle.mjs"

const scoped = {
  tasks: "task_board_id IS NULL",
  areas: "owner_board_id IS NULL",
  projects: "owner_board_id IS NULL",
  goals: "owner_board_id IS NULL",
  task_templates: "owner_board_id IS NULL",
  pillars: "owner_board_id IS NULL AND user_id = 'default'",
  kanban_lanes: "board_id = 'household'",
  task_drafts: "board_id = 'household'",
  task_draft_receipts: "board_id = 'household'",
}
const paused = "EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'retired')"
export const householdRetirementTriggers = Object.entries(scoped).flatMap(([table, predicate]) =>
  ["INSERT", "UPDATE", "DELETE"].map(event => {
    const old = event === "INSERT" ? null : predicate.replace(/([a-z_]+) (IS|=)/g, "OLD.$1 $2")
    const next = event === "DELETE" ? null : predicate.replace(/([a-z_]+) (IS|=)/g, "NEW.$1 $2")
    const replaced = event === "INSERT" && !table.startsWith("task_draft")
      ? `EXISTS (SELECT 1 FROM ${table} AS existing WHERE existing.id = NEW.id AND ${predicate.replace(/([a-z_]+) (IS|=)/g, "existing.$1 $2")})` : null
    const name = `household_retired_${table}_${event.toLowerCase()}`
    return [name, `CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
      WHEN ${paused} AND (${[old, next, replaced].filter(Boolean).join(" OR ")})
      BEGIN SELECT RAISE(ABORT, 'Household Board is deleted. Restore it from Boards to resume shared work.'); END`]
  })).concat(["principles", "pillar_associations"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => {
    const aliases = event === "INSERT" ? ["NEW"] : event === "DELETE" ? ["OLD"] : ["OLD", "NEW"]
    if (event === "INSERT") aliases.push("existing")
    const condition = aliases.map(alias => alias === "existing"
      ? `EXISTS (SELECT 1 FROM ${table} AS existing JOIN pillars ON pillars.id = existing.pillar_id
          WHERE existing.id = NEW.id AND pillars.owner_board_id IS NULL AND pillars.user_id = 'default')`
      : `EXISTS (SELECT 1 FROM pillars WHERE id = ${alias}.pillar_id
          AND owner_board_id IS NULL AND user_id = 'default')`).join(" OR ")
    const name = `household_retired_${table}_${event.toLowerCase()}`
    return [name, `CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
      WHEN ${paused} AND (${condition})
      BEGIN SELECT RAISE(ABORT, 'Household Board is deleted. Restore it from Boards to resume shared work.'); END`]
  }))).concat(["task_pins", "task_reactions", "home_assistant_task_areas", "calendar_confirmations", "todo_sync_confirmations", "comments", "comment_mentions", "comment_mention_attempts"].flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(event => {
    const aliases = event === "INSERT" ? ["NEW"] : event === "DELETE" ? ["OLD"] : ["OLD", "NEW"]
    const conditions = aliases.map(alias => `EXISTS (SELECT 1 FROM tasks
      WHERE tasks.id = ${alias}.task_id AND tasks.task_board_id IS NULL)`)
    // Replacing an existing reaction with a different parent must still respect its saved Board.
    const replacementKey = ["task_reactions", "comments", "comment_mentions"].includes(table) ? "id"
      : table === "calendar_confirmations" || table === "todo_sync_confirmations" ? "confirmation_id" : null
    if (event === "INSERT" && replacementKey) conditions.push(`EXISTS (
      SELECT 1 FROM ${table} AS existing JOIN tasks ON tasks.id = existing.task_id
      WHERE existing.${replacementKey} = NEW.${replacementKey} AND tasks.task_board_id IS NULL)`)
    const name = `household_retired_${table}_${event.toLowerCase()}`
    return [name, `CREATE TRIGGER ${name} BEFORE ${event} ON ${table}
      WHEN ${paused} AND (${conditions.join(" OR ")})
      BEGIN SELECT RAISE(ABORT, 'Household Board is deleted. Restore it from Boards to resume shared work.'); END`]
  })))

/** @param {Pick<import("@libsql/client").Client, "execute">} db */
export async function readBoardLifecycleMigrationState(db) {
  const { rows: [version] } = await db.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
  const { rows: ledger } = await db.execute({ sql: "SELECT name FROM __meitheal_migrations WHERE name = ? COLLATE NOCASE", args: [BOARD_LIFECYCLE_MIGRATION] })
  const { rows } = await db.execute("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND (name LIKE 'household_retired_%' OR name LIKE 'board_retired_%')")
  const current = Number(version?.value) >= BOARD_LIFECYCLE_SCHEMA_VERSION
  const expected = Number(version?.value) >= 26 ? ordinaryRetirementTriggers : householdRetirementTriggers
  if ((current ? 1 : 0) !== ledger.length || (current && (ledger[0]?.name !== BOARD_LIFECYCLE_MIGRATION ||
    rows.length !== expected.length || expected.some(([name, sql]) =>
      !rows.some(row => row.name === name && matchesSql(row.sql, sql))))) || (!current && rows.length)) {
    throw new Error("The Meitheal Board lifecycle schema markers disagree")
  }
  return current
}

/** @param {import("@libsql/client").Transaction} tx */
export async function applyBoardLifecycleMigration(tx) {
  if (await readBoardLifecycleMigrationState(tx)) return false
  const now = Date.now()
  await tx.batch(taskReactionStorageSql)
  await tx.batch([
    "DROP TRIGGER task_boards_household_identity_update", lifecycleHouseholdIdentitySql,
    ...householdRetirementTriggers.map(([, sql]) => sql),
    { sql: "INSERT INTO __meitheal_migrations(name, applied_at) VALUES (?, ?)", args: [BOARD_LIFECYCLE_MIGRATION, now] },
    { sql: "UPDATE app_settings SET value = ?, updated_at = ? WHERE key = 'schema_version'", args: [String(BOARD_LIFECYCLE_SCHEMA_VERSION), now] },
  ])
  if (!await readBoardLifecycleMigrationState(tx)) throw new Error("Cannot commit Board lifecycle storage")
  return true
}
