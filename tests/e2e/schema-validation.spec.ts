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
  process.env.MEITHEAL_DB_URL = makeDbUrl("schema-validation")
  resetPersistenceForTests()
  await ensureSchema()
})

// --- Table Existence ---

test("areas table exists after ensureSchema", async () => {
  const client = getPersistenceClient()
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='areas'"
  )
  expect(result.rows.length).toBe(1)
})

test("goals table exists after ensureSchema", async () => {
  const client = getPersistenceClient()
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='goals'"
  )
  expect(result.rows.length).toBe(1)
})

test("projects table exists after ensureSchema", async () => {
  const client = getPersistenceClient()
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'"
  )
  expect(result.rows.length).toBe(1)
})

// --- Default Area ---

test("default 'Uncategorized' area is auto-created", async () => {
  const client = getPersistenceClient()
  const result = await client.execute("SELECT id, name FROM areas WHERE id = 'uncategorized'")
  expect(result.rows.length).toBe(1)
  expect(result.rows[0]?.name).toBe("Uncategorized")
})

// --- Task Columns ---

test("tasks table has task_kind column", async () => {
  const client = getPersistenceClient()
  const info = await client.execute("PRAGMA table_info(tasks)")
  const cols = info.rows.map(r => String((r as Record<string, unknown>).name))
  expect(cols).toContain("task_kind")
})

test("tasks table has project_id column", async () => {
  const client = getPersistenceClient()
  const info = await client.execute("PRAGMA table_info(tasks)")
  const cols = info.rows.map(r => String((r as Record<string, unknown>).name))
  expect(cols).toContain("project_id")
})

test("tasks table has bot orchestration columns", async () => {
  const client = getPersistenceClient()
  const info = await client.execute("PRAGMA table_info(tasks)")
  const cols = info.rows.map(r => String((r as Record<string, unknown>).name))
  expect(cols).toContain("owner")
  expect(cols).toContain("lock_holder")
  expect(cols).toContain("lock_expires_at")
  expect(cols).toContain("handoff_state")
  expect(cols).toContain("proposal_json")
  expect(cols).toContain("proposal_hash")
  expect(cols).toContain("agent_scratchpad")
})

// --- Domain Events ---

test("domain_events table has entity_type column", async () => {
  const client = getPersistenceClient()
  const info = await client.execute("PRAGMA table_info(domain_events)")
  const cols = info.rows.map(r => String((r as Record<string, unknown>).name))
  expect(cols).toContain("entity_type")
})

// --- Task Templates (Routine Rename) ---

test("task_templates table has is_routine column", async () => {
  const client = getPersistenceClient()
  const info = await client.execute("PRAGMA table_info(task_templates)")
  const cols = info.rows.map(r => String((r as Record<string, unknown>).name))
  expect(cols).toContain("is_routine")
})

test("task_templates table has cadence column", async () => {
  const client = getPersistenceClient()
  const info = await client.execute("PRAGMA table_info(task_templates)")
  const cols = info.rows.map(r => String((r as Record<string, unknown>).name))
  expect(cols).toContain("cadence")
})

test("task_templates table has streak columns", async () => {
  const client = getPersistenceClient()
  const info = await client.execute("PRAGMA table_info(task_templates)")
  const cols = info.rows.map(r => String((r as Record<string, unknown>).name))
  expect(cols).toContain("streak_current")
  expect(cols).toContain("streak_best")
})

// --- Key Indexes ---

test("tasks_task_kind_idx index exists", async () => {
  const client = getPersistenceClient()
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_task_kind_idx'"
  )
  expect(result.rows.length).toBe(1)
})

test("tasks_project_id_idx index exists", async () => {
  const client = getPersistenceClient()
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_project_id_idx'"
  )
  expect(result.rows.length).toBe(1)
})

test("tasks_handoff_state_idx index exists", async () => {
  const client = getPersistenceClient()
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='tasks_handoff_state_idx'"
  )
  expect(result.rows.length).toBe(1)
})

// --- Schema Idempotency ---

test("ensureSchema is idempotent (can run twice without error)", async () => {
  resetPersistenceForTests()
  await ensureSchema()
  // Second call should not throw
  const client = getPersistenceClient()
  const result = await client.execute("SELECT COUNT(*) as cnt FROM areas")
  // Should still have exactly 1 default area (not duplicated)
  expect(Number(result.rows[0]?.cnt)).toBe(1)
})
