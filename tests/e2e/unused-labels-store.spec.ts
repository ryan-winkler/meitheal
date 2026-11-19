import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { createLabel, updateLabel, UnusedLabelRepository, type CleanupLabel } from "../../apps/web/src/domains/labels"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { POST as cleanupPost } from "../../apps/web/src/pages/api/labels/cleanup"

type Database = ReturnType<typeof getPersistenceClient>
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { registerVerifiedPrincipal, type BoardScope } from "../../apps/web/src/domains/tasks/board-scope"

const test = base.extend<{ db: Database; scope: BoardScope; cleanup: UnusedLabelRepository }>({
  scope: async ({ db }, use) => {
    const principal = registerVerifiedPrincipal({ kind: "ha_user", id: "owner-a" }, { administrator: true, expiresAt: Date.now() + 60_000 })
    const access = await new BoardAccessService(db).resolve(principal, "household", { resource: "board", action: "manage" })
    if (!access.ok) throw new Error(access.errorCode)
    await use(access.scope)
  },
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const work = await mkdtemp(join(tmpdir(), "meitheal-unused-labels-"))
    process.env.MEITHEAL_DB_URL = `file:${join(work, "labels.db")}`
    resetPersistenceForTests()
    try {
      await ensureSchema()
      await use(getPersistenceClient())
    } finally {
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(work, { recursive: true, force: true })
    }
  },
  cleanup: async ({ db, scope }, use) => { await use(new UnusedLabelRepository(db, scope)) },
})

