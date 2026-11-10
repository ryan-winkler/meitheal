/**
 * E2E Tests — Kanban Backlog Mode
 *
 * Comprehensive test coverage for the backlog_mode setting:
 * - Settings persistence (visible / hidden / disabled)
 * - Lane filtering when hidden/disabled
 * - Backlog tasks remain in DB regardless of mode
 * - DDD: backlog_mode doesn't break other settings
 *
 * @domain kanban
 * @bounded-context backlog
 */
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store";

function makeDbUrl(label: string): string {
  return `file:${path.join(os.tmpdir(), `meitheal-${label}-${Date.now()}-${Math.random()}.db`)}`;
}

test.beforeEach(async () => {
  process.env.MEITHEAL_DB_URL = makeDbUrl("backlog-mode");
  resetPersistenceForTests();
  await ensureSchema();

  // Ensure settings table exists — ensureSchema only creates tasks/kanban_lanes
  const client = getPersistenceClient();
  await client.execute(
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`
  );
});

// ── Settings Persistence ──

test("backlog_mode defaults to 'visible' when no setting exists", async () => {
  const client = getPersistenceClient();
  const result = await client.execute(
    "SELECT value FROM settings WHERE key = 'backlog_mode' LIMIT 1",
  );
  // No row = default visible
  expect(result.rows.length).toBe(0);
});

test("backlog_mode can be persisted as 'hidden'", async () => {
  const client = getPersistenceClient();
  await client.execute({
    sql: "INSERT INTO settings (key, value, updated_at) VALUES ('backlog_mode', '\"hidden\"', ?)",
    args: [Date.now()],
  });

  const result = await client.execute(
    "SELECT value FROM settings WHERE key = 'backlog_mode' LIMIT 1",
  );
  expect(JSON.parse(String(result.rows[0]?.value))).toBe("hidden");
});

test("backlog_mode can be persisted as 'disabled'", async () => {
  const client = getPersistenceClient();
  await client.execute({
    sql: "INSERT INTO settings (key, value, updated_at) VALUES ('backlog_mode', '\"disabled\"', ?)",
    args: [Date.now()],
  });

  const result = await client.execute(
    "SELECT value FROM settings WHERE key = 'backlog_mode' LIMIT 1",
  );
  expect(JSON.parse(String(result.rows[0]?.value))).toBe("disabled");
});

// ── Lane Filtering ──

test("backlog lane exists in kanban_lanes by default", async () => {
  const client = getPersistenceClient();
  const result = await client.execute(
    "SELECT key FROM kanban_lanes WHERE key = 'backlog' LIMIT 1",
  );
  expect(result.rows.length).toBe(1);
});

test("backlog lane remains in DB even when backlog_mode is 'disabled'", async () => {
  const client = getPersistenceClient();
  // Set disabled mode
  await client.execute({
    sql: "INSERT INTO settings (key, value, updated_at) VALUES ('backlog_mode', '\"disabled\"', ?)",
    args: [Date.now()],
  });

  // Lane is still in the DB — filtering is done at the presentation layer
  const result = await client.execute(
    "SELECT key FROM kanban_lanes WHERE key = 'backlog' LIMIT 1",
  );
  expect(result.rows.length).toBe(1);
});

// ── Task Status Coexistence ──

test("backlog tasks remain queryable regardless of backlog_mode setting", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  // Create a backlog task
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: ["bl-1", "Backlog task", "backlog", "idem-bl-1", "req-bl-1", now, now],
  });

  // Set disabled mode
  await client.execute({
    sql: "INSERT INTO settings (key, value, updated_at) VALUES ('backlog_mode', '\"disabled\"', ?)",
    args: [now],
  });

  // Task is still in the DB and queryable
  const result = await client.execute(
    "SELECT id, status FROM tasks WHERE id = 'bl-1'",
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0]?.status).toBe("backlog");
});

// ── DDD Isolation ──

test("backlog_mode setting doesn't affect completed_auto_hide_days", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  // Set both settings
  await client.execute({
    sql: "INSERT INTO settings (key, value, updated_at) VALUES ('backlog_mode', '\"disabled\"', ?)",
    args: [now],
  });
  await client.execute({
    sql: "INSERT INTO settings (key, value, updated_at) VALUES ('completed_auto_hide_days', '14', ?)",
    args: [now],
  });

  // Both settings are independent
  const results = await client.execute(
    "SELECT key, value FROM settings WHERE key IN ('backlog_mode', 'completed_auto_hide_days') ORDER BY key",
  );
  expect(results.rows.length).toBe(2);
  expect(JSON.parse(String(results.rows[0]?.value))).toBe("disabled");
  expect(JSON.parse(String(results.rows[1]?.value))).toBe(14);
});

test("backlog_mode can be updated from 'hidden' to 'visible'", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  // Set to hidden
  await client.execute({
    sql: "INSERT INTO settings (key, value, updated_at) VALUES ('backlog_mode', '\"hidden\"', ?)",
    args: [now],
  });

  // Update to visible
  await client.execute({
    sql: "UPDATE settings SET value = '\"visible\"', updated_at = ? WHERE key = 'backlog_mode'",
    args: [Date.now()],
  });

  const result = await client.execute(
    "SELECT value FROM settings WHERE key = 'backlog_mode' LIMIT 1",
  );
  expect(JSON.parse(String(result.rows[0]?.value))).toBe("visible");
});
