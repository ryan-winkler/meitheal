import { createRequire } from "node:module"
import { randomBytes, randomUUID } from "node:crypto"
import { execFileSync } from "../helpers/isolated-process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, test as base } from "@playwright/test"
import { createLabel, updateLabel, deleteLabel, LabelMutationRepository, UnusedLabelRepository, getLabelColorMap, resolveLabelColor } from "../../apps/web/src/domains/labels"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { DraftLabelsChangedError, TaskDraftRepository } from "../../apps/web/src/domains/tasks/persistence/task-draft-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { openDatabaseForStartup } from "../../apps/web/scripts/database-client.mjs"
import type { TaskDraftSnapshot, TaskDraftPublication } from "../../apps/web/src/lib/task-draft-state"
import { PUT as editRoute, DELETE as deleteRoute } from "../../apps/web/src/pages/api/labels/[id]"
import { POST as createRoute } from "../../apps/web/src/pages/api/labels"

import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { registerVerifiedPrincipal, type BoardScope } from "../../apps/web/src/domains/tasks/board-scope"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { createAgentToken, ensureAgentTokenSchema } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { hashToken } from "../../packages/domain-auth/src/index"

const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
type LabelContext = Parameters<typeof editRoute>[0]

async function routeSession() {
  return runWithIngressTransport(transport, async () => {
    const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
    if (principal?.kind !== "local_operator") throw new Error("Local operator fixture was not admitted")
    return boardSessionProof(principal.id)
  })
}