async function seedTask(db: Database, id: string, labels: unknown, status = "pending", area = "default") {
  await db.execute({
    sql: `INSERT INTO tasks (id,title,request_id,idempotency_key,status,area_id,labels,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [id, id, id, id, status, area, typeof labels === "string" ? labels : JSON.stringify(labels), Date.now(), Date.now()],
  })
}

async function candidates(cleanup: UnusedLabelRepository) {
  const result = await cleanup.preview(null)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("Preview was blocked")
  return result
}

async function definitions(db: Database) {
  return (await db.execute("SELECT id,title FROM vikunja_labels ORDER BY id")).rows
}

test("a cancelled streamed body returns cancelled before any repository work", async ({ db }) => {
  test.skip(Boolean(process.env.SUPERVISOR_TOKEN), "Direct parser check uses the standalone administrator boundary")
  const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
  const url = new URL("http://localhost/api/labels/cleanup")
  const principal = await runWithIngressTransport(transport, () => verifiedBoardRequestPrincipal({ request: new Request(url), locals: {} as App.Locals }))
  if (principal?.kind !== "local_operator") throw new Error("Local operator fixture was not admitted")
  const before = await definitions(db)
  let markWaiting = () => {}
  const waiting = new Promise<void>(resolve => { markWaiting = resolve })
  let first = true
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (first) {
        first = false
        controller.enqueue(new TextEncoder().encode("{"))
      } else {
        markWaiting()
        return new Promise<void>(() => {})
      }
    },
  })
  const cancellation = new AbortController()
  const request = new Request(url, {
    method: "POST", body, duplex: "half", signal: cancellation.signal,
    headers: { "content-type": "application/json", origin: "http://localhost", referer: "http://localhost/settings",
      "sec-fetch-site": "same-origin", "sec-fetch-mode": "same-origin", "x-meitheal-board-id": "household",
      "x-meitheal-board-session": boardSessionProof(principal.id) },
  } as RequestInit)
  const context = { request, url, locals: {}, params: {} } as Parameters<typeof cleanupPost>[0]
  const response = Promise.resolve(runWithIngressTransport(transport, () => cleanupPost(context)))
  const enteredReader = await Promise.race([waiting.then(() => true), response.then(() => false)])
  expect(enteredReader).toBe(true)
  cancellation.abort()
  const result = await response
  expect(result.status).toBe(499)
  expect(await result.json()).toMatchObject({ ok: false, errorCode: "cancelled" })
  expect(await definitions(db)).toEqual(before)
})

test("preserves JSON, junction and legacy object usage across Areas and lifecycle states", async ({ db, scope, cleanup }) => {
  for (const title of ["Roof", "Garden", "Archive", "Deferred", "Legacy", "Unused"]) await createLabel(scope, title)
  await seedTask(db, "roof", ["Roof"])
  await seedTask(db, "garden", ["Garden"], "pending", "other-area")
  await seedTask(db, "archive", ["Archive"], "archived")
  await seedTask(db, "deferred", ["Deferred"])
  await db.execute("UPDATE tasks SET deferred_at = 1 WHERE id = 'deferred'")
  await seedTask(db, "object", [{ name: "Legacy", color: "#abcdef" }], "complete")
  const linked = await createLabel(scope, "Junction")
  await db.execute({ sql: "INSERT INTO vikunja_task_labels (task_id,label_id,created_at) VALUES ('old-missing-task',?,1)", args: [linked.id] })
  const before = (await db.execute("SELECT id,labels,updated_at FROM tasks ORDER BY id")).rows
  const preview = await candidates(cleanup)
  expect(preview.labels.map(label => label.title)).toEqual(["Unused"])
  expect(await cleanup.remove(preview.labels)).toEqual({ ok: true, removed: [preview.labels[0]!.id] })
  expect((await db.execute("SELECT id,labels,updated_at FROM tasks ORDER BY id")).rows).toEqual(before)
  expect((await definitions(db)).map(row => row.title)).toEqual(["Roof", "Garden", "Archive", "Deferred", "Legacy", "Junction"])
})

test("retains every definition matching Unicode case, canonical accents and whitespace", async ({ db, scope, cleanup }) => {
  await createLabel(scope, "Bríd")
  await createLabel(scope, "BRÍD")
  await createLabel(scope, "حديقة المنزل")
  await seedTask(db, "unicode", ["  BRI\u0301D  ", { name: "حديقة المنزل" }])
  expect((await candidates(cleanup)).labels).toEqual([])
})

test("treats JavaScript whitespace-only task selections as empty without rewriting them", async ({ db, scope, cleanup }) => {
  await createLabel(scope, "Unused")
  const values = ["", "   ", "\t\r\n", "\u00a0", "\ufeff\u2028"]
  for (const [index, value] of values.entries()) {
    await seedTask(db, "empty-" + index, [])
    await db.execute({ sql: "UPDATE tasks SET labels=? WHERE id=?", args: [value, "empty-" + index] })
  }
  const before = (await db.execute("SELECT id,labels FROM tasks ORDER BY id")).rows
  const selected = (await candidates(cleanup)).labels
  expect(selected.map(label => label.title)).toEqual(["Unused"])
  expect((await cleanup.remove(selected)).ok).toBe(true)
  expect((await db.execute("SELECT id,labels FROM tasks ORDER BY id")).rows).toEqual(before)
})

test("retains nullable legacy task storage while removing an unused definition", async ({ db, scope, cleanup }) => {
  // Reproduce a predecessor's nullable column in this owned synthetic store.
  await db.batch(["ALTER TABLE tasks DROP COLUMN labels", "ALTER TABLE tasks ADD COLUMN labels TEXT"], "write")
  const label = await createLabel(scope, "Unused")
  await seedTask(db, "legacy", [])
  await db.execute("UPDATE tasks SET labels=NULL WHERE id='legacy'")
  const selected = (await candidates(cleanup)).labels
  expect(selected.map(candidate => candidate.title)).toEqual(["Unused"])
  expect(await cleanup.remove(selected)).toEqual({ ok: true, removed: [label.id] })
  expect((await db.execute("SELECT labels FROM tasks")).rows[0]?.labels).toBeNull()
})

for (const [table, json] of [
  ["task_drafts", '{"version":1,"labels":[],"labels":["Roof"],"newLabels":[]}'],
  ["task_drafts", '{"version":1,"labels":["Roof"],"labels":[],"newLabels":[]}'],
  ["task_drafts", '{"version":1,"labels":[],"newLabels":[],"newLabels":["Roof"]}'],
  ["task_drafts", '{"version":1,"labels":[],"newLabels":["Roof"],"newLabels":[]}'],
  ["task_drafts", '{"version":1,"version":2,"labels":[],"newLabels":[]}'],
  ["task_drafts", '{"version":2,"version":1,"labels":[],"newLabels":[]}'],
  ["task_templates", '{"labels":[],"labels":["Roof"]}'],
  ["task_templates", '{"labels":["Roof"],"labels":[]}'],
  ["task_templates", '{"labels":[],"\\u006cabels":["Roof"]}'],
  ["task_templates", '{"labels\\u0000junk":[],"labels":["Roof"]}'],
  ["task_templates", '{"labels":["Roof"],"labels\\u0000junk":[]}'],
  ["task_drafts", '{"version":1,"labels\\u0000junk":[],"labels":["Roof"],"newLabels":[]}'],
  ["task_drafts", '{"version":1,"labels":["Roof"],"labels\\u0000junk":[],"newLabels":[]}'],
] as const) {
  test("blocks ambiguous duplicate fields in " + table + ": " + json, async ({ db, scope, cleanup }) => {
    await createLabel(scope, "Roof")
    const selected = (await candidates(cleanup)).labels
    if (table === "task_drafts") {
      await db.execute({ sql: `INSERT INTO task_drafts (owner_id,board_id,draft_id,revision,snapshot_json,save_attempt_id,save_digest,updated_at)
        VALUES ('owner-a','household','draft',1,?,'attempt','digest',1)`, args: [json] })
    } else {
      await db.execute({ sql: "INSERT INTO task_templates (id,name,template_json,created_at,updated_at) VALUES ('template','template',?,1,1)", args: [json] })
    }
    expect(await cleanup.preview(null)).toEqual({ ok: false, errorCode: "blocked" })
    expect(await cleanup.remove(selected)).toEqual({ ok: false, errorCode: "blocked" })
    expect(await definitions(db)).toHaveLength(1)
  })
}

test("retains private draft selections and templates without returning their payloads", async ({ db, scope, cleanup }) => {
  for (const title of ["Draft", "New draft", "Template", "Unused"]) await createLabel(scope, title)
  const snapshot = JSON.stringify({ version: 1, labels: ["Draft"], newLabels: ["New draft"], description: "Private capture ".repeat(10_000) })
  await db.execute({
    sql: `INSERT INTO task_drafts (owner_id,board_id,draft_id,revision,snapshot_json,save_attempt_id,save_digest,updated_at)
      VALUES ('owner-a','household','private-draft',1,?,'attempt','digest',1)`,
    args: [snapshot],
  })
  await db.execute({
    sql: "INSERT INTO task_templates (id,name,template_json,created_at,updated_at) VALUES ('template','template',?,1,1)",
    args: [JSON.stringify({ labels: ["Template"], description: "Long template ".repeat(10_000) })],
  })
  await db.execute("INSERT INTO task_templates (id,name,created_at,updated_at) VALUES ('empty','empty',1,1)")
  const result = await candidates(cleanup)
  expect(result.labels.map(label => label.title)).toEqual(["Unused"])
  expect(JSON.stringify(result)).not.toMatch(/owner-a|private-draft|Private capture|Long template/)
  expect((await db.execute("SELECT snapshot_json FROM task_drafts")).rows[0]?.snapshot_json).toBe(snapshot)
})

for (const raw of ['{"name":"Roof"}', '[17]', '[{"name":17}]', 'not-json', JSON.stringify(["x".repeat(65_536)])]) {
  test("blocks deletion for an unrecognized or oversized task selection " + raw.slice(0, 25), async ({ db, scope, cleanup }) => {
    await createLabel(scope, "Unused")
    const selected = (await candidates(cleanup)).labels
    await seedTask(db, "malformed", raw)
    expect(await cleanup.preview(null)).toEqual({ ok: false, errorCode: "blocked" })
    expect(await cleanup.remove(selected)).toEqual({ ok: false, errorCode: "blocked" })
    expect(await definitions(db)).toHaveLength(1)
  })
}

test("rejects unknown draft versions and malformed template envelopes", async ({ db, scope, cleanup }) => {
  await createLabel(scope, "Unused")
  const selected = (await candidates(cleanup)).labels
  await db.execute({
    sql: `INSERT INTO task_drafts (owner_id,board_id,draft_id,revision,snapshot_json,save_attempt_id,save_digest,updated_at)
      VALUES ('owner-a','household','draft',1,?,'attempt','digest',1)`,
    args: [JSON.stringify({ version: 2, labels: [], newLabels: [] })],
  })
  expect(await cleanup.remove(selected)).toEqual({ ok: false, errorCode: "blocked" })
  await db.execute("DELETE FROM task_drafts")
  await db.execute("INSERT INTO task_templates (id,name,template_json,created_at,updated_at) VALUES ('bad','bad','[]',1,1)")
  expect(await cleanup.remove(selected)).toEqual({ ok: false, errorCode: "blocked" })
  expect(await definitions(db)).toHaveLength(1)
})

test("metadata and usage changes invalidate the whole selected batch", async ({ db, scope, cleanup }) => {
  await createLabel(scope, "First")
  const second = await createLabel(scope, "Second")
  const original = (await candidates(cleanup)).labels
  await db.execute({ sql: "UPDATE vikunja_labels SET hex_color='abcdef' WHERE id=?", args: [second.id] })
  expect(await cleanup.remove(original)).toEqual({ ok: false, errorCode: "stale" })
  expect(await definitions(db)).toHaveLength(2)
  const refreshed = (await candidates(cleanup)).labels
  await seedTask(db, "recently-tagged", ["Second"])
  expect(await cleanup.remove(refreshed)).toEqual({ ok: false, errorCode: "stale" })
  expect(await definitions(db)).toHaveLength(2)
})

test("label edits report only committed rows and invalidate cleanup revisions", async ({ db, scope, cleanup }) => {
  const label = await createLabel(scope, "Planned", "#abcdef")
  const selected = (await candidates(cleanup)).labels
  expect(await updateLabel(scope, label.id, { title: "Renamed" })).toMatchObject({ id: label.id, title: "Renamed", hexColor: "#abcdef" })
  expect(await cleanup.remove(selected)).toEqual({ ok: false, errorCode: "stale" })
  await db.execute("CREATE TRIGGER ignore_label_edit BEFORE UPDATE ON vikunja_labels BEGIN SELECT RAISE(IGNORE); END")
  expect(await updateLabel(scope, label.id, { hexColor: "#123456" })).toBeNull()
  expect((await db.execute("SELECT title,hex_color FROM vikunja_labels")).rows[0]).toMatchObject({ title: "Renamed", hex_color: "abcdef" })
  await db.execute("DROP TRIGGER ignore_label_edit")
  expect((await cleanup.remove((await candidates(cleanup)).labels)).ok).toBe(true)
  expect(await updateLabel(scope, label.id, { title: "Too late" })).toBeNull()
})

test("retries, duplicate IDs and partially ignored deletion preserve consistent state", async ({ db, scope, cleanup }) => {
  await createLabel(scope, "First")
  await createLabel(scope, "Second")
  const selected = (await candidates(cleanup)).labels
  expect(await cleanup.remove([selected[0]!, selected[0]!])).toEqual({ ok: false, errorCode: "stale" })
  await db.execute(`CREATE TRIGGER ignore_second_label BEFORE DELETE ON vikunja_labels
    WHEN OLD.id = ${selected[1]!.id} BEGIN SELECT RAISE(IGNORE); END`)
  await expect(cleanup.remove(selected)).rejects.toThrow("incomplete")
  expect(await definitions(db)).toHaveLength(2)
  await db.execute("DROP TRIGGER ignore_second_label")
  expect(await cleanup.remove(selected)).toEqual({ ok: true, removed: selected.map(label => label.id) })
  expect(await cleanup.remove(selected)).toEqual({ ok: false, errorCode: "stale" })
  expect(await definitions(db)).toEqual([])
})

for (const count of [1000, 2000]) {
  test(`bounds previews and selection with ${count} tasks and 1,000 definitions`, async ({ db, scope, cleanup }) => {
    await db.execute(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000)
      INSERT INTO vikunja_labels (id,title,hex_color,board_id) SELECT n,'Label ' || n,'abcdef','household' FROM seq`)
    await db.execute(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<${count})
      INSERT INTO tasks (id,title,request_id,idempotency_key,status,area_id,labels,created_at,updated_at)
      SELECT 'task-' || n,'Task ' || n,'task-' || n,'task-' || n,'pending','default',
        json_array('Label ' || ((n % 500)+1)),1,1 FROM seq`)
    const started = performance.now()
    const all: CleanupLabel[] = []
    let after: number | null = null
    do {
      const result = await cleanup.preview(after)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error("Scale fixture was blocked")
      expect(result.labels.length).toBeLessThanOrEqual(25)
      all.push(...result.labels)
      after = result.nextAfter
    } while (after !== null)
    expect(all.map(label => label.id)).toEqual(Array.from({ length: 500 }, (_, index) => index + 501))
    const previewMs = performance.now() - started
    const deleting = performance.now()
    expect(await cleanup.remove(all.slice(0, 25))).toEqual({ ok: true, removed: all.slice(0, 25).map(label => label.id) })
    expect(await definitions(db)).toHaveLength(975)
    console.log(JSON.stringify({ tasks: count, definitions: 1000, previewRows: 25, unused: all.length,
      allPagesMs: Number(previewMs.toFixed(2)), removeMs: Number((performance.now() - deleting).toFixed(2)) }))
  })
}
