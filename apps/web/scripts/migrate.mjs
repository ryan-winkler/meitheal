import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database-client.mjs"
import { autoBackupDb } from "./startup-backup.mjs"
import { splitSqlStatements } from "./split-sql-statements.mjs";
import { applyTaskDeferralMigration, validateTaskDeferralSchema } from "../drizzle/migrations/0004_task_deferral.mjs"
import { applyTaskPinsMigration, validateTaskPinsSchema } from "../drizzle/migrations/0005_task_pins.mjs"
import { applyTaskDraftsMigration, validateTaskDraftsSchema } from "../drizzle/migrations/0006_task_drafts.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, "../drizzle/migrations");
const dbUrl = process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db";
const checkOnly = process.argv.includes("--check");
const executableMigrations = new Map([
  ["0004_task_deferral.mjs", { apply: applyTaskDeferralMigration, validate: validateTaskDeferralSchema }],
  ["0005_task_pins.mjs", { apply: applyTaskPinsMigration, validate: validateTaskPinsSchema }],
  ["0006_task_drafts.mjs", { apply: applyTaskDraftsMigration, validate: validateTaskDraftsSchema }],
])

if (dbUrl.startsWith("file:")) {
  const dbPath = dbUrl.slice("file:".length);
  const absolutePath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
}

const client = openDatabase(dbUrl)

async function main() {
  if (!checkOnly) await autoBackupDb(client)

  await client.execute(`
    CREATE TABLE IF NOT EXISTS __meitheal_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter(name => name.endsWith(".sql") || executableMigrations.has(name)).sort()
  const pending = [];

  for (const file of files) {
    const existing = await client.execute({
      sql: "SELECT name FROM __meitheal_migrations WHERE name = ? LIMIT 1",
      args: [file]
    });
    if (existing.rows.length === 0) {
      pending.push(file);
    }
  }

  if (checkOnly) {
    if (pending.length > 0) {
      console.error(`Pending migrations: ${pending.join(", ")}`);
      return 1;
    }
    for (const migration of executableMigrations.values()) await migration.validate(client)
    console.log("Migration check passed (no pending migrations).");
    return 0;
  }

  for (const file of pending) {
    const migration = executableMigrations.get(file)
    const statements = migration ? [] :
      splitSqlStatements(await readFile(path.join(migrationsDir, file), "utf8"))

    const tx = await client.transaction("write");
    try {
      if (migration) {
        const existing = await tx.execute({
          sql: "SELECT name FROM __meitheal_migrations WHERE name = ?",
          args: [file],
        })
        if (existing.rows.length > 0) {
          await migration.validate(tx)
          await tx.commit()
          continue
        }
        await migration.apply(tx)
      }
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

  if (pending.length === 0) {
    console.log("No migrations to apply.");
  }

  return 0;
}

let exitCode = 0;
let fatalError = null;
try {
  exitCode = await main();
} catch (error) {
  exitCode = 1;
  fatalError = error;
} finally {
  await client.close();
}

if (fatalError) {
  console.error(fatalError);
  process.exit(1);
}

if (exitCode !== 0) {
  process.exit(exitCode);
}
