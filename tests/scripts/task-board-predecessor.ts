import { readFile } from "node:fs/promises"
import { applyTaskDeferralMigration } from "../../apps/web/drizzle/migrations/0004_task_deferral.mjs"
import { applyTaskPinsMigration } from "../../apps/web/drizzle/migrations/0005_task_pins.mjs"
import { applyTaskDraftsMigration } from "../../apps/web/drizzle/migrations/0006_task_drafts.mjs"
import { applyCommentMentionsMigration } from "../../apps/web/drizzle/migrations/0007_comment_mentions.mjs"
import { applyTaskInactivityMigration } from "../../apps/web/drizzle/migrations/0007_task_inactivity.mjs"
import { applyTaskStallMigration } from "../../apps/web/drizzle/migrations/0008_task_stall.mjs"
import { installTaskActivityTriggers } from "../../apps/web/drizzle/migrations/task-activity-schema.mjs"
import { reconcileTaskSchemaPrerequisites } from "../../apps/web/drizzle/migrations/task-schema-prerequisites.mjs"
import type { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { splitSqlStatements } from "../../apps/web/scripts/split-sql-statements.mjs"

type Client = ReturnType<typeof openDatabase>
type Transaction = Awaited<ReturnType<Client["transaction"]>>

const sqlMigrations = [
  "0000_iteration2_init.sql", "0001_add_settings_table.sql", "0002_todo_sync.sql", "0003_feedback_reports.sql",
]

const executableMigrations = [
  ["0004_task_deferral.mjs", applyTaskDeferralMigration],
  ["0005_task_pins.mjs", applyTaskPinsMigration],
  ["0006_task_drafts.mjs", applyTaskDraftsMigration],
  ["0007_comment_mentions.mjs", applyCommentMentionsMigration],
  ["0007_task_inactivity.mjs", applyTaskInactivityMigration],
  ["0008_task_stall.mjs", applyTaskStallMigration],
] as const

export const predecessorMigrationNames = [...sqlMigrations, ...executableMigrations.map(([name]) => name)]

/** Apply the v18 CLI fixture through its last migration, independent of the candidate CLI. */
export async function prepareTaskBoardPredecessor(client: Client) {
  const tx = await client.transaction("write")
  try {
    await tx.execute("CREATE TABLE IF NOT EXISTS __meitheal_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    const { rows } = await tx.execute("SELECT name FROM __meitheal_migrations")
    const applied = new Set(rows.map(row => row.name))
    async function apply(name: string, migrate: (transaction: Transaction) => Promise<void>) {
      if (applied.has(name)) return
      await migrate(tx)
      await tx.execute({ sql: "INSERT INTO __meitheal_migrations VALUES (?, 1)", args: [name] })
    }
    for (const name of sqlMigrations) {
      await apply(name, async transaction => {
        const sql = await readFile(new URL(`../../apps/web/drizzle/migrations/${name}`, import.meta.url), "utf8")
        for (const statement of splitSqlStatements(sql)) await transaction.execute(statement)
      })
    }
    for (const [name, migrate] of executableMigrations) await apply(name, migrate)
    await tx.commit()
  } finally {
    tx.close()
  }

  await reconcileTaskSchemaPrerequisites(client)
  const activity = await client.transaction("write")
  try {
    await installTaskActivityTriggers(activity)
    await activity.commit()
  } finally {
    activity.close()
  }
}
