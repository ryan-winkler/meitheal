import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"
import { recentActivityPersonKey } from "../../apps/web/src/domains/tasks/persistence/recent-activity"

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
    expect(getSchemaVersion()).toBe(17)

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
    expect(getSchemaVersion()).toBe(17)
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

const blankDraft = {
  version: 1, title: "", description: "", taskKind: "standard_action", status: "pending", priority: 3,
  due: "", labels: [], newLabels: [], assignedTo: "", goal: "", recurrence: "", isRoutine: false,
  checklist: { items: [], input: "" }, shopping: { items: [], input: "", quantity: "1", category: "" },
  event: { start: "", end: "", location: "", allDay: false, calendar: "" }, fields: [],
} satisfies import("../../apps/web/src/lib/task-draft-state").TaskDraftSnapshot

async function withDraftDb(run: (db: ReturnType<typeof getPersistenceClient>) => Promise<void>) {
  const original = process.env.MEITHEAL_DB_URL
  const dir = await mkdtemp(join(tmpdir(), "meitheal-drafts-write-"))
  process.env.MEITHEAL_DB_URL = `file:${join(dir, "tasks.db")}`
  resetPersistenceForTests()
  try {
    migrate()
    await ensureSchema()
    await run(getPersistenceClient())
  } finally {
    getPersistenceClient().close()
    resetPersistenceForTests()
    if (original === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = original
    await rm(dir, { recursive: true, force: true })
  }
}

test("draft writes are private, compare revisions, and resolve a lost save receipt", async () => {
  const { TaskDraftRepository } = await import("../../apps/web/src/domains/tasks/persistence/task-draft-repository")
  await withDraftDb(async db => {
    const drafts = new TaskDraftRepository(db)
    const action = { action: "save", expected: null, attemptId: crypto.randomUUID(),
      snapshot: { ...blankDraft, title: "Unfinished household capture" } } as const
    const first = await drafts.save("owner-a", action)
    expect(first).toMatchObject({ revision: 1, snapshot: { title: "Unfinished household capture" } })
    expect(await drafts.save("owner-a", action)).toEqual(first)
    expect(await drafts.save("owner-a", { ...action, snapshot: { ...blankDraft, title: "Changed input" } })).toBeNull()
    expect(await drafts.save("owner-a", { ...action, attemptId: crypto.randomUUID() })).toBeNull()
    expect(await drafts.read("owner-b", { kind: "save", attemptId: action.attemptId }))
      .toEqual({ draft: null, latestReceipt: null, resolution: { state: "unavailable" } })
    expect((await drafts.read("owner-a", { kind: "save", attemptId: action.attemptId })).resolution).toEqual({ state: "saved" })
    const version = { draftId: first!.draftId, revision: first!.revision }
    expect(await drafts.discard("owner-b", version)).toBe(false)
    expect(await drafts.save("owner-a", { ...action, expected: version, attemptId: crypto.randomUUID() })).toMatchObject({ revision: 2 })
    expect(await drafts.discard("owner-a", version)).toBe(false)
    expect(await drafts.discard("owner-a", { ...version, revision: 2 })).toBe(true)
    const replacement = await drafts.save("owner-a", { ...action, attemptId: crypto.randomUUID() })
    expect(replacement!.draftId).not.toBe(version.draftId)
    expect((await db.execute("SELECT id FROM tasks")).rows).toHaveLength(0)
  })
})

test("draft publication is atomic and replays only the same owner and frozen task", async () => {
  const { TaskDraftRepository } = await import("../../apps/web/src/domains/tasks/persistence/task-draft-repository")
  const { TaskRepository } = await import("../../apps/web/src/domains/tasks/persistence/task-repository")
  const { prepareTaskCreation } = await import("../../apps/web/src/domains/tasks/task-creation-service")
  await withDraftDb(async db => {
    const drafts = new TaskDraftRepository(db)
    const repo = new TaskRepository(db)
    const saved = await drafts.save("owner-a", {
      action: "save", expected: null, attemptId: crypto.randomUUID(), snapshot: { ...blankDraft, title: "Saved copy" },
    })
    const task = {
      title: "Published copy", description: "", task_kind: "standard_action", status: "pending", priority: 3,
      labels: ["new-draft-label"], catalogLabels: [], newLabels: ["new-draft-label"], due_date: null, assigned_to: null, goal_id: null,
    } satisfies import("../../apps/web/src/lib/task-draft-state").TaskDraftPublication
    const action = { action: "publish", expected: { draftId: saved!.draftId, revision: saved!.revision },
      attemptId: crypto.randomUUID(), task } as const
    const prepared = await prepareTaskCreation(repo, { ...task, labels: JSON.stringify(task.labels) })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return

    await db.execute("CREATE TRIGGER refuse_draft_activity BEFORE INSERT ON task_activity_log BEGIN SELECT RAISE(ABORT, 'fixture'); END")
    await expect(drafts.publish("owner-a", action, prepared.task)).rejects.toThrow("fixture")
    expect((await drafts.read("owner-a")).draft).toEqual(saved)
    expect((await db.execute("SELECT id FROM tasks")).rows).toHaveLength(0)
    expect((await db.execute("SELECT id FROM vikunja_labels WHERE title = 'new-draft-label'")).rows).toHaveLength(0)
    await db.execute("DROP TRIGGER refuse_draft_activity")

    const ordinary = await prepareTaskCreation(repo, { title: "Ordinary concurrent task" })
    expect(ordinary.ok).toBe(true)
    if (!ordinary.ok) return
    const [created, ticket] = await Promise.all([
      drafts.publish("owner-a", action, prepared.task), repo.createTask(ordinary.task),
    ])
    expect(created.receipt).toMatchObject({ draftId: saved!.draftId, taskId: prepared.task.id, ticketKey: "MTH-1" })
    expect(ticket).toBe(2)
    expect((await drafts.read("owner-a")).draft).toBeNull()
    expect(await drafts.replay("owner-a", action)).toEqual(created.receipt)
    expect(await drafts.replay("owner-b", action)).toBeNull()
    expect(await drafts.replay("owner-a", { ...action, task: { ...task, title: "Changed input" } })).toBeNull()
    expect((await drafts.publish("owner-a", action, prepared.task)).eventId).toBeNull()
    expect((await db.execute("SELECT event_id, json_extract(payload, '$.ticket_number') AS ticket FROM domain_events")).rows)
      .toEqual([{ event_id: created.eventId, ticket: 1 }])
    expect((await db.execute("SELECT correlation_id, feed_action, feed_person_key FROM task_activity_log")).rows).toEqual([{
      correlation_id: created.eventId, feed_action: "added", feed_person_key: recentActivityPersonKey("owner-a"),
    }])
    expect((await db.execute("SELECT title FROM vikunja_labels WHERE title = 'new-draft-label'")).rows).toHaveLength(1)
    expect((await drafts.abandon("owner-a", { action: "abandon-publish", expected: action.expected, attemptId: action.attemptId })).receipt)
      .toEqual(created.receipt)
    await db.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [prepared.task.id] })
    expect((await drafts.replay("owner-a", action))?.ticketKey).toBeNull()
    expect((await drafts.read("owner-a", { kind: "publish", ...action.expected, attemptId: action.attemptId })).resolution)
      .toMatchObject({ state: "published", receipt: { taskId: prepared.task.id, ticketKey: null } })
  })
})

