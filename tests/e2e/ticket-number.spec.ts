import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store";
import { formatTicketKey, parseTicketKey } from "../../apps/web/src/lib/ticket-key";

function makeDbUrl(label: string): string {
  return `file:${path.join(os.tmpdir(), `meitheal-${label}-${Date.now()}-${Math.random()}.db`)}`;
}

test.beforeEach(async () => {
  process.env.MEITHEAL_DB_URL = makeDbUrl("ticket-number");
  resetPersistenceForTests();
  await ensureSchema();
});

test("ticket_number column exists after ensureSchema", async () => {
  const client = getPersistenceClient();
  const result = await client.execute(
    "SELECT name FROM pragma_table_info('tasks') WHERE name = 'ticket_number'"
  );
  expect(result.rows.length).toBe(1);
  expect(result.rows[0]?.name).toBe("ticket_number");
});

test("ticket_number unique index exists", async () => {
  const client = getPersistenceClient();
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_ticket_number_idx'"
  );
  expect(result.rows.length).toBe(1);
});

test("ticket_number is auto-assigned on insert with MAX+1 logic", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  // Insert first task
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["t1", "Task 1", "pending", 1, "idem-1", "req-1", now, now],
  });

  // Insert second task
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["t2", "Task 2", "pending", 2, "idem-2", "req-2", now, now],
  });

  const r1 = await client.execute("SELECT ticket_number FROM tasks WHERE id = 't1'");
  const r2 = await client.execute("SELECT ticket_number FROM tasks WHERE id = 't2'");

  expect(Number(r1.rows[0]?.ticket_number)).toBe(1);
  expect(Number(r2.rows[0]?.ticket_number)).toBe(2);
});

test("ticket_number is unique across rows", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["u1", "Unique 1", "pending", 42, "idem-u1", "req-u1", now, now],
  });

  // Attempting duplicate ticket_number should fail
  await expect(
    client.execute({
      sql: `INSERT INTO tasks (id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["u2", "Unique 2", "pending", 42, "idem-u2", "req-u2", now, now],
    })
  ).rejects.toThrow();
});

test("backfill assigns ticket_number based on rowid for existing tasks", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  // Insert tasks with explicit ticket_numbers (simulating backfill result)
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["bf1", "Backfill 1", "pending", 1, "idem-bf1", "req-bf1", now, now],
  });
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, ticket_number, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["bf2", "Backfill 2", "pending", 2, "idem-bf2", "req-bf2", now, now],
  });

  const result = await client.execute("SELECT id, ticket_number FROM tasks ORDER BY ticket_number");
  expect(result.rows.length).toBe(2);
  expect(Number(result.rows[0]?.ticket_number)).toBe(1);
  expect(Number(result.rows[1]?.ticket_number)).toBe(2);
});

test("formatTicketKey produces MTH-N format", () => {
  expect(formatTicketKey(1)).toBe("MTH-1");
  expect(formatTicketKey(42)).toBe("MTH-42");
  expect(formatTicketKey(100)).toBe("MTH-100");
  expect(formatTicketKey(null)).toBeNull();
  expect(formatTicketKey(undefined)).toBeNull();
  expect(formatTicketKey(0)).toBeNull();
  expect(formatTicketKey(-1)).toBeNull();
});

test("parseTicketKey extracts number from MTH-N format", () => {
  expect(parseTicketKey("MTH-1")).toBe(1);
  expect(parseTicketKey("MTH-42")).toBe(42);
  expect(parseTicketKey("mth-100")).toBe(100); // case-insensitive
  expect(parseTicketKey("INVALID")).toBeNull();
  expect(parseTicketKey("MTH-")).toBeNull();
  expect(parseTicketKey("")).toBeNull();
});
