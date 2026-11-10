import os from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"

function makeDbUrl(label: string): string {
  return `file:${path.join(os.tmpdir(), `meitheal-${label}-${Date.now()}-${Math.random()}.db`)}`
}

test.beforeEach(async () => {
  process.env.MEITHEAL_DB_URL = makeDbUrl("subtask-hierarchy")
  resetPersistenceForTests()
  await ensureSchema()
})

// --- Nesting Validation Tests ---

test("task can be created under an epic (valid nesting)", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  // Create an epic
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["epic-1", "My Epic", "pending", "epic", "idem-1", "req-1", now, now],
  })

  // Create a task under the epic
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["task-1", "Child Task", "pending", "task", "epic-1", "idem-2", "req-2", now, now],
  })

  const result = await client.execute({
    sql: "SELECT parent_id, task_type FROM tasks WHERE id = ?",
    args: ["task-1"],
  })

  expect(result.rows[0]?.parent_id).toBe("epic-1")
  expect(result.rows[0]?.task_type).toBe("task")
})

test("story can be created under an epic (valid nesting)", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["epic-1", "My Epic", "pending", "epic", "idem-1", "req-1", now, now],
  })

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["story-1", "User Story", "pending", "story", "epic-1", "idem-2", "req-2", now, now],
  })

  const result = await client.execute({
    sql: "SELECT parent_id, task_type FROM tasks WHERE id = ?",
    args: ["story-1"],
  })

  expect(result.rows[0]?.parent_id).toBe("epic-1")
  expect(result.rows[0]?.task_type).toBe("story")
})

test("task can have subtasks (task under task)", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["parent-1", "Parent Task", "pending", "task", "idem-1", "req-1", now, now],
  })

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["sub-1", "Subtask", "pending", "task", "parent-1", "idem-2", "req-2", now, now],
  })

  const result = await client.execute({
    sql: "SELECT parent_id FROM tasks WHERE id = ?",
    args: ["sub-1"],
  })
  expect(result.rows[0]?.parent_id).toBe("parent-1")
})

test("parent_id query filter returns only children of a parent", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  // Create parent + 2 children + 1 orphan
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["parent-1", "Parent", "pending", "epic", "idem-1", "req-1", now, now],
  })
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["child-1", "Child 1", "pending", "task", "parent-1", "idem-2", "req-2", now, now],
  })
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["child-2", "Child 2", "complete", "task", "parent-1", "idem-3", "req-3", now, now],
  })
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["orphan-1", "Not a child", "pending", "task", "idem-4", "req-4", now, now],
  })

  // Query children of parent-1
  const result = await client.execute({
    sql: "SELECT id FROM tasks WHERE parent_id = ?",
    args: ["parent-1"],
  })

  expect(result.rows.length).toBe(2)
  const childIds = result.rows.map(r => r.id)
  expect(childIds).toContain("child-1")
  expect(childIds).toContain("child-2")
})

test("subtask completion counts are correct", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_type, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["parent-1", "Parent", "active", "epic", "idem-1", "req-1", now, now],
  })

  // 3 children: 2 complete, 1 pending
  for (const [id, status] of [["c1", "complete"], ["c2", "complete"], ["c3", "pending"]] as const) {
    await client.execute({
      sql: `INSERT INTO tasks (id, title, status, task_type, parent_id, idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, `Child ${id}`, status, "task", "parent-1", `idem-${id}`, `req-${id}`, now, now],
    })
  }

  const totalResult = await client.execute({
    sql: "SELECT COUNT(*) as total FROM tasks WHERE parent_id = ?",
    args: ["parent-1"],
  })
  const doneResult = await client.execute({
    sql: "SELECT COUNT(*) as done FROM tasks WHERE parent_id = ? AND status = 'complete'",
    args: ["parent-1"],
  })

  expect(Number(totalResult.rows[0]?.total)).toBe(3)
  expect(Number(doneResult.rows[0]?.done)).toBe(2)
})

// --- Recurrence Parser Tests ---

test("parseRRule parses FREQ=DAILY correctly", async () => {
  const { parseRRule } = await import("../../apps/web/src/domains/tasks/recurrence")
  const rule = parseRRule("FREQ=DAILY")
  expect(rule).not.toBeNull()
  expect(rule!.freq).toBe("DAILY")
})

test("parseRRule parses FREQ=WEEKLY with BYDAY", async () => {
  const { parseRRule } = await import("../../apps/web/src/domains/tasks/recurrence")
  const rule = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE,FR")
  expect(rule).not.toBeNull()
  expect(rule!.freq).toBe("WEEKLY")
  expect(rule!.byDay).toEqual(["MO", "WE", "FR"])
})

test("getNextOccurrence advances daily by 1 day", async () => {
  const { parseRRule, getNextOccurrence } = await import("../../apps/web/src/domains/tasks/recurrence")
  const rule = parseRRule("FREQ=DAILY")!
  const base = new Date("2026-03-09")
  const next = getNextOccurrence(rule, base)
  expect(next).not.toBeNull()
  expect(next!.toISOString().split("T")[0]).toBe("2026-03-10")
})

test("getNextOccurrence advances weekly by 7 days", async () => {
  const { parseRRule, getNextOccurrence } = await import("../../apps/web/src/domains/tasks/recurrence")
  const rule = parseRRule("FREQ=WEEKLY")!
  const base = new Date("2026-03-09")
  const next = getNextOccurrence(rule, base)
  expect(next).not.toBeNull()
  expect(next!.toISOString().split("T")[0]).toBe("2026-03-16")
})

test("getNextOccurrence advances monthly by 1 month", async () => {
  const { parseRRule, getNextOccurrence } = await import("../../apps/web/src/domains/tasks/recurrence")
  const rule = parseRRule("FREQ=MONTHLY")!
  const base = new Date("2026-03-15T12:00:00Z")
  const next = getNextOccurrence(rule, base)
  expect(next).not.toBeNull()
  // Verify month advanced by 1
  expect(next!.getMonth()).toBe(3) // April = month 3 (0-indexed)
})

test("describeRule produces human-readable text", async () => {
  const { parseRRule, describeRule } = await import("../../apps/web/src/domains/tasks/recurrence")

  expect(describeRule(parseRRule("FREQ=DAILY")!)).toMatch(/every day/i)
  expect(describeRule(parseRRule("FREQ=WEEKLY")!)).toMatch(/every week/i)
  expect(describeRule(parseRRule("FREQ=MONTHLY")!)).toMatch(/every month/i)
})
