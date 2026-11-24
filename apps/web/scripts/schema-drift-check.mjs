import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { openDatabaseForStartup } from "./database-client.mjs"
import { validateStartupTaskSchema } from "./task-schema-startup.mjs"

const execFileAsync = promisify(execFile)

const expectedSchema = {
  tasks: [
    "id",
    "title",
    "status",
    "framework_payload",
    "calendar_sync_state",
    "idempotency_key",
    "request_id",
    "created_at",
    "updated_at",
    "deferred_at",
    "deferral_revision",
    "inactivity_touched_at", "last_activity_spike_at",
    "source",
    "created_by",
    "table_position"
  ],
  archived_task_favorites: ["task_id", "task_board_id", "archived_at"],
  domain_events: ["event_id", "event_type", "task_id", "request_id", "idempotency_key", "payload", "created_at"],
  integration_attempts: [
    "attempt_id",
    "task_id",
    "integration",
    "request_id",
    "idempotency_key",
    "status",
    "error_code",
    "retry_after_seconds",
    "response_payload",
    "created_at",
    "updated_at"
  ],
  calendar_confirmations: [
    "confirmation_id",
    "task_id",
    "request_id",
    "provider_event_id",
    "source",
    "payload",
    "created_at"
  ],
  audit_trail: ["audit_id", "request_id", "event_id", "task_id", "integration", "level", "message", "metadata", "created_at"]
}

async function main() {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "meitheal-schema-drift-"))
  const dbPath = path.join(workDir, "tasks.db")
  const markerPath = path.join(workDir, "meitheal-board-grants.json")
  const dbUrl = `file:${dbPath}`
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const appRoot = path.resolve(scriptDir, "..")
  const failures = []

  try {
    await execFileAsync(process.execPath, ["./scripts/migrate.mjs"], {
      cwd: appRoot,
      env: {
        ...process.env,
        MEITHEAL_DB_URL: dbUrl,
        MEITHEAL_BOARD_GRANT_PATH: markerPath,
      }
    })

    const client = await openDatabaseForStartup(dbUrl, { readOnly: true, markerPath })
    try {
      const tx = await client.transaction("read")
      try {
        await validateStartupTaskSchema(tx)
        for (const [tableName, requiredColumns] of Object.entries(expectedSchema)) {
          const tableResult = await tx.execute({
            sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
            args: [tableName],
          })

          if (tableResult.rows.length === 0) {
            failures.push(`Missing table: ${tableName}`)
            continue
          }

          const columns = await tx.execute(`PRAGMA table_info(${tableName})`)
          const actual = new Set(columns.rows.map(row => String(row.name)))

          for (const column of requiredColumns) {
            if (!actual.has(column)) failures.push(`Missing column: ${tableName}.${column}`)
          }
        }
      } finally {
        tx.close()
      }
    } finally {
      client.close()
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    process.exitCode = 1
    return
  }

  console.log("Schema drift check passed.")
}

await main()
