import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { registerVerifiedPrincipal, type BoardScope } from "../../apps/web/src/domains/tasks/board-scope"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { readTaskDeletionReceipt } from "../../apps/web/src/domains/tasks/persistence/task-deletion-receipt"
import { acquirePrivateBoardWriter, boardOperationClient, boardReadTransactionClient } from "../../apps/web/src/domains/tasks/persistence/board-operation-client"
import { getTimerState, startFocus, skipToBreak, getSessionHistory, getTimeEntries, startTimeEntryForTask, resetPomodoroForTests } from "../../apps/web/src/domains/pomodoro/pomodoro-service"
import { TaskDraftRepository } from "../../apps/web/src/domains/tasks/persistence/task-draft-repository"
import { createLabel, deleteLabel, UnusedLabelRepository } from "../../apps/web/src/domains/labels"
import { taskDraftSnapshot } from "../../apps/web/src/lib/task-draft-state"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { createAgentToken, ensureAgentTokenSchema } from "../../apps/web/src/domains/auth/agent-token-store"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"

let directory: string, previousUrl: string | undefined
const owner = () => registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
async function scope(boardId: string, principal = owner()): Promise<BoardScope> {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(principal, boardId, { resource: "task", action: "create" })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
async function workBoard() {
  const created = await new NamedBoardRepository(getPersistenceClient()).create(owner(), "Work")
  if (created.status !== "committed") throw new Error("Board creation unavailable")
  return created.result.id
}
async function create(work: BoardScope, body: Record<string, unknown>) {
  const repo = new TaskRepository(getPersistenceClient(), work)
  const prepared = await prepareTaskCreation(repo, body, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  const result = await repo.createWorkCommand(prepared.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-work-commands-"))
  previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPomodoroForTests(); resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
for (const encoding of ["legacy", "scoped"] as const) {
  test(`unfiled and the real default Area remain distinct: ${encoding}`, async () => {
    const board = encoding === "legacy" ? "household" : await workBoard()
    const db = getPersistenceClient()
    const work = await scope(board)
    const hierarchy = new HierarchyRepository(db, work)
    // Synthetic predecessor ownership is independently set up before exercising
    // production commands. The real id is retained, rather than reinterpreted.
    const { rows } = await db.execute("SELECT id FROM areas WHERE id = 'default'")
    if (rows.length) await db.execute({ sql: "UPDATE areas SET owner_board_id = ?, retired_at = NULL WHERE id = 'default'", args: [encoding === "legacy" ? null : board] })
    else expect(await hierarchy.createArea({ id: "default", name: "A real user Area" })).toBe(true)
    const unfiled = await create(work, { title: "Unfiled" })
    const filed = await create(work, { title: "In the real default Area", area_id: "default" })
    expect(unfiled.area_id).toBeNull()
    expect(filed.area_id).toBe("default")
    const repo = new TaskRepository(db, work)
    expect((await repo.findAll({ areaId: "default" })).tasks.map(task => task.id)).toEqual([filed.id])
    expect((await repo.updateTask(filed.id, { area_id: null })).ok).toBe(true)
    expect((await repo.findById(filed.id))?.area_id).toBeNull()
    expect((await hierarchy.findAreaById("default"))?.name).toBeTruthy()
  })
  test(`recurrence and deletion receipts use the common actual writer: ${encoding}`, async () => {
    const board = encoding === "legacy" ? "household" : await workBoard()
    const work = await scope(board), db = getPersistenceClient(), repo = new TaskRepository(db, work)
    const task = await create(work, { title: "Water seedlings", due_date: "2026-11-19", recurrence_rule: "FREQ=DAILY", checklists: JSON.stringify([{ id: crypto.randomUUID(), text: "Use watering can", done: true }]) })
    const completed = await repo.updateTask(task.id, { status: "complete" })
    expect(completed.ok).toBe(true)
    if (!completed.ok) throw new Error(completed.errorCode)
    expect(completed.successor).toMatchObject({ title: "Water seedlings", dueDate: "2026-11-20", ticketNumber: Number(task.ticket_number) + 1 })
    const successor = await repo.findById(completed.successor!.id)
    expect(successor).toMatchObject({ status: "pending", area_id: null, task_kind: "standard_action" })
    expect(JSON.parse(successor!.checklists!)[0].done).toBe(false)
    expect((await repo.updateTask(task.id, { status: "complete" })).ok).toBe(true)
    expect((await repo.findAll({})).total).toBe(2)
    expect((await repo.updateTask(task.id, { status: "pending" })).ok).toBe(true)
    const completedAgain = await repo.updateTask(task.id, { status: "complete" })
    expect(completedAgain.ok).toBe(true)
    if (!completedAgain.ok) throw new Error(completedAgain.errorCode)
    expect(completedAgain.successor?.id).not.toBe(completed.successor!.id)
    expect(completedAgain.successor?.ticketNumber).toBe(Number(task.ticket_number) + 2)
    expect((await repo.updateTask(task.id, { status: "complete" })).ok).toBe(true)
    expect((await repo.findAll({})).total).toBe(3)
    expect(await repo.deleteWorkCommand(successor!.id, { version: 0 })).toEqual({ ok: false, errorCode: "conflict" })
    const deleted = await repo.deleteWorkCommand(successor!.id)
    expect(deleted.ok).toBe(true)
    if (!deleted.ok) throw new Error(deleted.errorCode)
    expect(await repo.findById(successor!.id)).toBeNull()
    const receipt = await readTaskDeletionReceipt(db, work, deleted.eventId, successor!.id)
    expect(receipt).toMatchObject({ id: successor!.id, eventId: deleted.eventId, task: { title: "Water seedlings" } })
    expect(JSON.stringify(receipt)).not.toContain("_authority")
    expect(await readTaskDeletionReceipt(db, work, crypto.randomUUID(), successor!.id)).toBeNull()
  })
}
test("read loans reject publication after a real Board authority change", async () => {
  const db = getPersistenceClient(), board = await workBoard(), work = await scope(board)
  await create(work, { title: "Private snapshot" })
  const tx = await boardOperationClient(db, work, { resource: "task", action: "read" }).transaction("read")
  const reader = boardReadTransactionClient(tx, work)
  const child = new TaskRepository(reader, work)
  expect((await child.findAll({})).total).toBe(1)
  await new NamedBoardRepository(db).updateRestrictions(owner(), board, { denyCompletion: false, denyDeletion: true, denyAgentDeletion: true })
  await expect(child.findAll({})).rejects.toBeTruthy()
  await expect(tx.commit()).rejects.toBeTruthy()
  tx.close()
})
test("an admitted SQLite read snapshot expires with the original actor", async () => {
  const db = getPersistenceClient()
  const clock = Date.now
  const expiry = clock() + 60_000
  const actor = registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: expiry })
  const work = await scope("household", actor)
  const tx = await boardOperationClient(db, work, { resource: "task", action: "read" }).transaction("read")
  try {
    expect((await tx.execute("SELECT 1 AS available")).rows[0]?.available).toBe(1)
    Date.now = () => expiry
    await expect(tx.execute("SELECT 1")).rejects.toMatchObject({ errorCode: "stale" })
    await expect(tx.commit()).rejects.toMatchObject({ errorCode: "stale" })
  } finally {
    Date.now = clock
    tx.close()
  }
})
test("a private SQLite writer rolls back if its actor expires before commit", async () => {
  const db = getPersistenceClient()
  const clock = Date.now
  const expiry = clock() + 60_000
  const actor = registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: expiry })
  const work = await scope("household", actor)
  const task = await create(work, { title: "Original title" })
  const editor = boardOperationClient(db, work, { resource: "task", action: "edit" }, [task.id])
  const tx = await acquirePrivateBoardWriter(editor, work)
  try {
    expect((await tx.execute("UPDATE tasks SET title = ? WHERE id = ? AND task_board_id IS NULL", ["New title", task.id])).rowsAffected).toBe(1)
    Date.now = () => expiry
    await expect(tx.commit()).rejects.toMatchObject({ errorCode: "stale" })
  } finally {
    Date.now = clock
    tx.close()
  }
  expect((await new TaskRepository(db, work).findById(task.id))?.title).toBe("Original title")
})
test("write-authorized task selectors use a read snapshot while another connection holds the writer", async () => {
  const db = getPersistenceClient(), work = await scope("household"), repo = new TaskRepository(db, work)
  const task = await create(work, { title: "Read a command target without taking a writer" })
  const external = openDatabase(process.env.MEITHEAL_DB_URL!)
  const lock = await external.transaction("write")
  try {
    await lock.execute("INSERT INTO settings(key,value) VALUES ('external-selector-lock','held')")
    expect(await repo.resolveTaskId(task.id, "edit")).toMatchObject({ id: task.id })
    expect(await repo.findTaskForCommand(task.id, "edit")).toMatchObject({ id: task.id, title: task.title })
    expect(await repo.getFieldsForDiff(task.id)).toMatchObject({ title: task.title })
    expect((await db.execute("SELECT title FROM tasks WHERE id=?", [task.id])).rows[0]?.title).toBe(task.title)
  } finally {
    await lock.rollback(); lock.close(); external.close()
  }
})
test("personal timers and time entries stay in their original Board and actor", async () => {
  const board = await workBoard(), home = await scope("household"), work = await scope(board)
  const other = await scope("household", registerVerifiedPrincipal({ kind: "ha_user", id: "other" }, { administrator: false, expiresAt: Date.now() + 60_000 }))
  const task = await create(home, { title: "Home focus" })
  expect((await startFocus(home, task.id)).taskId).toBe(task.id)
  expect((await getTimerState(work)).phase).toBe("idle")
  expect((await getTimerState(other)).phase).toBe("idle")
  await skipToBreak(home)
  expect((await getSessionHistory(home)).length).toBe(1)
  expect(await getSessionHistory(other)).toEqual([])
  expect((await getTimeEntries(home, task.id)).length).toBe(1)
  expect(await getTimeEntries(other, task.id)).toEqual([])
  await expect(startTimeEntryForTask(work, task.id)).rejects.toBeTruthy()
  expect((await getTimeEntries(home, task.id)).length).toBe(1)
})
for (const maintenance of ["delete", "cleanup"] as const) {
test(`label ${maintenance} preserves another person's private draft and blocks stale publication inputs`, async () => {
  const db = getPersistenceClient(), work = await scope("household")
  const other = await scope("household", registerVerifiedPrincipal({ kind: "ha_user", id: "other" }, { administrator: false, expiresAt: Date.now() + 60_000 }))
  const label = await createLabel(work, "Private draft choice")
  const snapshot = taskDraftSnapshot.parse({ version: 1, title: "Other user's draft", description: "Retain private text", taskKind: "standard_action", status: "pending", priority: 3, due: "", labels: [label.title], newLabels: [], assignedTo: "", goal: "", recurrence: "", isRoutine: false, checklist: { items: [], input: "" }, shopping: { items: [], input: "", quantity: "1", category: "" }, event: { start: "", end: "", location: "", allDay: false, calendar: "" }, fields: [] })
  const drafts = new TaskDraftRepository(db, other)
  const saved = await drafts.save("other", { action: "save", expected: null, attemptId: crypto.randomUUID(), snapshot })
  expect(saved).toBeTruthy()
  const before = await db.execute({ sql: "SELECT * FROM task_drafts WHERE owner_id = 'other'", args: [] })
  if (maintenance === "delete") expect(await deleteLabel(work, label.id)).toBe(true)
  else {
    const cleanup = new UnusedLabelRepository(db, work), preview = await cleanup.preview(null)
    expect(preview).toMatchObject({ ok: true, labels: [{ id: label.id }] })
    expect(JSON.stringify(preview)).not.toContain("Retain private text")
    if (!preview.ok) throw new Error("Cleanup preview unavailable")
    expect(await cleanup.remove(preview.labels)).toEqual({ ok: true, removed: [label.id] })
  }
  expect((await db.execute("SELECT * FROM task_drafts WHERE owner_id = 'other'")).rows).toEqual(before.rows)
  await expect(drafts.save("other", { action: "save", expected: { draftId: saved!.draftId, revision: saved!.revision }, attemptId: crypto.randomUUID(), snapshot })).rejects.toMatchObject({ errorCode: "STALE_LABELS" })
  expect((await drafts.read("other")).draft?.snapshot.description).toBe("Retain private text")
})
}
for (const encoding of ["legacy", "scoped"] as const) {
  test(`a child choosing Done cannot create a ticket or consume a number: ${encoding}`, async () => {
    const db = getPersistenceClient(), board = encoding === "legacy" ? "household" : await workBoard()
    await new NamedBoardRepository(db).updateMember(owner(), board, "child", { role: "member", denyCompletion: true, denyDeletion: true }, ["parent", "child"])
    const work = await scope(board, registerVerifiedPrincipal({ kind: "ha_user", id: "child" }, { administrator: false, expiresAt: Date.now() + 60_000 }))
    const repo = new TaskRepository(db, work)
    const prepared = await prepareTaskCreation(repo, { title: "Must not be created" }, { useDefaultAssignee: false })
    if (!prepared.ok) throw new Error(prepared.error)
    const { rows: [lane] } = await db.execute({ sql: "SELECT id FROM kanban_lanes WHERE board_id=? AND key='complete'", args: [board] })
    const before = (await db.execute({ sql: "SELECT ticket_high_water FROM task_boards WHERE id=?", args: [board] })).rows
    await expect(repo.createWorkCommand(prepared.task, { laneId: String(lane!.id), deriveStatusFromLane: true })).rejects.toBeTruthy()
    expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(0)
    expect((await db.execute({ sql: "SELECT ticket_high_water FROM task_boards WHERE id=?", args: [board] })).rows).toEqual(before)
  })
}
test("forged HA target evidence cannot create work, and removed custom assignees are retained only on existing work", async () => {
  const db = getPersistenceClient(), work = await scope("household"), repo = new TaskRepository(db, work)
  const prepared = await prepareTaskCreation(repo, { title: "Forged target", assigned_to: "ha_unknown" }, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  await expect(repo.createWorkCommand(prepared.task, { assignmentProof: {} as never })).rejects.toMatchObject({ errorCode: "denied" })
  expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(0)
  await db.execute("INSERT INTO custom_users(id,name,color,kind,created_at,updated_at) VALUES ('custom_person','Person','#112233','human',1,1)")
  const assigned = await create(work, { title: "Existing assigned work", assigned_to: "custom_person" })
  await db.execute("DELETE FROM custom_users WHERE id='custom_person'")
  expect((await repo.updateTask(assigned.id, { title: "Keep history while editing" })).ok).toBe(true)
  expect((await repo.findById(assigned.id))?.assigned_to).toBe("custom_person")
  await expect(create(work, { title: "New assignment to missing identity", assigned_to: "custom_person" })).rejects.toBeTruthy()
  expect((await repo.findAll({})).total).toBe(1)
})
test("Project placement intersects its parent Area audience before creation or movement", async () => {
  const db = getPersistenceClient(), work = await scope("household")
  const hierarchy = new HierarchyRepository(db, work)
  await hierarchy.createArea({ id: "private-parent", name: "Private Area" })
  await hierarchy.createProject({ id: "private-project", title: "Private Project", area_id: "private-parent" })
  const { changeBoardGrants } = await import("../../apps/web/src/domains/tasks/persistence/board-grant-fence")
  await changeBoardGrants(db, owner(), async tx => {
    await tx.execute("INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('group','private-parent','household','selected','[\"parent\"]',1)")
    return { next: true }
  })
  const other = await scope("household", registerVerifiedPrincipal({ kind: "ha_user", id: "other" }, { administrator: false, expiresAt: Date.now() + 60_000 }))
  const repo = new TaskRepository(db, other)
  const unfiled = await create(other, { title: "Visible task" })
  const before = (await db.execute("SELECT ticket_high_water FROM task_boards WHERE id='household'")).rows
  await expect(create(other, { title: "Must not enter a private Project", project_id: "private-project" })).rejects.toBeTruthy()
  const moved = await repo.updateTask(unfiled.id, { project_id: "private-project" }).catch(() => ({ ok: false }))
  expect(moved.ok).toBe(false)
  expect((await repo.findById(unfiled.id))?.project_id).toBeNull()
  expect((await db.execute("SELECT COUNT(*) AS total FROM tasks")).rows[0]?.total).toBe(1)
  expect((await db.execute("SELECT ticket_high_water FROM task_boards WHERE id='household'")).rows).toEqual(before)
})
test("digit-first persisted Board prefixes resolve their own keys without a foreign prefix fallback", async () => {
  const db = getPersistenceClient(), sourceBoard = await workBoard(), board = crypto.randomUUID()
  const { changeBoardGrants } = await import("../../apps/web/src/domains/tasks/persistence/board-grant-fence")
  // A fixed synthetic initial identity exercises the legitimate digit-first
  // encoding without mutating the production-immutable Board prefix.
  await changeBoardGrants(db, owner(), async tx => {
    await tx.execute({ sql: "INSERT INTO task_boards(id,name,visibility,ticket_prefix,created_at,updated_at) VALUES (?,'Digit prefix fixture','restricted','6OSYDSDD',1,1)", args: [board] })
    await tx.execute({ sql: "INSERT INTO board_permissions(board_id) VALUES (?)", args: [board] })
    await tx.execute({ sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role) VALUES (?,'ha_user','parent','owner')", args: [board] })
    const { rows } = await tx.execute({ sql: "SELECT key,label,position,includes,built_in FROM kanban_lanes WHERE board_id=?", args: [sourceBoard] })
    for (const lane of rows) await tx.execute({ sql: "INSERT INTO kanban_lanes(id,board_id,key,label,position,includes,built_in,created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,1)", args: [crypto.randomUUID(), board, lane.key!, lane.label!, lane.position!, lane.includes!, lane.built_in!] })
    return { next: true }
  })
  const work = await scope(board), repo = new TaskRepository(db, work)
  const task = await create(work, { title: "Digit-first Board ticket" })
  expect(task.ticket_ref).toBe("6OSYDSDD-1")
  expect((await repo.resolveTaskId("6OSYDSDD-1"))?.id).toBe(task.id)
  expect(await repo.resolveTaskId("MTH-1")).toBeNull()
  expect((await repo.deleteWorkCommand("6OSYDSDD-1")).ok).toBe(true)
})

test("deletion receipts preserve the old effective Area when their Project later moves", async () => {
  const db = getPersistenceClient(), work = await scope("household")
  const hierarchy = new HierarchyRepository(db, work)
  await hierarchy.createArea({ id: "old-private-area", name: "Original Area" })
  await hierarchy.createArea({ id: "later-public-area", name: "Later Area" })
  expect(await hierarchy.createProject({ id: "moving-project", title: "Moving Project", area_id: "old-private-area" })).toBe(true)
  const repo = new TaskRepository(db, work)
  const original = await create(work, { title: "Keep the original audience", project_id: "moving-project" })
  expect(original.area_id).toBeNull()
  const deleted = await repo.deleteWorkCommand(original.id)
  if (!deleted.ok) throw new Error(deleted.errorCode)
  expect((await readTaskDeletionReceipt(db, work, deleted.eventId, original.id))?.placement).toEqual({ areaId: "old-private-area", projectId: "moving-project" })
  expect(await hierarchy.updateProject("moving-project", { area_id: "later-public-area" })).toBe(true)
  const { changeBoardGrants } = await import("../../apps/web/src/domains/tasks/persistence/board-grant-fence")
  await changeBoardGrants(db, owner(), async tx => {
    await tx.execute("INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('group','old-private-area','household','nobody','[]',1)")
    return { next: true }
  })
  const current = await scope("household")
  expect(await readTaskDeletionReceipt(db, current, deleted.eventId, original.id)).toBeNull()
})

test("assigned-only replay reuses exact commit proof and denies corrupt, legacy or stale snapshots", async () => {
  const db = getPersistenceClient(), board = await workBoard()
  await new IdentityRepository(db).createCustomUser("custom_receipt_agent", "Receipt agent", "#146C4E", "agent")
  await ensureAgentTokenSchema()
  const tokenId = crypto.randomUUID()
  await createAgentToken({ id: tokenId, name: "Receipt agent", tokenHash: crypto.randomUUID(), tokenPrefix: "test", scopes: ["tasks:write:assigned"], assigneeId: "custom_receipt_agent" })
  expect((await new NamedBoardRepository(db).updateAgent(owner(), board, tokenId, true)).status).toBe("committed")
  let work = await scope(board)
  const projectId = crypto.randomUUID(), hierarchy = new HierarchyRepository(db, work)
  expect(await hierarchy.createProject({ id: projectId, title: "Retired association remains private provenance" })).toBe(true)
  const task = await create(work, { title: "Private receipt body", assigned_to: "custom_receipt_agent", project_id: projectId })
  expect(await hierarchy.deleteProject(projectId)).toBe(true)
  work = await scope(board)
  const agent = registerVerifiedPrincipal({ kind: "agent", id: tokenId, tokenId }, { administrator: false, expiresAt: Date.now() + 60_000,
    tokenScopes: ["tasks:write:assigned"], assignedTo: "custom_receipt_agent" })
  const resolved = await new BoardAccessService(db).resolve(agent, board, { resource: "task", action: "assign" })
  if (!resolved.ok) throw new Error(resolved.errorCode)
  const repo = new TaskRepository(db, resolved.scope), requestId = crypto.randomUUID()
  const result = await repo.updateTask(task.id, { assigned_to: null }, { reassignmentReceipt: { key: `${tokenId}:custom_receipt_agent:${task.id}:${requestId}`, requestId, assignedTo: null } })
  expect(result.ok).toBe(true)
  const expected = { id: task.id, ticket_key: task.ticket_ref, assigned_to: null }
  expect(await repo.findReassignmentReceipt(task.id, requestId, null)).toEqual(expected)
  expect(await repo.findReassignmentReceipt(String(task.ticket_ref), requestId, null)).toEqual(expected)
  await expect(repo.findById(task.id)).rejects.toBeTruthy()
  const row = (await db.execute("SELECT attempt_id,response_payload FROM integration_attempts WHERE integration='task.reassignment' AND task_id=?", [task.id])).rows[0]!
  const saved = JSON.parse(String(row.response_payload))
  expect(saved.task.project_id).toBeNull()
  expect(saved._authority.placement.projectId).toBe(projectId)
  const corruptions = [
    { ...saved, _authority: undefined },
    { ...saved, _authority: { ...saved._authority, principalId: "another-agent" } },
    { ...saved, _authority: { ...saved._authority, boardId: "household" } },
    { ...saved, _authority: { ...saved._authority, oldAssignedTo: "custom_other_agent" } },
    { ...saved, _authority: { ...saved._authority, taskVersion: saved._authority.taskVersion - 1 } },
    { ...saved, _authority: { ...saved._authority, placement: { areaId: "private-area", projectId: null } } },
  ]
  // Missing field history cannot turn a malformed receipt into authority.
  await db.execute("DELETE FROM task_activity_log WHERE task_id=? AND field='assigned_to'", [task.id])
  for (const corrupted of corruptions) {
    await db.execute("UPDATE integration_attempts SET response_payload=? WHERE attempt_id=?", [JSON.stringify(corrupted), String(row.attempt_id)])
    expect(await repo.findReassignmentReceipt(task.id, requestId, null)).toBeNull()
  }
  await db.execute("UPDATE integration_attempts SET response_payload=? WHERE attempt_id=?", [String(row.response_payload), String(row.attempt_id)])
  expect(await repo.findReassignmentReceipt(task.id, requestId, null)).toEqual(expected)
  expect((await new TaskRepository(db, work).updateTask(task.id, { title: "Later current version" })).ok).toBe(true)
  expect(await repo.findReassignmentReceipt(task.id, requestId, null)).toBeNull()
})
