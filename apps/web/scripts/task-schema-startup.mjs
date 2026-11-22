import { applyBoardLifecycleMigration, BOARD_LIFECYCLE_MIGRATION, readBoardLifecycleMigrationState } from "../drizzle/migrations/0015_board_lifecycle.mjs"
import {
  applyOrganizationFeatureMigration, ORGANIZATION_FEATURE_MIGRATION, readOrganizationFeatureMigrationState,
} from "../drizzle/migrations/0014_organization_features.mjs"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { applyTaskDeferralMigration, validateTaskDeferralSchema } from "../drizzle/migrations/0004_task_deferral.mjs"
import { applyTaskPinsMigration, validateTaskPinsSchema } from "../drizzle/migrations/0005_task_pins.mjs"
import { applyTaskDraftsMigration, validateTaskDraftsSchema } from "../drizzle/migrations/0006_task_drafts.mjs"
import { applyCommentMentionsMigration, validateCommentMentionsSchema } from "../drizzle/migrations/0007_comment_mentions.mjs"
import { applyTaskInactivityMigration, validateTaskInactivitySchema } from "../drizzle/migrations/0007_task_inactivity.mjs"
import { applyTaskStallMigration, validateTaskStallSchema } from "../drizzle/migrations/0008_task_stall.mjs"
import {
  applyPersonalPillarMigration, PERSONAL_PILLAR_MIGRATION, readPersonalPillarMigrationState,
} from "../drizzle/migrations/0010_personal_pillars.mjs"
import {
  applyBoardAccessMigration, BOARD_ACCESS_MIGRATION, readBoardAccessMigrationState,
} from "../drizzle/migrations/0011_board_access.mjs"
import {
  applyOrganizationAccessMigration, ORGANIZATION_ACCESS_MIGRATION, readOrganizationAccessMigrationState,
} from "../drizzle/migrations/0013_organization_access.mjs"
import {
  applyOrganizationLabelMigration, ORGANIZATION_LABEL_MIGRATION, readOrganizationLabelMigrationState,
} from "../drizzle/migrations/0012_organization_labels.mjs"
import { assertNoInboundReferences } from "../drizzle/migrations/board-storage-schema.mjs"
import { installTaskActivityTriggers, validateTaskActivityTriggers } from "../drizzle/migrations/task-activity-schema.mjs"
import {
  applyTaskBoardUpgrade, readTaskBoardMigrationState, TASK_BOARD_MIGRATION, validateTaskBoardUpgrade,
} from "../drizzle/migrations/task-board-upgrade.mjs"
import {
  applyTaskSchemaPrerequisites, seedHouseholdTaskPrerequisites, validateTaskSchemaPrerequisites,
} from "../drizzle/migrations/task-schema-prerequisites.mjs"
import { splitSqlStatements } from "./split-sql-statements.mjs"
import { applyOrdinaryBoardMigration, readOrdinaryBoardMigrationState, ORDINARY_BOARD_MIGRATION } from "../drizzle/migrations/0016_ordinary_boards.mjs"
import { applyCustomBoardKeysMigration, readCustomBoardKeysMigrationState, CUSTOM_BOARD_KEYS_MIGRATION } from "../drizzle/migrations/0017_custom_board_keys.mjs"
import { admitStartupBoardTransition } from "./board-grant-journal.mjs"

/** @typedef {import("@libsql/client").Transaction} Transaction */

const sqlMigrations = [
  "0000_iteration2_init.sql",
  "0001_add_settings_table.sql",
  "0002_todo_sync.sql",
  "0003_feedback_reports.sql",
]
const draftMigration = "0006_task_drafts.mjs"
/** @type {Array<[string, (tx: Transaction) => Promise<void>, (tx: Transaction) => Promise<void>]>} */
const executableMigrations = [
  ["0004_task_deferral.mjs", applyTaskDeferralMigration, validateTaskDeferralSchema],
  ["0005_task_pins.mjs", applyTaskPinsMigration, validateTaskPinsSchema],
  [draftMigration, applyTaskDraftsMigration, validateTaskDraftsSchema],
  ["0007_comment_mentions.mjs", applyCommentMentionsMigration, validateCommentMentionsSchema],
  ["0007_task_inactivity.mjs", applyTaskInactivityMigration, validateTaskInactivitySchema],
  ["0008_task_stall.mjs", applyTaskStallMigration, validateTaskStallSchema],
]
const predecessorMigrations = [...sqlMigrations, ...executableMigrations.map(([name]) => name)]
const boardMigrations = [...predecessorMigrations, TASK_BOARD_MIGRATION]