test("abandon fences a late publication and writer contention keeps the saved revision", async () => {
  const { TaskDraftRepository, isDraftWriterBusy } = await import("../../apps/web/src/domains/tasks/persistence/task-draft-repository")
  const { TaskRepository } = await import("../../apps/web/src/domains/tasks/persistence/task-repository")
  const { prepareTaskCreation } = await import("../../apps/web/src/domains/tasks/task-creation-service")
  await withDraftDb(async db => {
    const drafts = new TaskDraftRepository(db)
    const saved = await drafts.save("owner-a", { action: "save", expected: null, attemptId: crypto.randomUUID(), snapshot: blankDraft })
    const expected = { draftId: saved!.draftId, revision: saved!.revision }
    const task = {
      title: "Late publication", description: "", task_kind: "standard_action", status: "pending", priority: 3,
      labels: [], catalogLabels: [], newLabels: [], due_date: null, assigned_to: null, goal_id: null,
    } satisfies import("../../apps/web/src/lib/task-draft-state").TaskDraftPublication
    const attemptId = crypto.randomUUID()
    const publish = { action: "publish", expected, attemptId, task } as const
    const prepared = await prepareTaskCreation(new TaskRepository(db), { ...task, labels: "[]" })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect((await drafts.read("owner-a", { kind: "publish", ...expected, attemptId })).resolution).toEqual({ state: "open" })

    const lock = await db.transaction("write")
    try {
      const error = await drafts.publish("owner-a", publish, prepared.task).then(() => null, error => error)
      expect(isDraftWriterBusy(error)).toBe(true)
      expect((await drafts.read("owner-a")).draft).toEqual(saved)
    } finally {
      await lock.rollback()
    }
    const abandoned = await drafts.abandon("owner-a", { action: "abandon-publish", expected, attemptId })
    expect(abandoned).toMatchObject({ receipt: null, draft: { revision: 2 } })
    expect(await drafts.publish("owner-a", publish, prepared.task)).toMatchObject({ conflict: true, receipt: null })
    expect(await drafts.publish("owner-a", { ...publish, expected: { ...expected, revision: 2 }, attemptId: crypto.randomUUID() },
      prepared.task)).toMatchObject({ ticketNumber: 1 })
  })
})