const test = base.extend<{ db: ReturnType<typeof getPersistenceClient>; scope: BoardScope; session: string }>({
  session: async ({ db }, use) => {
    await use(await routeSession())
  },
  scope: async ({ db }, use) => {
    const principal = registerVerifiedPrincipal({ kind: "ha_user", id: "owner-a" }, { administrator: true, expiresAt: Date.now() + 60_000 })
    const access = await new BoardAccessService(db).resolve(principal, "household", { resource: "board", action: "manage" })
    if (!access.ok) throw new Error(access.errorCode)
    await use(access.scope)
  },
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const directory = await mkdtemp(join(tmpdir(), "meitheal-label-lifecycle-"))
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    try {
      execFileSync(process.execPath, ["scripts/migrate.mjs"], {
        cwd: fileURLToPath(new URL("../../apps/web/", import.meta.url)), env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      await ensureSchema()
      await use(getPersistenceClient())
    } finally {
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(directory, { recursive: true, force: true })
    }
  },
})

async function task(db: ReturnType<typeof getPersistenceClient>, id: string, labels: unknown) {
  await db.execute({
    sql: "INSERT INTO tasks (id,title,request_id,idempotency_key,status,area_id,labels,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    args: [id, id, id, id, "pending", "default", JSON.stringify(labels), 5000, 6000],
  })
}

const blankDraft: TaskDraftSnapshot = {
  version: 1, title: "Private household capture", description: "Keep this private body unchanged", taskKind: "standard_action",
  status: "pending", priority: 3, due: "", labels: [], newLabels: [], assignedTo: "", goal: "", recurrence: "", isRoutine: false,
  checklist: { items: [], input: "" }, shopping: { items: [], input: "", quantity: "1", category: "" },
  event: { start: "", end: "", location: "", allDay: false, calendar: "" }, fields: [],
}

function databaseSnapshot() {
  const native = new DatabaseSync(process.env.MEITHEAL_DB_URL!.slice(5), { readOnly: true })
  try {
    const tables = native.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    return JSON.stringify(tables.map(({ name }) => {
      const select = native.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`)
      select.setReadBigInts(true)
      return { name, rows: select.all() }
    }), (_, value) => typeof value === "bigint" ? { integer: String(value) } : value)
  } finally { native.close() }
}

async function seedDraft(db: ReturnType<typeof getPersistenceClient>, scope: BoardScope, labels = ["Roof"], newLabels: string[] = []) {
  const repository = new TaskDraftRepository(db, scope)
  const action = { action: "save", expected: null, attemptId: crypto.randomUUID(), snapshot: { ...blankDraft, labels, newLabels } } as const
  const saved = await repository.save("owner-a", action, 6000)
  expect(saved).not.toBeNull()
  return { repository, saved: saved!, action }
}

test("renaming a definition updates current native task selections", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await task(db, "native-rename", ["Roof", "Garden"])
  expect(await updateLabel(scope, label.id, { title: "Loft" })).toMatchObject({ title: "Loft" })
  const row = (await db.execute("SELECT labels,updated_at FROM tasks WHERE id='native-rename'")).rows[0]!
  expect(JSON.parse(String(row.labels))).toEqual(["Loft", "Garden"])
  expect(row.updated_at).toBe(6001)
})

test("deleting the final definition removes native and legacy junction references", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await task(db, "native-delete", ["Roof", "Garden"])
  await db.execute({ sql: "INSERT INTO vikunja_task_labels (task_id,label_id,created_at) VALUES ('native-delete',?,1)", args: [label.id] })
  expect(await deleteLabel(scope, label.id)).toBe(true)
  const row = (await db.execute("SELECT labels FROM tasks WHERE id='native-delete'")).rows[0]!
  expect(JSON.parse(String(row.labels))).toEqual(["Garden"])
  expect((await db.execute("SELECT * FROM vikunja_task_labels")).rows).toEqual([])
})

test("Unicode rename preserves unrelated order and legacy properties while merging destination references", async ({ db, scope }) => {
  const label = await createLabel(scope, "Bríd")
  await task(db, "legacy", ["Keep", { name: " BRI\u0301D ", color: "#123456", extra: { retained: true } }, "Loft 🛠", { name: "LOFT 🛠" }, "Keep"])
  expect(await updateLabel(scope, label.id, { title: "Loft 🛠" })).toMatchObject({ title: "Loft 🛠" })
  expect(JSON.parse(String((await db.execute("SELECT labels FROM tasks WHERE id='legacy'")).rows[0]!.labels)))
    .toEqual(["Keep", { name: "Loft 🛠", color: "#123456", extra: { retained: true } }, "Keep"])
})

test("duplicate definitions reject ambiguous rename and retain shared references until the final deletion", async ({ db, scope }) => {
  const first = await createLabel(scope, "Bríd")
  const second = (await db.execute("INSERT INTO vikunja_labels (board_id,title,hex_color) VALUES ('household','BRÍD','abcdef') RETURNING id")).rows[0]!
  await task(db, "shared", [" Bríd ", "Keep"])
  await db.execute({ sql: "INSERT INTO vikunja_task_labels (task_id,label_id,created_at) VALUES ('shared',?,1),('shared',?,1)", args: [first.id, Number(second.id)] })
  const before = databaseSnapshot()
  await expect(updateLabel(scope, first.id, { title: "Roof" })).rejects.toMatchObject({ errorCode: "conflict" })
  expect(databaseSnapshot()).toBe(before)
  expect(await deleteLabel(scope, first.id)).toBe(true)
  expect(JSON.parse(String((await db.execute("SELECT labels FROM tasks WHERE id='shared'")).rows[0]!.labels))).toEqual([" Bríd ", "Keep"])
  expect((await db.execute("SELECT label_id FROM vikunja_task_labels")).rows).toEqual([{ label_id: Number(second.id) }])
  expect(await deleteLabel(scope, Number(second.id))).toBe(true)
  expect(JSON.parse(String((await db.execute("SELECT labels FROM tasks WHERE id='shared'")).rows[0]!.labels))).toEqual(["Keep"])
})

test("destination definition collision leaves every stored row unchanged", async ({ db, scope }) => {
  const first = await createLabel(scope, "Roof")
  await createLabel(scope, "Loft")
  await task(db, "conflict", ["Roof"])
  const before = databaseSnapshot()
  await expect(updateLabel(scope, first.id, { title: " loft " })).rejects.toMatchObject({ errorCode: "conflict" })
  expect(databaseSnapshot()).toBe(before)
})

for (const source of ["tasks", "task_templates"] as const) {
  for (const destination of ["L".repeat(100), "🏡".repeat(50)]) {
    test(`oversized rewritten ${source} selection rolls back before maintenance is poisoned (${Buffer.byteLength(destination)} bytes)`, async ({ db, scope }) => {
      const label = await createLabel(scope, "Roof")
      await task(db, "first-rewrite", ["Roof"])
      const selected = ["Roof", "x".repeat(65524)]
      expect(Buffer.byteLength(JSON.stringify(selected))).toBe(65535)
      if (source === "tasks") await task(db, "large", selected)
      else await new TemplateRepository(db, scope).create({ id: "large", name: "Large selection", templateJson: JSON.stringify({ labels: selected }), icon: "house", position: 0 })
      const before = databaseSnapshot()
      await expect(updateLabel(scope, label.id, { title: destination })).rejects.toMatchObject({ errorCode: "blocked" })
      expect(databaseSnapshot()).toBe(before)
      expect(await updateLabel(scope, label.id, { title: "R" })).toMatchObject({ title: "R" })
      expect(await deleteLabel(scope, label.id)).toBe(true)
      expect((await new UnusedLabelRepository(db, scope).preview(null)).ok).toBe(true)
    })
  }
}

for (const destination of ["L".repeat(100), "🏡".repeat(50)]) {
  test(`a rewritten selection at exactly 64 KiB remains maintainable (${Buffer.byteLength(destination)}-byte name)`, async ({ db, scope }) => {
    const label = await createLabel(scope, "Roof")
    const padding = 65536 - Buffer.byteLength(JSON.stringify([destination, ""]))
    await task(db, "boundary", ["Roof", "x".repeat(padding)])
    expect(await updateLabel(scope, label.id, { title: destination })).toMatchObject({ title: destination })
    const row = (await db.execute("SELECT length(CAST(labels AS BLOB)) AS bytes FROM tasks WHERE id='boundary'")).rows[0]!
    expect(row.bytes).toBe(65536)
    expect(await deleteLabel(scope, label.id)).toBe(true)
    expect((await new UnusedLabelRepository(db, scope).preview(null)).ok).toBe(true)
  })
}

for (const source of ["tasks", "task_templates"] as const) {
  for (const action of ["rename", "delete"] as const) {
    test(`legacy ${source} metadata retains exact numeric values during ${action}`, async ({ db, scope }) => {
      const label = await createLabel(scope, "Roof")
      const kept = '{"name":"Keep","reference":9007199254740993,"large":1e999,"nested":{"precise":0.100000000000000000001,"negativeZero":-0}}'
      const renamed = '{"name":"Roof","count":18446744073709551615,"fraction":0.00000000000000000000000000000000000001}'
      const raw = '[' + renamed + ',' + kept + ',"Roof"]'
      if (source === "tasks") {
        await task(db, "numbers", [])
        await db.execute({ sql: "UPDATE tasks SET labels=? WHERE id='numbers'", args: [raw] })
      } else {
        await new TemplateRepository(db, scope).create({ id: "numbers", name: "Exact metadata", templateJson: "{}", icon: "house", position: 0 })
        await db.execute({ sql: "UPDATE task_templates SET template_json=? WHERE id='numbers'",
          args: ['{"labels":' + raw + ',"outside":9007199254740993}'] })
      }
      if (action === "rename") await updateLabel(scope, label.id, { title: "Loft" })
      else await deleteLabel(scope, label.id)
      const result = source === "tasks"
        ? (await db.execute("SELECT labels AS selection FROM tasks WHERE id='numbers'")).rows[0]!.selection
        : (await db.execute("SELECT json_extract(template_json,'$.labels') AS selection FROM task_templates WHERE id='numbers'")).rows[0]!.selection
      // The old-name duplicates merge into their first position; untouched
      // metadata must retain its JSON number tokens rather than IEEE rounding.
      expect(result).toBe(action === "rename" ? '[' + renamed.replace('"Roof"', '"Loft"') + ',' + kept + ']' : '[' + kept + ']')
      if (source === "task_templates") expect((await db.execute("SELECT template_json FROM task_templates WHERE id='numbers'")).rows[0]!.template_json)
        .toContain('"outside":9007199254740993')
    })
  }
}

test("draft and routine-template references change without disclosing or changing their other content", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await createLabel(scope, "Keep")
  const { repository, saved, action } = await seedDraft(db, scope, ["Roof", "Keep"], ["Roof"])
  const templates = new TemplateRepository(db, scope)
  const template = { title: "Retain routine title", area_id: null, project_id: null, labels: [{ name: "Roof", retained: "metadata" }, "Keep"], custom_fields: { intact: true } }
  await templates.create({ id: "routine", name: "Routine", templateJson: JSON.stringify(template), icon: "house", position: 0, isRoutine: true })
  await db.execute("UPDATE task_templates SET updated_at=6000 WHERE id='routine'")
  const mutator = new LabelMutationRepository(db, scope, () => 6000)
  await mutator.update(label.id, { title: "Loft" })
  const current = (await repository.read("owner-a")).draft!
  expect(current).toMatchObject({ draftId: saved.draftId, revision: 2, updatedAt: 6001, snapshot: { ...saved.snapshot, labels: ["Loft", "Keep"], newLabels: ["Loft"] } })
  expect((await repository.read("owner-a", { kind: "save", attemptId: action.attemptId })).resolution).toEqual({ state: "unavailable" })
  expect(await repository.save("owner-a", { ...action, expected: { draftId: saved.draftId, revision: 1 }, attemptId: crypto.randomUUID() })).toBeNull()
  expect(await repository.discard("owner-a", { draftId: saved.draftId, revision: 1 })).toBe(false)
  const row = (await templates.findById("routine"))!
  expect(JSON.parse(String(row.template_json))).toEqual({ ...template, labels: [{ name: "Loft", retained: "metadata" }, "Keep"] })
  expect(row.updated_at).toBe(6001)
  await templates.instantiateFromTemplate("routine-instance", JSON.parse(String(row.template_json)))
  expect(JSON.parse(String((await db.execute("SELECT labels FROM tasks WHERE id='routine-instance'")).rows[0]!.labels)))
    .toEqual([{ name: "Loft", retained: "metadata" }, "Keep"])
  await mutator.delete(label.id)
  expect((await repository.read("owner-a")).draft).toMatchObject({ revision: 3, snapshot: { labels: ["Keep"], newLabels: [] } })
  expect(JSON.parse(String((await templates.findById("routine"))!.template_json))).toEqual({ ...template, labels: ["Keep"] })
})

test("metadata clocks advance monotonically without resetting task inactivity or human activity", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await task(db, "clock", ["Roof"])
  await seedDraft(db, scope)
  const templates = new TemplateRepository(db, scope)
  await templates.create({ id: "future", name: "Future", templateJson: '{"labels":["Roof"]}', icon: "house", position: 0 })
  await db.execute("UPDATE task_drafts SET updated_at=9000")
  await db.execute("UPDATE task_templates SET updated_at=9000")
  const before = (await db.execute("SELECT inactivity_touched_at,last_activity_spike_at FROM tasks WHERE id='clock'")).rows[0]
  await new LabelMutationRepository(db, scope, () => 100).update(label.id, { title: "Loft" })
  expect((await db.execute("SELECT updated_at,inactivity_touched_at,last_activity_spike_at FROM tasks WHERE id='clock'")).rows[0])
    .toEqual({ updated_at: 6001, ...before })
  expect((await db.execute("SELECT updated_at FROM task_drafts")).rows[0]!.updated_at).toBe(9001)
  expect((await db.execute("SELECT updated_at FROM task_templates")).rows[0]!.updated_at).toBe(9001)
})

for (const [table, column, value] of [
  ["tasks", "labels", "not-json"], ["tasks", "labels", "[17]"], ["tasks", "labels", '[{"name":17}]'],
  ["tasks", "labels", JSON.stringify(["\ud800"])],
  ["tasks", "labels", JSON.stringify(["x".repeat(65537)])],
  ["task_drafts", "snapshot_json", '{"version":1,"labels":[],"labels":["Roof"],"newLabels":[]}'],
  ["task_drafts", "snapshot_json", '{"version":1,"labels\\u0000other":[],"labels":["Roof"],"newLabels":[]}'],
  ["task_drafts", "snapshot_json", '{"version":2,"labels":["Roof"],"newLabels":[]}'],
  ["task_drafts", "snapshot_json", JSON.stringify({ version: 1, labels: ["\ud800"], newLabels: [] })],
  ["task_drafts", "snapshot_json", '{"version":1,"labels":[],"newLabels":["Roof"]}'],
  ["task_templates", "template_json", '{"labels":[],"labels":["Roof"]}'],
  ["task_templates", "template_json", '{"labels\\u0000other":[],"labels":["Roof"]}'],
  ["task_templates", "template_json", '{"labels":[{}]}'],
  ["task_templates", "template_json", JSON.stringify({ labels: ["\udfff"] })],
] as const) {
  test(`malformed ${table}.${column} blocks the whole mutation: ${value.slice(0, 55)}`, async ({ db, scope }) => {
    const label = await createLabel(scope, "Roof")
    await task(db, "first-rewritten-row", ["Roof"])
    if (table === "tasks") await task(db, "malformed", [])
    if (table === "task_drafts") await seedDraft(db, scope)
    if (table === "task_templates") await new TemplateRepository(db, scope).create({ id: "malformed", name: "Keep", templateJson: "{}", icon: "house", position: 0 })
    await db.execute({ sql: `UPDATE ${table} SET ${column}=?${table === "tasks" ? " WHERE id='malformed'" : ""}`, args: [value] })
    const before = databaseSnapshot()
    await expect(updateLabel(scope, label.id, { title: "Loft" })).rejects.toMatchObject({ errorCode: "blocked" })
    expect(databaseSnapshot()).toBe(before)
    await expect(deleteLabel(scope, label.id)).rejects.toMatchObject({ errorCode: "blocked" })
    expect(databaseSnapshot()).toBe(before)
  })
}

for (const [table, column, value] of [
  ["tasks", "updated_at", "-1"], ["tasks", "updated_at", "'not-a-date'"],
  ["tasks", "updated_at", "'1969-12-31T23:59:59Z'"], ["tasks", "updated_at", "'2026-02-30T12:00:00Z'"],
  ["tasks", "updated_at", "CAST('9223372036854775807' AS INTEGER)"],
  ["task_drafts", "revision", "CAST('9223372036854775807' AS INTEGER)"],
  ["task_drafts", "updated_at", "CAST('9223372036854775807' AS INTEGER)"],
  ["task_templates", "updated_at", "CAST('9223372036854775807' AS INTEGER)"],
] as const) {
  test(`invalid affected ${table}.${column} is blocked before native integer decoding: ${value}`, async ({ db, scope }) => {
    const label = await createLabel(scope, "Roof")
    await task(db, "affected", ["Roof"])
    if (table === "task_drafts") await seedDraft(db, scope)
    if (table === "task_templates") await new TemplateRepository(db, scope).create({ id: "affected", name: "Template", templateJson: '{"labels":["Roof"]}', icon: "house", position: 0 })
    await db.execute(`UPDATE ${table} SET ${column}=${value}`)
    const before = databaseSnapshot()
    await expect(updateLabel(scope, label.id, { title: "Loft" })).rejects.toMatchObject({ errorCode: "blocked" })
    expect(databaseSnapshot()).toBe(before)
  })
}

test("unaffected unsafe versions survive the guarded native scan unchanged", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await task(db, "affected", ["Roof"])
  await task(db, "unaffected", ["Keep"])
  await createLabel(scope, "Keep")
  await seedDraft(db, scope, ["Keep"])
  await new TemplateRepository(db, scope).create({ id: "unaffected", name: "Template", templateJson: '{"labels":["Keep"]}', icon: "house", position: 0 })
  await db.execute("UPDATE tasks SET updated_at=CAST('9223372036854775807' AS INTEGER) WHERE id='unaffected'")
  await db.execute("UPDATE task_drafts SET revision=CAST('9223372036854775807' AS INTEGER),updated_at=CAST('9223372036854775807' AS INTEGER)")
  await db.execute("UPDATE task_templates SET updated_at=CAST('9223372036854775807' AS INTEGER)")
  await updateLabel(scope, label.id, { title: "Loft" })
  expect((await db.execute("SELECT CAST(updated_at AS TEXT) AS clock FROM tasks WHERE id='unaffected'")).rows[0]!.clock).toBe("9223372036854775807")
  expect((await db.execute("SELECT CAST(revision AS TEXT) AS revision FROM task_drafts")).rows[0]!.revision).toBe("9223372036854775807")
  expect((await db.execute("SELECT CAST(updated_at AS TEXT) AS clock FROM task_templates")).rows[0]!.clock).toBe("9223372036854775807")
})

test("epoch zero and legacy ISO task versions advance exactly one millisecond", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await task(db, "zero", ["Roof"])
  await task(db, "iso", ["Roof"])
  await db.execute("UPDATE tasks SET updated_at=0 WHERE id='zero'")
  await db.execute("UPDATE tasks SET updated_at='2026-01-02T03:04:05.123Z' WHERE id='iso'")
  await updateLabel(scope, label.id, { title: "Loft" })
  expect((await db.execute("SELECT updated_at FROM tasks WHERE id='zero'")).rows[0]!.updated_at).toBe(1)
  expect((await db.execute("SELECT updated_at FROM tasks WHERE id='iso'")).rows[0]!.updated_at).toBe(Date.parse("2026-01-02T03:04:05.123Z") + 1)
})

test("refused definition and later reference writes roll back all earlier changes", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await task(db, "first", ["Roof"])
  await task(db, "second", ["Roof"])
  await db.execute("CREATE TRIGGER refuse_label_definition BEFORE UPDATE ON vikunja_labels BEGIN SELECT RAISE(IGNORE); END")
  let before = databaseSnapshot()
  expect(await updateLabel(scope, label.id, { title: "Loft" })).toBeNull()
  expect(databaseSnapshot()).toBe(before)
  await db.execute("DROP TRIGGER refuse_label_definition")
  await db.execute("CREATE TRIGGER refuse_second_reference BEFORE UPDATE OF labels ON tasks WHEN OLD.id='second' BEGIN SELECT RAISE(IGNORE); END")
  before = databaseSnapshot()
  await expect(updateLabel(scope, label.id, { title: "Loft" })).rejects.toThrow("did not return")
  expect(databaseSnapshot()).toBe(before)
})

test("partially refused junction deletion rolls back references and definition", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await task(db, "first", ["Roof"])
  await db.execute({ sql: "INSERT INTO vikunja_task_labels (task_id,label_id,created_at) VALUES ('first',?,1),('retained',?,1)", args: [label.id, label.id] })
  await db.execute("CREATE TRIGGER refuse_junction BEFORE DELETE ON vikunja_task_labels WHEN OLD.task_id='retained' BEGIN SELECT RAISE(IGNORE); END")
  const before = databaseSnapshot()
  await expect(deleteLabel(scope, label.id)).rejects.toMatchObject({ errorCode: "blocked" })
  expect(databaseSnapshot()).toBe(before)
})

test("version-only metadata edits remain possible with unrelated malformed selections and invalidate color cache", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof", "#123456")
  expect(await resolveLabelColor("Roof", await getLabelColorMap(scope))).toBe("#123456")
  await task(db, "malformed", [])
  await db.execute("UPDATE tasks SET labels='not-json'")
  expect(await updateLabel(scope, label.id, { title: "Roof", hexColor: "#abcdef" })).toMatchObject({ hexColor: "#abcdef" })
  expect(await resolveLabelColor("Roof", await getLabelColorMap(scope))).toBe("#abcdef")
})

test("keyset pages include late definition collisions and every affected task", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  await db.batch(Array.from({ length: 501 }, (_, i) => ({ sql: "INSERT INTO vikunja_labels (board_id,title,hex_color) VALUES ('household',?,'abcdef')", args: [i === 500 ? "Destination" : `Other ${i}`] })), "write")
  await db.batch(Array.from({ length: 501 }, (_, i) => ({
    sql: "INSERT INTO tasks (id,title,request_id,idempotency_key,status,area_id,labels,created_at,updated_at) VALUES (?,?,?,?,'pending','default','[\"Roof\"]',5000,6000)",
    args: [`paged-${i}`, `Task ${i}`, `request-${i}`, `key-${i}`],
  })), "write")
  await expect(updateLabel(scope, label.id, { title: "Destination" })).rejects.toMatchObject({ errorCode: "conflict" })
  await updateLabel(scope, label.id, { title: "Loft" })
  expect((await db.execute("SELECT count(*) AS count FROM tasks WHERE labels='[\"Loft\"]' AND updated_at=6001")).rows[0]!.count).toBe(501)
})

async function overlapWriters<First, Second>(
  firstClient: ReturnType<typeof getPersistenceClient>,
  first: () => Promise<First>,
  second: () => Promise<Second>,
) {
  // Fence on the first actual SQLite writer, since the operations perform
  // different asynchronous authorization reads before acquiring their locks.
  const original = firstClient.transaction
  let reportWriter!: () => void
  const writerOpened = new Promise<void>(resolve => { reportWriter = resolve })
  firstClient.transaction = async (mode: "read" | "write" | "deferred" = "write") => {
    const tx = await original(mode)
    if (mode === "write") reportWriter()
    return tx
  }
  try {
    const firstResult = first()
    await Promise.race([writerOpened, firstResult.then(() => { throw new Error("First writer did not open") })])
    return await Promise.all([firstResult, second()])
  } finally {
    firstClient.transaction = original
  }
}

for (const renameFirst of [false, true]) {
  test(`real second-connection draft save and rename serialize (${renameFirst ? "rename" : "save"} first)`, async ({ db, scope }) => {
    const label = await createLabel(scope, "Roof")
    const { saved, action } = await seedDraft(db, scope)
    const second = await openDatabaseForStartup(process.env.MEITHEAL_DB_URL!, { markerPath: process.env.MEITHEAL_DB_URL!.slice(5) + ".board-grants.json" })
    try {
      const drafts = new TaskDraftRepository(second, scope)
      const save = () => drafts.save("owner-a", { ...action, expected: { draftId: saved.draftId, revision: 1 }, attemptId: crypto.randomUUID(), snapshot: { ...saved.snapshot, title: "New private title" } })
      const rename = () => new LabelMutationRepository(db, scope).update(label.id, { title: "Loft" })
      if (renameFirst) {
        const [, rejected] = await overlapWriters(db, rename, () => save().catch(error => error))
        expect(rejected).toBeInstanceOf(DraftLabelsChangedError)
      } else {
        await overlapWriters(second, save, rename)
      }
      const current = (await drafts.read("owner-a")).draft!
      expect(current.snapshot.labels).toEqual(["Loft"])
      expect(current.revision).toBe(renameFirst ? 2 : 3)
      expect(current.snapshot.title).toBe(renameFirst ? saved.snapshot.title : "New private title")
    } finally { second.close() }
  })
}

for (const renameFirst of [false, true]) {
  test(`real draft publication and rename serialize (${renameFirst ? "rename" : "publication"} first)`, async ({ db, scope }) => {
    const label = await createLabel(scope, "Roof")
    const { saved } = await seedDraft(db, scope)
    const second = await openDatabaseForStartup(process.env.MEITHEAL_DB_URL!, { markerPath: process.env.MEITHEAL_DB_URL!.slice(5) + ".board-grants.json" })
    try {
      const drafts = new TaskDraftRepository(second, scope)
      const publication: TaskDraftPublication = { title: "Published capture", description: "", task_kind: "standard_action", status: "pending", priority: 3, labels: ["Roof"], catalogLabels: ["Roof"], newLabels: [], due_date: null, assigned_to: null, goal_id: null }
      const prepared = await prepareTaskCreation(new TaskRepository(second, scope), { ...publication, labels: JSON.stringify(publication.labels) })
      expect(prepared.ok).toBe(true)
      if (!prepared.ok) return
      const action = { action: "publish", expected: { draftId: saved.draftId, revision: 1 }, attemptId: crypto.randomUUID(), task: publication } as const
      const publish = () => drafts.publish("owner-a", action, prepared.task)
      const rename = () => new LabelMutationRepository(db, scope).update(label.id, { title: "Loft" })
      if (renameFirst) {
        const [, rejected] = await overlapWriters(db, rename, publish)
        expect(rejected).toMatchObject({ conflict: true, receipt: null })
        expect((await db.execute("SELECT id FROM tasks")).rows).toEqual([])
      } else {
        await overlapWriters(second, publish, rename)
        expect((await db.execute("SELECT labels FROM tasks")).rows).toEqual([{ labels: '["Loft"]' }])
        expect(await drafts.replay("owner-a", action)).toMatchObject({ taskId: prepared.task.id })
      }
    } finally { second.close() }
  })
}

test("cleanup revision fencing and deletion order are preserved through a second connection", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  const second = await openDatabaseForStartup(process.env.MEITHEAL_DB_URL!, { markerPath: process.env.MEITHEAL_DB_URL!.slice(5) + ".board-grants.json" })
  try {
    const cleanup = new UnusedLabelRepository(second, scope)
    const preview = await cleanup.preview(null)
    if (!preview.ok) throw new Error("Preview was blocked")
    await updateLabel(scope, label.id, { title: "Loft" })
    expect(await cleanup.remove(preview.labels)).toEqual({ ok: false, errorCode: "stale" })
    const current = await cleanup.preview(null)
    if (!current.ok) throw new Error("Preview was blocked")
    expect((await cleanup.remove(current.labels)).ok).toBe(true)
    expect(await updateLabel(scope, label.id, { title: "Too late" })).toBeNull()
  } finally { second.close() }
})

function routeRequest(session: string, id: string, method: "POST" | "PUT" | "DELETE", body?: string, headers: Record<string, string> = {}): LabelContext {
  const url = new URL("http://localhost/api/labels" + (id ? "/" + id : ""))
  const request = new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-meitheal-board-id": "household",
      "x-meitheal-board-session": session, ...headers },
    ...(body === undefined ? {} : { body }),
  })
  return { params: id ? { id } : {}, locals: {}, request, url } as unknown as LabelContext
}

function runRoute(route: typeof editRoute, context: LabelContext) {
  return runWithIngressTransport(transport, () => route(context))
}

test("administrator native routes return only committed metadata and private cache headers", async ({ db, scope, session }) => {
  test.skip(Boolean(process.env.SUPERVISOR_TOKEN), "Standalone route boundary; actual HA role proof is separate")
  const label = await createLabel(scope, "Roof")
  await task(db, "route-task", ["Roof"])
  const renamed = await runRoute(editRoute, routeRequest(session, String(label.id), "PUT", '{"title":"Loft"}'))
  expect(renamed.status).toBe(200)
  expect(renamed.headers.get("cache-control")).toBe("private, no-store")
  expect(await renamed.json()).toMatchObject({ id: label.id, title: "Loft", hex_color: "#6b7280" })
  const removed = await runRoute(deleteRoute, routeRequest(session, String(label.id), "DELETE"))
  expect(removed.status).toBe(200)
  expect(await removed.json()).toEqual({ ok: true, deleted: label.id })
  expect((await db.execute("SELECT labels FROM tasks WHERE id='route-task'")).rows).toEqual([{ labels: "[]" }])
})

test("native label create validates the final stripped and trimmed name", async ({ scope, session }) => {
  const send = (title: string) => runRoute(createRoute, routeRequest(session, "", "POST", JSON.stringify({ title })))
  const before = databaseSnapshot()
  expect((await send("<b> </b>")).status).toBe(400)
  expect(databaseSnapshot()).toBe(before)
  const created = await send("<b>  Roof  </b>")
  expect(created.status).toBe(201)
  expect(await created.json()).toMatchObject({ title: "Roof" })
  expect(await updateLabel(scope, 1, { title: "<b>  Loft  </b>" })).toMatchObject({ title: "Loft" })
})

for (const [id, body, contentType, status, errorCode] of [
  ["1.5", '{"title":"Loft"}', "application/json", 400, "invalid"],
  ["9007199254740992", '{"title":"Loft"}', "application/json", 400, "invalid"],
  ["1", '{"title":"Loft"}', "text/plain", 415, "media"],
  ["1", "not-json", "application/json", 400, "invalid"],
  ["1", '{"title":""}', "application/json", 400, "invalid"],
  ["1", '{"title":"<b></b>"}', "application/json", 400, "invalid"],
  ["1", '{"title":"<b> </b>"}', "application/json", 400, "invalid"],
  ["1", JSON.stringify({ title: "\ud800" }), "application/json", 400, "invalid"],
  ["1", JSON.stringify({ title: "x".repeat(101) }), "application/json", 400, "invalid"],
  ["1", '{"hex_color":"invalid"}', "application/json", 400, "invalid"],
  ["1", '{"title":"Loft","other":true}', "application/json", 400, "invalid"],
  ["1", "{}", "application/json", 400, "invalid"],
  ["1", JSON.stringify({ title: "x".repeat(5000) }), "application/json", 413, "tooLarge"],
] as const) {
  test(`native edit rejects ${errorCode}/${status}: ${id} ${body.slice(0, 35)}`, async ({ scope, session }) => {
    test.skip(Boolean(process.env.SUPERVISOR_TOKEN), "Standalone parser boundary")
    await createLabel(scope, "Roof")
    const before = databaseSnapshot()
    const response = await runRoute(editRoute, routeRequest(session, id, "PUT", body, { "content-type": contentType }))
    expect(response.status).toBe(status)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toMatchObject({ ok: false, errorCode })
    expect(databaseSnapshot()).toBe(before)
  })
}

test("members and agent tokens cannot rewrite shared vocabulary", async ({ db, scope }) => {
  const label = await createLabel(scope, "Roof")
  const memberId = "label-member"
  await db.execute({ sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role) VALUES ('household','ha_user',?,'member')",
    args: [memberId] })
  await ensureAgentTokenSchema()
  const token = `mth_${randomBytes(32).toString("hex")}`
  const credentialId = randomUUID()
  await createAgentToken({ id: credentialId, name: "Label fixture", tokenHash: hashToken(token),
    tokenPrefix: token.slice(0, 12), scopes: ["tasks:read", "tasks:write"] }, scope)
  const agentContext = routeRequest("", String(label.id), "PUT", '{"title":"Loft"}', { authorization: `Bearer ${token}` })
  const agent = await resolveAgentAuth(agentContext.request)
  if (!agent) throw new Error("Fixture agent did not authenticate")
  agentContext.locals.agentToken = agent
  await expect.poll(async () => (await db.execute({
    sql: "SELECT last_used_at FROM agent_tokens WHERE id=?", args: [credentialId],
  })).rows[0]?.last_used_at).toEqual(expect.any(String))

  const before = databaseSnapshot()
  const member = await withCoreMember(memberId, async () => {
    const memberContext = routeRequest(boardSessionProof(memberId), String(label.id), "PUT", '{"title":"Loft"}')
    memberContext.locals = { behindIngress: true, hassUserId: memberId } as App.Locals
    const ingress = { peer: "172.30.32.2", fromSupervisor: true, identityHeadersSafe: true, configuredPath: "/api/hassio_ingress/test" }
    return runWithIngressTransport(ingress, async () => {
      expect((await verifiedBoardRequestPrincipal(memberContext, true))?.kind).toBe("ha_user")
      return editRoute(memberContext)
    })
  })
  expect(member.status).toBe(403)
  expect(await member.json()).toMatchObject({ ok: false, errorCode: "denied" })
  const credential = await runRoute(editRoute, agentContext)
  expect(credential.status).toBe(403)
  expect(await credential.json()).toMatchObject({ status: 403, type: expect.stringContaining("forbidden") })
  expect(databaseSnapshot()).toBe(before)
})

async function withCoreMember<T>(memberId: string, operation: () => Promise<T>): Promise<T> {
  const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
  const { WebSocket, WebSocketServer } = require("ws") as typeof import("../../apps/web/node_modules/@types/ws")
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  const previousSocket = globalThis.WebSocket
  const previousToken = process.env.SUPERVISOR_TOKEN
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve)
      server.once("error", reject)
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test Core address")
    const port = address.port
    server.on("connection", socket => {
      socket.send(JSON.stringify({ type: "auth_required" }))
      socket.on("message", bytes => {
        const command = JSON.parse(bytes.toString())
        if (command.type === "auth" && command.access_token === "fixture-core-token") {
          socket.send(JSON.stringify({ type: "auth_ok" }))
        } else if (command.type === "config/auth/list") {
          socket.send(JSON.stringify({ type: "result", id: command.id, success: true,
            result: [{ id: memberId, is_active: true, system_generated: false, is_owner: false, group_ids: [] }] }))
        } else socket.close()
      })
    })
    globalThis.WebSocket = class extends WebSocket {
      constructor(url: string | URL, options?: import("../../apps/web/node_modules/@types/ws").ClientOptions) {
        if (String(url) !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected Core endpoint")
        super(`ws://127.0.0.1:${port}`, options)
      }
    } as unknown as typeof globalThis.WebSocket
    process.env.SUPERVISOR_TOKEN = "fixture-core-token"
    return await operation()
  } finally {
    globalThis.WebSocket = previousSocket
    if (previousToken === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = previousToken
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test("native routes report conflict, missing, unexpected body and storage failure without partial changes", async ({ db, scope, session }) => {
  test.skip(Boolean(process.env.SUPERVISOR_TOKEN), "Standalone route boundary")
  const label = await createLabel(scope, "Roof")
  await createLabel(scope, "Loft")
  await task(db, "retained-route-task", ["Roof"])
  let before = databaseSnapshot()
  const conflict = await runRoute(editRoute, routeRequest(session, String(label.id), "PUT", '{"title":"Loft"}'))
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ errorCode: "conflict" })
  const body = await runRoute(deleteRoute, routeRequest(session, String(label.id), "DELETE", "{}"))
  expect(body.status).toBe(400)
  const missing = await runRoute(deleteRoute, routeRequest(session, "99999", "DELETE"))
  expect(missing.status).toBe(404)
  expect(databaseSnapshot()).toBe(before)
  await db.execute("DROP TABLE vikunja_task_labels")
  before = databaseSnapshot()
  const unavailable = await runRoute(deleteRoute, routeRequest(session, String(label.id), "DELETE"))
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toMatchObject({ errorCode: "unavailable" })
  expect(databaseSnapshot()).toBe(before)
})

test("cancellation stops a streamed label edit before repository work", async ({ scope, session }) => {
  test.skip(Boolean(process.env.SUPERVISOR_TOKEN), "Standalone parser boundary")
  const label = await createLabel(scope, "Roof")
  const before = databaseSnapshot()
  let waiting = () => {}
  const pending = new Promise<void>(resolve => { waiting = resolve })
  let first = true
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (first) {
      first = false
      controller.enqueue(new TextEncoder().encode("{"))
    }
    else { waiting(); return new Promise<void>(() => {}) }
  } })
  const cancellation = new AbortController()
  const context = routeRequest(session, String(label.id), "PUT")
  context.request = new Request(context.request.url, { method: "PUT", body: stream, duplex: "half",
    headers: context.request.headers, signal: cancellation.signal } as RequestInit)
  const operation = Promise.resolve(runRoute(editRoute, context))
  const enteredReader = await Promise.race([pending.then(() => true), operation.then(() => false)])
  expect(enteredReader).toBe(true)
  cancellation.abort()
  const response = await operation
  expect(response.status).toBe(499)
  expect(await response.json()).toMatchObject({ errorCode: "cancelled" })
  expect(databaseSnapshot()).toBe(before)
})