/** The source script and the Astro server chunk both live under the application root. */
function findSqlMigrations() {
  let directory = path.dirname(fileURLToPath(import.meta.url))
  while (true) {
    const migrations = path.join(directory, "drizzle", "migrations")
    if (existsSync(path.join(migrations, sqlMigrations[0]))) return migrations
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error("Meitheal predecessor SQL migrations are missing")
    directory = parent
  }
}

/** @param {Transaction} tx */
async function readLedger(tx) {
  const { rows: tables } = await tx.execute(
    "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = '__meitheal_migrations' COLLATE NOCASE",
  )
  if (tables.length === 0) return new Map()
  const { rows } = await tx.execute("SELECT name, applied_at FROM main.__meitheal_migrations")
  const ledger = new Map(rows.map(row => [row.name, row.applied_at]))
  if (ledger.size !== rows.length) throw new Error("The migration ledger contains duplicate entries")
  return ledger
}

/** @param {Transaction} tx @param {boolean} boardScopedLanes */
async function validateTaskMigrationShape(tx, boardScopedLanes) {
  for (const [name, , validate] of executableMigrations) {
    if (!boardScopedLanes || name !== draftMigration) await validate(tx)
  }
  await validateTaskSchemaPrerequisites(tx, { boardScopedLanes })
  await validateTaskActivityTriggers(tx)
}

/** @param {Transaction} tx */
async function validateCommittedTaskSchema(tx) {
  const ledger = await readLedger(tx)
  const pending = boardMigrations.filter(name => !ledger.has(name))
  if (pending.length > 0) throw new Error(`Pending migrations: ${pending.join(", ")}`)
  await validateTaskMigrationShape(tx, true)
  await validateTaskBoardUpgrade(tx, { namedStorage: await readBoardAccessMigrationState(tx) })
}

/** @param {Transaction} tx @param {{ allowPending?: boolean }} [options] */
export async function validateStartupTaskSchema(tx, { allowPending = false } = {}) {
  if (await readTaskBoardMigrationState(tx) !== "household-v19") {
    const ledger = await readLedger(tx)
    const pending = boardMigrations.filter(name => !ledger.has(name))
    if (pending.length === 1) await validateTaskMigrationShape(tx, false)
    throw new Error(`Pending migrations: ${pending.join(", ")}`)
  }
  await validateCommittedTaskSchema(tx)
  const personalReady = await readPersonalPillarMigrationState(tx)
  const accessReady = await readBoardAccessMigrationState(tx)
  const labelsReady = await readOrganizationLabelMigrationState(tx)
  const organizationAccessReady = await readOrganizationAccessMigrationState(tx)
  const featuresReady = await readOrganizationFeatureMigrationState(tx)
  const lifecycleReady = await readBoardLifecycleMigrationState(tx)
  const ordinaryReady = await readOrdinaryBoardMigrationState(tx)
  const customKeysReady = ordinaryReady ? await readCustomBoardKeysMigrationState(tx) : false
  if (!allowPending) {
    const pending = [
      !personalReady && PERSONAL_PILLAR_MIGRATION,
      !accessReady && BOARD_ACCESS_MIGRATION,
      !labelsReady && ORGANIZATION_LABEL_MIGRATION,
      !organizationAccessReady && ORGANIZATION_ACCESS_MIGRATION,
      !featuresReady && ORGANIZATION_FEATURE_MIGRATION,
      !lifecycleReady && BOARD_LIFECYCLE_MIGRATION,
      !ordinaryReady && ORDINARY_BOARD_MIGRATION,
      !customKeysReady && CUSTOM_BOARD_KEYS_MIGRATION,
    ].filter(Boolean)
    if (pending.length) throw new Error(`Pending migrations: ${pending.join(", ")}`)
  }
}

/**
 * Apply the predecessor and Board migrations on the caller's pinned startup writer.
 * @param {Transaction} tx
 * @param {(tx: Transaction) => Promise<void>} [prepareRuntime]
 * @returns {Promise<string[]>} basenames recorded by this transaction
 */
