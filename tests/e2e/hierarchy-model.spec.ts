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
  process.env.MEITHEAL_DB_URL = makeDbUrl("hierarchy-model")
  resetPersistenceForTests()
  await ensureSchema()
})

// --- Areas CRUD ---

test("can create an area", async () => {
  const client = getPersistenceClient()
  const now = Date.now()
  await client.execute({
    sql: "INSERT INTO areas (id, name, icon, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: ["health", "Health", "💪", "#10B981", 1, now, now],
  })

  const result = await client.execute("SELECT * FROM areas WHERE id = 'health'")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.name).toBe("Health")
  expect(result.rows[0]?.icon).toBe("💪")
})

// --- Goals CRUD ---

test("can create a goal under an area", async () => {
  const client = getPersistenceClient()
  const now = Date.now()
  await client.execute({
    sql: "INSERT INTO goals (id, area_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    args: ["lose-weight", "uncategorized", "Lose 10kg", "active", now, now],
  })

  const result = await client.execute("SELECT * FROM goals WHERE id = 'lose-weight'")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.title).toBe("Lose 10kg")
  expect(result.rows[0]?.area_id).toBe("uncategorized")
  expect(result.rows[0]?.status).toBe("active")
})

test("goal area_id is set to NULL when area is deleted (ON DELETE SET NULL)", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  // Create a custom area
  await client.execute({
    sql: "INSERT INTO areas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: ["custom-area", "Custom", now, now],
  })

  // Create a goal in the custom area
  await client.execute({
    sql: "INSERT INTO goals (id, area_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    args: ["goal-1", "custom-area", "Test Goal", now, now],
  })

  // Delete the area
  await client.execute("DELETE FROM areas WHERE id = 'custom-area'")

  // Goal should still exist but area_id should be NULL
  const result = await client.execute("SELECT area_id FROM goals WHERE id = 'goal-1'")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.area_id).toBeNull()
})

// --- Projects CRUD ---

test("can create a project under a goal", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  await client.execute({
    sql: "INSERT INTO goals (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: ["goal-1", "Test Goal", now, now],
  })

  await client.execute({
    sql: "INSERT INTO projects (id, goal_id, title, icon, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: ["project-1", "goal-1", "Gym Routine", "🏋️", "#F59E0B", 0, now, now],
  })

  const result = await client.execute("SELECT * FROM projects WHERE id = 'project-1'")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.title).toBe("Gym Routine")
  expect(result.rows[0]?.goal_id).toBe("goal-1")
})

test("project can exist without a goal (goal_id NULL)", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  await client.execute({
    sql: "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: ["standalone-project", "No Goal Project", now, now],
  })

  const result = await client.execute("SELECT goal_id FROM projects WHERE id = 'standalone-project'")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.goal_id).toBeNull()
})

// --- Task ↔ Project Linking ---

test("task can be linked to a project via project_id", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  await client.execute({
    sql: "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: ["project-1", "Test Project", now, now],
  })

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_kind, project_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["task-1", "Buy groceries", "pending", "shopping_item", "project-1", "idem-1", "req-1", now, now],
  })

  const result = await client.execute("SELECT task_kind, project_id FROM tasks WHERE id = 'task-1'")
  expect(result.rows[0]?.task_kind).toBe("shopping_item")
  expect(result.rows[0]?.project_id).toBe("project-1")
})

test("task project_id is nullable (tasks can exist without projects)", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: ["task-orphan", "Standalone Task", "pending", "idem-1", "req-1", now, now],
  })

  const result = await client.execute("SELECT project_id FROM tasks WHERE id = 'task-orphan'")
  expect(result.rows[0]?.project_id).toBeNull()
})

// --- Full Hierarchy Query ---

test("can query full hierarchy: area → goal → project → task", async () => {
  const client = getPersistenceClient()
  const now = Date.now()

  // Full hierarchy
  await client.execute({
    sql: "INSERT INTO areas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    args: ["personal", "Personal", now, now],
  })
  await client.execute({
    sql: "INSERT INTO goals (id, area_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    args: ["get-fit", "personal", "Get Fit", now, now],
  })
  await client.execute({
    sql: "INSERT INTO projects (id, goal_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    args: ["gym", "get-fit", "Gym Plan", now, now],
  })
  await client.execute({
    sql: `INSERT INTO tasks (id, title, status, task_kind, project_id, idempotency_key, request_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["workout-1", "Do 20 pushups", "pending", "standard_action", "gym", "idem-1", "req-1", now, now],
  })

  // Cross-table query: area name → goal title → project title → task title
  const result = await client.execute(`
    SELECT a.name as area_name, g.title as goal_title, p.title as project_title, t.title as task_title
    FROM tasks t
    JOIN projects p ON t.project_id = p.id
    JOIN goals g ON p.goal_id = g.id
    JOIN areas a ON g.area_id = a.id
    WHERE t.id = 'workout-1'
  `)

  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.area_name).toBe("Personal")
  expect(result.rows[0]?.goal_title).toBe("Get Fit")
  expect(result.rows[0]?.project_title).toBe("Gym Plan")
  expect(result.rows[0]?.task_title).toBe("Do 20 pushups")
})
