import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

import {
  ensureSchema,
  getPersistenceClient,
  getSchemaVersion,
  resetPersistenceForTests,
} from "../../apps/web/src/domains/tasks/persistence/store"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))

function migrate(...args: string[]) {
  return execFileSync(process.execPath, ["scripts/migrate.mjs", ...args], {
    cwd: web, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  })
}

test("CLI and runtime reconcile draft storage around an existing ordinary task", async () => {
  const original = process.env.MEITHEAL_DB_URL
  const dir = await mkdtemp(join(tmpdir(), "meitheal-drafts-schema-"))
  process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
  resetPersistenceForTests()
  try {
    expect(migrate()).toContain("Applied migration: 0006_task_drafts.mjs")
    expect(migrate("--check")).toContain("Migration check passed")
    await ensureSchema()
    expect(getSchemaVersion()).toBe(15)

    const initial = getPersistenceClient()
    await initial.batch([
      "INSERT INTO tasks (id, title, status, request_id, idempotency_key, created_at, updated_at) VALUES ('ordinary', 'Ordinary task', 'pending', 'ordinary', 'ordinary', 1, 1)",
      "DROP TABLE task_draft_receipts",
      "DROP TABLE task_drafts",
      "DELETE FROM __meitheal_migrations WHERE name = '0006_task_drafts.mjs'",
      "UPDATE app_settings SET value = '14' WHERE key = 'schema_version'",
    ], "write")
    initial.close()
    resetPersistenceForTests()

    await ensureSchema()
    const upgraded = getPersistenceClient()
    expect(getSchemaVersion()).toBe(15)
    expect(() => migrate("--check")).toThrow(/Pending migrations: 0006_task_drafts.mjs/)
    expect(migrate()).toContain("Applied migration: 0006_task_drafts.mjs")
    expect(migrate("--check")).toContain("Migration check passed")
    expect((await upgraded.execute("SELECT title FROM tasks WHERE id = 'ordinary'")).rows).toEqual([{ title: "Ordinary task" }])

    await upgraded.batch([
      "INSERT INTO task_draft_receipts (owner_id, draft_id, revision, attempt_id, request_digest, task_id, event_id, published_at) VALUES ('owner-a', 'draft-a', 1, 'attempt-a', 'digest-a', 'ordinary', 'event-a', 50)",
      "INSERT INTO task_draft_receipts (owner_id, draft_id, revision, attempt_id, request_digest, task_id, event_id, published_at) VALUES ('owner-a', 'draft-b', 1, 'attempt-b', 'digest-b', 'other', 'event-b', 50)",
      "DELETE FROM tasks WHERE id = 'ordinary'",
    ], "write")
    const receipts = await upgraded.execute("SELECT task_id FROM task_draft_receipts WHERE owner_id = 'owner-a' ORDER BY published_seq DESC")
    expect(receipts.rows).toEqual([{ task_id: "other" }, { task_id: "ordinary" }])
  } finally {
    const db = getPersistenceClient()
    if (!db.closed) db.close()
    resetPersistenceForTests()
    if (original === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = original
    await rm(dir, { recursive: true, force: true })
  }
})