export async function applyStartupTaskSchema(tx, prepareRuntime) {
  if (await readTaskBoardMigrationState(tx) === "household-v19") {
    await validateCommittedTaskSchema(tx)
    const { rows: [version] } = await tx.execute("SELECT value FROM app_settings WHERE key = 'schema_version'")
    if (Number(version?.value) < 26) await seedHouseholdTaskPrerequisites(tx)
    await prepareRuntime?.(tx)
    const applied = []
    if (await applyPersonalPillarMigration(tx)) applied.push(PERSONAL_PILLAR_MIGRATION)
    if (await applyBoardAccessMigration(tx)) applied.push(BOARD_ACCESS_MIGRATION)
    if (await applyOrganizationLabelMigration(tx)) applied.push(ORGANIZATION_LABEL_MIGRATION)
    if (await applyOrganizationAccessMigration(tx)) applied.push(ORGANIZATION_ACCESS_MIGRATION)
    if (await applyOrganizationFeatureMigration(tx)) applied.push(ORGANIZATION_FEATURE_MIGRATION)
    if (await applyBoardLifecycleMigration(tx)) applied.push(BOARD_LIFECYCLE_MIGRATION)
    return applied
  }

  await assertNoInboundReferences(tx, ["__meitheal_migrations", "app_settings"])
  const prior = await readLedger(tx)
  const pending = predecessorMigrations.filter(name => !prior.has(name))
  const pendingSql = sqlMigrations.filter(name => !prior.has(name))
  if (pendingSql.length > 0) {
    const directory = findSqlMigrations()
    for (const name of pendingSql) {
      const source = await readFile(path.join(directory, name), "utf8")
      for (const statement of splitSqlStatements(source)) await tx.execute(statement)
    }
  }
  for (const [name, apply, validate] of executableMigrations) {
    if (!prior.has(name)) await apply(tx)
    await validate(tx)
  }
  await applyTaskSchemaPrerequisites(tx)
  await prepareRuntime?.(tx)
  await installTaskActivityTriggers(tx)

  await tx.execute(`CREATE TABLE IF NOT EXISTS main.__meitheal_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`)
  const now = Date.now()
  for (const name of pending) {
    await tx.execute({
      sql: "INSERT INTO main.__meitheal_migrations (name, applied_at) VALUES (?, ?)",
      args: [name, now],
    })
  }
  const ledger = await readLedger(tx)
  if ([...prior].some(([name, stamp]) => !ledger.has(name) || ledger.get(name) !== stamp)) {
    throw new Error("The Board upgrade changed an existing migration ledger entry")
  }
  await applyTaskBoardUpgrade(tx, predecessorMigrations)
  await applyPersonalPillarMigration(tx)
  await applyBoardAccessMigration(tx)
  await applyOrganizationLabelMigration(tx)
  await applyOrganizationAccessMigration(tx)
  await applyOrganizationFeatureMigration(tx)
  await applyBoardLifecycleMigration(tx)
  return [...pending, TASK_BOARD_MIGRATION, PERSONAL_PILLAR_MIGRATION, BOARD_ACCESS_MIGRATION, ORGANIZATION_LABEL_MIGRATION, ORGANIZATION_ACCESS_MIGRATION, ORGANIZATION_FEATURE_MIGRATION, BOARD_LIFECYCLE_MIGRATION]
}

/** One startup entrypoint for the server, migrator and consumed cold operator flow. */
export async function applyStartupBoardSchema(client, tx, prepareRuntime, { operatorAdmission } = {}) {
  const applied = await applyStartupTaskSchema(tx, prepareRuntime)
  if (await readOrdinaryBoardMigrationState(tx)) {
    if (await applyCustomBoardKeysMigration(tx)) applied.push(CUSTOM_BOARD_KEYS_MIGRATION)
    // Do not acquire a nested writer while this startup writer is held.
    const { boardGrantStillCurrent, databaseRevision, getBoardGrantPath, publishCommittedMarker } = await import("./board-grant-journal.mjs")
    const revision = await databaseRevision(tx)
    const path = getBoardGrantPath(client)
    const ready = revision && await publishCommittedMarker(path, revision) && await boardGrantStillCurrent(tx, revision, path)
    return { applied, state: ready ? "ready" : "continuity_locked", pending: [], revision: ready ? revision : null }
  }
  const transition = await admitStartupBoardTransition(client, tx, operatorAdmission)
  if (!transition) return { applied, state: "continuity_locked", pending: [ORDINARY_BOARD_MIGRATION], revision: null }
  await applyOrdinaryBoardMigration(tx, transition.admission)
  applied.push(ORDINARY_BOARD_MIGRATION)
  if (await applyCustomBoardKeysMigration(tx)) applied.push(CUSTOM_BOARD_KEYS_MIGRATION)
  return { applied, state: "ready", pending: [], revision: transition.revision }
}
