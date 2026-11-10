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
  process.env.MEITHEAL_DB_URL = makeDbUrl("task-type");
  resetPersistenceForTests();
  await ensureSchema();
});

test("task_type column defaults to 'task' for existing rows", async () => {
  const client = getPersistenceClient();
  // Insert a row without specifying task_type
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: ["test-1", "Test Task", "pending", "idem-1", "req-1", Date.now(), Date.now()],
  });

  const result = await client.execute({
    sql: "SELECT task_type FROM tasks WHERE id = ?",
    args: ["test-1"],
  });

  expect(result.rows[0]?.task_type).toBe("task");
});

test("task_type can be set to 'epic' on insert", async () => {
  const client = getPersistenceClient();
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["epic-1", "My Epic", "pending", "epic", "idem-e1", "req-e1", Date.now(), Date.now()],
  });

  const result = await client.execute({
    sql: "SELECT task_type FROM tasks WHERE id = ?",
    args: ["epic-1"],
  });

  expect(result.rows[0]?.task_type).toBe("epic");
});

test("task_type can be set to 'story' on insert", async () => {
  const client = getPersistenceClient();
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["story-1", "My Story", "active", "story", "idem-s1", "req-s1", Date.now(), Date.now()],
  });

  const result = await client.execute({
    sql: "SELECT task_type FROM tasks WHERE id = ?",
    args: ["story-1"],
  });

  expect(result.rows[0]?.task_type).toBe("story");
});

test("task_type index exists on tasks table", async () => {
  const client = getPersistenceClient();
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_task_type_idx'",
  );

  expect(result.rows.length).toBe(1);
  expect(result.rows[0]?.name).toBe("tasks_task_type_idx");
});

test("epic → story → task hierarchy via parent_id", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  // Create epic
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["epic-h1", "Feature Epic", "pending", "epic", "idem-h1", "req-h1", now, now],
  });

  // Create story under epic
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["story-h1", "User Story", "active", "story", "epic-h1", "idem-h2", "req-h2", now, now],
  });

  // Create task under story
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["task-h1", "Implementation Task", "pending", "task", "story-h1", "idem-h3", "req-h3", now, now],
  });

  // Verify hierarchy
  const epicResult = await client.execute({
    sql: "SELECT id, task_type, parent_id FROM tasks WHERE id = ?",
    args: ["epic-h1"],
  });
  expect(epicResult.rows[0]?.task_type).toBe("epic");
  expect(epicResult.rows[0]?.parent_id).toBeNull();

  const storyResult = await client.execute({
    sql: "SELECT id, task_type, parent_id FROM tasks WHERE id = ?",
    args: ["story-h1"],
  });
  expect(storyResult.rows[0]?.task_type).toBe("story");
  expect(storyResult.rows[0]?.parent_id).toBe("epic-h1");

  const taskResult = await client.execute({
    sql: "SELECT id, task_type, parent_id FROM tasks WHERE id = ?",
    args: ["task-h1"],
  });
  expect(taskResult.rows[0]?.task_type).toBe("task");
  expect(taskResult.rows[0]?.parent_id).toBe("story-h1");
});

test("task_type filter query works", async () => {
  const client = getPersistenceClient();
  const now = Date.now();

  // Insert one of each type
  for (const type of ["epic", "story", "task"]) {
    await client.execute({
      sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [`filter-${type}`, `${type} item`, "pending", type, `idem-f-${type}`, `req-f-${type}`, now, now],
    });
  }

  // Query for only epics
  const epics = await client.execute({
    sql: "SELECT id, task_type FROM tasks WHERE task_type = ?",
    args: ["epic"],
  });
  expect(epics.rows.length).toBe(1);
  expect(epics.rows[0]?.task_type).toBe("epic");

  // Query for only stories
  const stories = await client.execute({
    sql: "SELECT id, task_type FROM tasks WHERE task_type = ?",
    args: ["story"],
  });
  expect(stories.rows.length).toBe(1);

  // Query all three
  const all = await client.execute("SELECT id FROM tasks");
  expect(all.rows.length).toBe(3);
});
