import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { createLabel, updateLabel, deleteLabel, UnusedLabelRepository } from "../../apps/web/src/domains/labels"

let directory: string, previous: string | undefined
let scope: Awaited<ReturnType<typeof currentBoardScope>>
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-label-integrity-"))
  previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "labels.db")}`
  await ensureSchema()
  scope = await currentBoardScope(getPersistenceClient())
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})
for (const action of ["rename", "delete"] as const) {
  test(`historical template numeric tokens survive scoped ${action}`, async () => {
    const db = getPersistenceClient(), label = await createLabel(scope, "Roof")
    const kept = '{"name":"Keep","reference":9007199254740993,"large":1e999,"nested":{"precise":0.100000000000000000001,"negativeZero":-0}}'
    const renamed = '{"name":"Roof","count":18446744073709551615,"fraction":0.00000000000000000000000000000000000001}'
    const raw = '{"labels":[' + renamed + ',' + kept + ',"Roof"],"outside":9007199254740993}'
    await db.execute({ sql: "INSERT INTO task_templates(id,name,template_json,created_at,updated_at) VALUES ('historical','Historical',?,1,1)", args: [raw] })
    if (action === "rename") await updateLabel(scope, label.id, { title: "Loft" }); else await deleteLabel(scope, label.id)
    const { rows: [row] } = await db.execute("SELECT template_json,json_extract(template_json,'$.labels') AS labels FROM task_templates WHERE id='historical'")
    expect(row?.labels).toBe(action === "rename" ? '[' + renamed.replace('"Roof"', '"Loft"') + ',' + kept + ']' : '[' + kept + ']')
    expect(row?.template_json).toContain('"outside":9007199254740993')
  })
}
test("cleanup retains orphan junctions and the current owner's private draft usage without changing bodies", async () => {
  const db = getPersistenceClient()
  const orphan = await createLabel(scope, "Orphan"), privateLabel = await createLabel(scope, "Private selection"), unused = await createLabel(scope, "Unused")
  await db.execute({ sql: "INSERT INTO vikunja_task_labels(task_id,label_id,created_at) VALUES ('historical-missing-task',?,1)", args: [orphan.id] })
  const snapshot = '{"version":1,"labels":["Private selection"],"newLabels":[],"description":"Do not expose this private draft body"}'
  await db.execute({ sql: "INSERT INTO task_drafts(owner_id,board_id,draft_id,revision,snapshot_json,save_attempt_id,save_digest,updated_at) VALUES ('owner','household','private',1,?,'attempt','digest',1)", args: [snapshot] })
  const cleanup = new UnusedLabelRepository(db, scope), preview = await cleanup.preview(null)
  expect(preview).toMatchObject({ ok: true, labels: [{ id: unused.id }] })
  expect(JSON.stringify(preview)).not.toContain("Do not expose")
  if (!preview.ok) throw new Error("Expected safe unused candidate")
  expect(preview.labels.map(label => label.id)).toEqual([unused.id])
  expect(await cleanup.remove(preview.labels)).toEqual({ ok: true, removed: [unused.id] })
  expect((await db.execute("SELECT label_id FROM vikunja_task_labels")).rows).toEqual([{ label_id: orphan.id }])
  expect((await db.execute("SELECT id FROM vikunja_labels ORDER BY id")).rows).toEqual([{ id: orphan.id }, { id: privateLabel.id }])
  expect((await db.execute("SELECT snapshot_json FROM task_drafts")).rows[0]?.snapshot_json).toBe(snapshot)
})
for (const snapshot of ['{"version":1,"labels":[],"labels":["Roof"],"newLabels":[]}', '{"version":1,"version":2,"labels":[],"newLabels":[]}', '{"version":1,"labels":[],"newLabels":[],"newLabels":["Roof"]}']) {
  test(`same-owner ambiguous draft blocks cleanup: ${snapshot}`, async () => {
    const db = getPersistenceClient(), label = await createLabel(scope, "Roof"), cleanup = new UnusedLabelRepository(db, scope)
    const preview = await cleanup.preview(null)
    if (!preview.ok) throw new Error("Expected initial candidate")
    await db.execute({ sql: "INSERT INTO task_drafts(owner_id,board_id,draft_id,revision,snapshot_json,save_attempt_id,save_digest,updated_at) VALUES ('owner','household','ambiguous',1,?,'attempt','digest',1)", args: [snapshot] })
    expect(await cleanup.preview(null)).toEqual({ ok: false, errorCode: "blocked" })
    expect(await cleanup.remove(preview.labels)).toEqual({ ok: false, errorCode: "blocked" })
    expect((await db.execute("SELECT id FROM vikunja_labels")).rows).toEqual([{ id: label.id }])
  })
}
