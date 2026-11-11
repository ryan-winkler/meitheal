import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSupportedDatabaseSchema, openDatabase } from "./database-client.mjs"
import { autoBackupDb } from "./startup-backup.mjs"
import { splitSqlStatements } from "./split-sql-statements.mjs";
import { applyTaskDeferralMigration, validateTaskDeferralSchema } from "../drizzle/migrations/0004_task_deferral.mjs"
import { applyTaskPinsMigration, validateTaskPinsSchema } from "../drizzle/migrations/0005_task_pins.mjs"
import { applyTaskDraftsMigration, validateTaskDraftsSchema } from "../drizzle/migrations/0006_task_drafts.mjs"
import { applyCommentMentionsMigration, validateCommentMentionsSchema } from "../drizzle/migrations/0007_comment_mentions.mjs"

import { applyTaskInactivityMigration, validateTaskInactivitySchema } from "../drizzle/migrations/0007_task_inactivity.mjs"

import { applyTaskStallMigration, validateTaskStallSchema } from "../drizzle/migrations/0008_task_stall.mjs"
import { reconcileTaskSchemaPrerequisites, validateTaskSchemaPrerequisites } from "../drizzle/migrations/task-schema-prerequisites.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../drizzle/migrations");
const dbUrl = process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db";
const checkOnly = process.argv.includes("--check");
const executableMigrations = new Map([
  ["0004_task_deferral.mjs", { apply: applyTaskDeferralMigration, validate: validateTaskDeferralSchema }],
  ["0005_task_pins.mjs", { apply: applyTaskPinsMigration, validate: validateTaskPinsSchema }],
  ["0006_task_drafts.mjs", { apply: applyTaskDraftsMigration, validate: validateTaskDraftsSchema }],
  ["0007_comment_mentions.mjs", { apply: applyCommentMentionsMigration, validate: validateCommentMentionsSchema }],
  ["0007_task_inactivity.mjs", { apply: applyTaskInactivityMigration, validate: validateTaskInactivitySchema }],
  ["0008_task_stall.mjs", {
    async apply(tx) {
      await validateCommentMentionsSchema(tx)
      await validateTaskInactivitySchema(tx)
      await applyTaskStallMigration(tx)
    },
    validate: validateTaskStallSchema,
  }],
])

/** @param {ReturnType<typeof openDatabase>} client */
async function main(client) {
  await assertSupportedDatabaseSchema(client)
  const files = (await readdir(migrationsDir))
    .filter(name => name.endsWith(".sql") || executableMigrations.has(name)).sort()
  if (!checkOnly) {
    await autoBackupDb(client)
    const tx = await client.transaction("write")
    try {
      await assertSupportedDatabaseSchema(tx)
      await tx.execute(`
        CREATE TABLE IF NOT EXISTS __meitheal_migrations (
          name TEXT PRIMARY KEY,
          applied_at INTEGER NOT NULL
        )
      `)
      await tx.commit()
    } finally { tx.close() }
  }
  const ledger = await client.execute("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '__meitheal_migrations' COLLATE NOCASE")
  const applied = new Set(ledger.rows.length ? (await client.execute("SELECT name AS name FROM __meitheal_migrations")).rows.map(row => row.name) : [])
  const pending = files.filter(file => !applied.has(file))

  if (checkOnly) {
    if (pending.length > 0) {
      console.error(`Pending migrations: ${pending.join(", ")}`);
      return 1;
    }
    for (const migration of executableMigrations.values()) await migration.validate(client)
    await validateTaskSchemaPrerequisites(client)
    console.log("Migration check passed (no pending migrations).");
    return 0;
  }

  for (const file of pending) {
    const migration = executableMigrations.get(file)
    const statements = migration ? [] :
      splitSqlStatements(await readFile(path.join(migrationsDir, file), "utf8"))

    const tx = await client.transaction("write");
    try {
      await assertSupportedDatabaseSchema(tx)
      const existing = await tx.execute({
        sql: "SELECT name FROM __meitheal_migrations WHERE name = ?",
        args: [file],
      })
      if (existing.rows.length > 0) {
        await migration?.validate(tx)
        await tx.commit()
        continue
      }
      await migration?.apply(tx)
      for (const statement of statements) {
        await tx.execute(statement);
      }

      await tx.execute({
        sql: "INSERT INTO __meitheal_migrations(name, applied_at) VALUES(?, ?)",
        args: [file, Date.now()]
      });

      await tx.commit();
      console.log(`Applied migration: ${file}`);
    } catch (error) {
      await tx.rollback();
      console.error(`Failed migration: ${file}`);
      throw error;
    } finally {
      tx.close();
    }
  }

  for (const migration of executableMigrations.values()) await migration.validate(client)
  await reconcileTaskSchemaPrerequisites(client)
  if (pending.length === 0) {
    console.log("No migrations to apply.");
  }

  return 0;
}

let exitCode = 0;
let fatalError = null;
/** @type {ReturnType<typeof openDatabase> | undefined} */
let client
try {
  if (!checkOnly && dbUrl.startsWith("file:")) {
    await mkdir(path.dirname(path.resolve(dbUrl.slice("file:".length))), { recursive: true })
  }
  client = openDatabase(dbUrl, { readOnly: checkOnly })
  exitCode = await main(client);
} catch (error) {
  exitCode = 1;
  fatalError = error;
} finally {
  client?.close();
}

if (fatalError) {
  console.error(fatalError);
  process.exit(1);
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
