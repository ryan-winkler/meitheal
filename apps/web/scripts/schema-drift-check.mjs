import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient } from "@libsql/client";

const execFileAsync = promisify(execFile);

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
    "updated_at"
  ],
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
};

async function main() {
  const dbPath = path.join(os.tmpdir(), `meitheal-schema-drift-${Date.now()}-${Math.random()}.db`);
  const dbUrl = `file:${dbPath}`;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(scriptDir, "..");

  await execFileAsync("node", ["./scripts/migrate.mjs"], {
    cwd: appRoot,
    env: {
      ...process.env,
      MEITHEAL_DB_URL: dbUrl
    }
  });

  const client = createClient({ url: dbUrl });
  const failures = [];

  try {
    for (const [tableName, requiredColumns] of Object.entries(expectedSchema)) {
      const tableResult = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        args: [tableName]
      });

      if (tableResult.rows.length === 0) {
        failures.push(`Missing table: ${tableName}`);
        continue;
      }

      const columns = await client.execute(`PRAGMA table_info(${tableName})`);
      const actual = new Set(columns.rows.map((row) => String((row ?? {}).name)));

      for (const column of requiredColumns) {
        if (!actual.has(column)) {
          failures.push(`Missing column: ${tableName}.${column}`);
        }
      }
    }
  } finally {
    await client.close();
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exit(1);
  }

  console.log("Schema drift check passed.");
}

await main();
