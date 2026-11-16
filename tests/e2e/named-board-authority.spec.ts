import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { BoardIntakeRepository } from "../../apps/web/src/domains/tasks/persistence/board-intake-repository"
import { changeBoardGrants, readBoardGrantRevision } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { NamedBoardRepository, permitsBoardTaskAction } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

let directory: string
let marker: string
const originalDatabase = process.env.MEITHEAL_DB_URL

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-board-authority-"))
  marker = join(directory, "meitheal-board-grants.json")
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "meitheal.db")}`
  await ensureSchema()
})

test.afterEach(async () => {
  resetPersistenceForTests()
  if (originalDatabase === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = originalDatabase
  await rm(directory, { recursive: true, force: true })
})

test("named grants are scoped to their Board, apply denials, and cannot remove the last active owner", async () => {
  const db = getPersistenceClient()
  const repo = new NamedBoardRepository(db, marker)
  const creator = { kind: "ha_user", id: "parent" } as const
  const member = { kind: "ha_user", id: "child" } as const
  const owner = await repo.create(creator.id, "Child projects")
  expect(owner.status).toBe("committed")
  if (owner.status !== "committed") throw new Error("Expected a new board")
  const { id } = owner.result

  expect(await repo.findAccess({ kind: "ha_user", id: "ha-owner-outside-board" }, id)).toBeNull()
  expect(await repo.findAccess(creator, id)).toMatchObject({ role: "owner", name: "Child projects" })
  expect(await repo.updateMember(creator.id, id, creator.id, null, [creator.id, member.id]))
    .toEqual({ status: "unchanged", result: "last-owner" })
  expect(await repo.updateMember(creator.id, id, member.id, { role: "member", denyCompletion: true, denyDeletion: true }, [creator.id, member.id]))
    .toEqual({ status: "committed", result: "saved" })
  expect(await repo.setSidebarHidden(member, id, true)).toBe(true)
  const memberAccess = await repo.findAccess(member, id)
  expect(memberAccess).not.toBeNull()
  if (!memberAccess) throw new Error("Expected a child grant")
  for (const action of ["read", "move", "create", "edit"] as const) {
    expect(permitsBoardTaskAction(memberAccess, action)).toBe(true)
  }
  for (const action of ["complete", "reopen", "delete", "archive", "purge"] as const) {
    expect(permitsBoardTaskAction(memberAccess, action)).toBe(false)
  }

  const agent = { kind: "agent", id: "fixture-token" } as const
  await db.execute({
    sql: "INSERT INTO board_access_grants (board_id, principal_type, principal_id, role) VALUES (?, 'agent', ?, 'service')",
    args: [id, agent.id],
  })
  expect(await repo.updateRestrictions(creator.id, id, { denyCompletion: false, denyDeletion: false, denyAgentDeletion: true }))
    .toEqual({ status: "committed", result: true })
  const agentAccess = await repo.findAccess(agent, id)
  const ownerAccess = await repo.findAccess(creator, id)
  if (!agentAccess || !ownerAccess) throw new Error("Expected both valid grants")
  expect(permitsBoardTaskAction(agentAccess, "create")).toBe(true)
  expect(permitsBoardTaskAction(agentAccess, "delete")).toBe(false)
  expect(permitsBoardTaskAction(ownerAccess, "complete")).toBe(true)
  expect(permitsBoardTaskAction(ownerAccess, "delete")).toBe(true)
})

test("a restored, absent, or replaced grant marker fails closed", async () => {
  const db = getPersistenceClient()
  const repo = new NamedBoardRepository(db, marker)
  const first = await repo.create("owner", "Work")
  if (first.status !== "committed") throw new Error("Expected a new board")
  const { id } = first.result
  const previous = await readFile(marker)
  const current = await repo.create("owner", "Home")
  expect(current.status).toBe("committed")
  const active = await readFile(marker)
  expect(active.equals(previous)).toBe(false)
  const actor = { kind: "ha_user", id: "owner" } as const

  await writeFile(marker, previous)
  expect(await repo.findAccess(actor, id)).toBeNull()
  let called = false
  const result = await changeBoardGrants(db, async () => { called = true; return { next: "" } }, marker)
  expect(result).toEqual({ status: "locked" })
  expect(called).toBe(false)

  await rm(marker)
  expect(await repo.findAccess(actor, id)).toBeNull()
  const substitute = join(directory, "substitute")
  await writeFile(substitute, active)
  await symlink(substitute, marker)
  expect(await readBoardGrantRevision(marker)).toBeNull()
  await rm(marker)
  await writeFile(marker, active)
  expect(await repo.findAccess(actor, id)).not.toBeNull()
})

test("failed grant-marker publication can recover the one committed change", async () => {
  const db = getPersistenceClient()
  const repo = new NamedBoardRepository(db, marker)
  await mkdir(marker)
  const creation = await repo.create("owner", "Work")
  expect(creation.status).toBe("committed-locked")
  if (creation.status !== "committed-locked") throw new Error("Expected a durable Board with work still locked")
  const { id } = creation.result
  const actor = { kind: "ha_user", id: "owner" } as const
  expect(await repo.findAccess(actor, id)).toBeNull()
  await rm(marker, { recursive: true })

  expect(await repo.findAccess(actor, id)).toMatchObject({ id, name: "Work" })
  const { rows } = await db.execute("SELECT id FROM task_boards WHERE id <> 'household'")
  expect(rows.map(row => row.id)).toEqual([id])
  expect(await readBoardGrantRevision(marker)).toMatch(/^[0-9a-f-]{36}$/)
})

test("a child can move and edit a named ticket while completion and deletion remain denied", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const tasks = new NamedBoardTaskRepository(db, marker)
  const parent = { kind: "ha_user", id: "parent" } as const
  const child = { kind: "ha_user", id: "child" } as const

  const createdBoard = await boards.create(parent.id, "Home")
  const privateBoard = await boards.create(parent.id, "Work")
  if (createdBoard.status !== "committed" || privateBoard.status !== "committed") throw new Error("Expected two boards")
  const home = createdBoard.result.id
  const work = privateBoard.result.id
  await boards.updateMember(parent.id, home, child.id, { role: "member", denyCompletion: true, denyDeletion: true }, [parent.id, child.id])
  await db.execute({
    sql: "INSERT INTO areas(id, name, owner_board_id, created_at, updated_at) VALUES ('private-area', 'Private Area', ?, 1, 1)",
    args: [work],
  })

  const { rows: lanes } = await db.execute({ sql: "SELECT id, key FROM kanban_lanes WHERE board_id = ?", args: [home] })
  const inProgress = String(lanes.find(lane => lane.key === "active")?.id)
  const done = String(lanes.find(lane => lane.key === "complete")?.id)
  const content = { title: "Finish project", description: "Give it a test" }

  expect(await tasks.create(child, work, content, {})).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await tasks.create(child, home, content, { areaId: "private-area" })).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await tasks.create(child, home, content, { laneId: done })).toEqual({ ok: false, errorCode: "denied" })
  const created = await tasks.create(child, home, content, { areaId: "default" })
  if (!created.ok) throw new Error("Expected an authorized ticket")
  expect(created.value.ticket).toMatch(/^[A-Z2-7]{8}-1$/)
  const task = created.value.id

  const edited = await tasks.edit(child, home, task, created.value.version, { ...content, title: "Finish revised project" })
  if (!edited.ok) throw new Error("Expected an authorized edit")
  const moved = await tasks.move(child, home, task, inProgress, edited.value.version)
  if (!moved.ok) throw new Error("Expected an authorized move")
  const unchanged = moved.value.version
  expect(await tasks.move(child, home, task, done, unchanged)).toEqual({ ok: false, errorCode: "denied" })
  expect(await tasks.delete(child, home, task, unchanged)).toEqual({ ok: false, errorCode: "denied" })
  const { rows: [record] } = await db.execute({
    sql: "SELECT status, updated_at FROM tasks WHERE id = ?", args: [task],
  })
  expect(record).toMatchObject({ status: "active", updated_at: unchanged })

  const completed = await tasks.move(parent, home, task, done, unchanged)
  if (!completed.ok) throw new Error("Expected the parent's permitted completion")
  expect(await tasks.move(child, home, task, inProgress, completed.value.version)).toEqual({ ok: false, errorCode: "denied" })
  const beforeDelete = await db.execute({ sql: "SELECT area_id FROM board_task_planning WHERE task_id = ?", args: [task] })
  expect(beforeDelete.rows[0]).toMatchObject({ area_id: "default" })
  expect(await tasks.delete(parent, home, task, completed.value.version)).toEqual({ ok: true, value: true })
  const afterDelete = await db.execute({ sql: "SELECT 1 FROM board_task_planning WHERE task_id = ?", args: [task] })
  expect(afterDelete.rows).toHaveLength(0)
})

test("send-only intake accepts once, returns opaque retries, and can assign without granting reads", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const intake = new BoardIntakeRepository(db, marker)
  const sender = { kind: "ha_user", id: "sender" } as const
  const work = await boards.create("owner", "Private Work")
  if (work.status !== "committed") throw new Error("Expected Work Board")
  const boardId = work.result.id
  const { rows: [triage] } = await db.execute({
    sql: "SELECT id FROM kanban_lanes WHERE board_id = ? AND key = 'pending'",
    args: [boardId],
  })
  const destination = await intake.create("owner", boardId, {
    label: "Send work to the owner", laneId: String(triage?.id), senders: [sender], recipientUserId: "owner",
  })
  if (destination.status !== "committed" || !destination.result) throw new Error("Expected intake destination")
  const id = destination.result.id
  const afterIssue = Date.now()
  const permit = await intake.issue(sender, id, afterIssue)
  const staleRecipientPermit = await intake.issue(sender, id, afterIssue)
  const unusedPermit = await intake.issue(sender, id, afterIssue)
  if (!permit.ok || !staleRecipientPermit.ok || !unusedPermit.ok) throw new Error("Expected sender permits")
  const input = { title: "Check the issue", description: "Please review", assignToRecipient: true }

  expect(await boards.findAccess(sender, boardId)).toBeNull()
  expect(await intake.issue({ kind: "ha_user", id: "other" }, id)).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit({ kind: "ha_user", id: "other" }, permit.value.token, input, ["owner"]))
    .toEqual({ ok: false, errorCode: "unavailable" })

  const [accepted, replay] = await Promise.all([
    intake.submit(sender, permit.value.token, input, ["owner"]),
    intake.submit(sender, permit.value.token, input, ["owner"]),
  ])
  if (!accepted.ok) throw new Error("Expected accepted work")
  expect(Object.keys(accepted.value)).toEqual(["acknowledgement"])
  expect(replay).toEqual(accepted)
  expect(await intake.submit(sender, permit.value.token, { ...input, title: "Different work" }, ["owner"]))
    .toEqual({ ok: false, errorCode: "conflict" })
  const fallBack = await intake.submit(sender, staleRecipientPermit.value.token, { ...input, title: "Triage instead" }, [])
  expect(fallBack.ok).toBe(true)
  const { rows: tasks } = await db.execute({
    sql: "SELECT title, assigned_to, board_column_id FROM tasks WHERE task_board_id = ? ORDER BY title",
    args: [boardId],
  })
  expect(tasks).toMatchObject([
    { title: "Check the issue", assigned_to: "ha_owner", board_column_id: triage?.id },
    { title: "Triage instead", assigned_to: null, board_column_id: triage?.id },
  ])

  const pending = {
    ...input, title: "Recover after refresh", resumeId: crypto.randomUUID(),
  }
  const prepared = await intake.issue(sender, id, afterIssue, pending)
  expect(prepared).toMatchObject({ ok: true, value: { resumeId: pending.resumeId } })
  expect(await intake.issue(sender, id, afterIssue, pending)).toEqual(prepared)
  expect(await intake.issue(sender, id, afterIssue, { ...pending, title: "Changed" }))
    .toEqual({ ok: false, errorCode: "conflict" })
  const refreshed = new BoardIntakeRepository(db, marker)
  expect(await refreshed.findSubmissions(sender)).toEqual([
    { id: pending.resumeId, title: pending.title, sent: false },
  ])
  const other = { kind: "ha_user", id: "other" } as const
  expect(await refreshed.findSubmissions(other)).toEqual([])
  expect(await refreshed.retry(other, pending.resumeId, ["owner"])).toEqual({ ok: false, errorCode: "unavailable" })
  const [recovered, repeat] = await Promise.all([
    refreshed.retry(sender, pending.resumeId, ["owner"]), refreshed.retry(sender, pending.resumeId, ["owner"]),
  ])
  expect(recovered).toMatchObject({ ok: true, value: { acknowledgement: expect.any(String) } })
  expect(repeat).toEqual(recovered)
  expect((await db.execute("SELECT count(*) AS count FROM tasks WHERE title = 'Recover after refresh'")).rows[0]?.count).toBe(1)

  expect(await intake.setEnabled("owner", boardId, id, false)).toMatchObject({ status: "committed" })
  expect(await refreshed.findSubmissions(sender)).toEqual([
    { id: pending.resumeId, title: pending.title, sent: true },
  ])
  expect(await refreshed.issue(sender, id, afterIssue, pending)).toEqual(prepared)
  expect(await refreshed.retry(sender, pending.resumeId, ["owner"])).toEqual(recovered)
  expect(await intake.issue(sender, id)).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit(sender, unusedPermit.value.token, input, ["owner"])).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit(sender, permit.value.token, input, ["owner"])).toEqual(accepted)
  expect(await intake.submit(sender, permit.value.token, input, ["owner"], permit.value.expiresAt)).toEqual({ ok: false, errorCode: "unavailable" })
})
