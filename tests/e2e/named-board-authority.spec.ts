import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { createAgentToken, ensureAgentTokenSchema, revokeAgentToken, updateAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { BoardIntakeRepository } from "../../apps/web/src/domains/tasks/persistence/board-intake-repository"
import { changeBoardGrants, readBoardGrantRevision } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { NamedBoardRepository, permitsBoardTaskAction } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardPlanningRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-planning-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { readSharedGoals } from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
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

  const agent = { kind: "agent", id: crypto.randomUUID() } as const
  await ensureAgentTokenSchema()
  await createAgentToken({
    id: agent.id, name: "Fixture", tokenHash: crypto.randomUUID(), tokenPrefix: "test",
    scopes: ["tasks:read", "tasks:write", "tasks:delete"],
  })
  expect(await repo.updateAgent(member.id, id, agent.id, true)).toEqual({ status: "unchanged", result: false })
  expect(await repo.updateAgent(creator.id, id, agent.id, true)).toEqual({ status: "committed", result: true })
  expect(await repo.updateRestrictions(creator.id, id, { denyCompletion: false, denyDeletion: false, denyAgentDeletion: true }))
    .toEqual({ status: "committed", result: true })
  const agentAccess = await repo.findAccess(agent, id)
  const ownerAccess = await repo.findAccess(creator, id)
  if (!agentAccess || !ownerAccess) throw new Error("Expected both valid grants")
  expect(permitsBoardTaskAction(agentAccess, "create")).toBe(true)
  expect(permitsBoardTaskAction(agentAccess, "delete")).toBe(false)
  expect(permitsBoardTaskAction(ownerAccess, "complete")).toBe(true)
  expect(permitsBoardTaskAction(ownerAccess, "delete")).toBe(true)

  const tasks = new NamedBoardTaskRepository(db, marker)
  expect(await tasks.view(agent, id)).toMatchObject({ board: { role: "service" }, agents: [], intakes: [], members: [] })
  const inserted = await tasks.create(agent, id, { title: "Agent ticket", description: "" }, {})
  if (!inserted.ok) throw new Error("Expected an authorized agent to create a ticket")
  expect(await tasks.delete(agent, id, inserted.value.id, inserted.value.version)).toEqual({ ok: false, errorCode: "denied" })
  await updateAgentToken(agent.id, { scopes: ["tasks:read", "tasks:write:assigned"] })
  expect(await tasks.create(agent, id, { title: "Not created", description: "" }, {}))
    .toEqual({ ok: false, errorCode: "unavailable" })
  await revokeAgentToken(agent.id)
  expect(await tasks.view(agent, id)).toBeNull()
  expect(await repo.updateAgent(creator.id, id, agent.id, false)).toEqual({ status: "committed", result: true })

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
    { id: pending.resumeId, title: pending.title, acknowledgement: null },
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
    { id: pending.resumeId, title: pending.title, acknowledgement: expect.any(String) },
  ])
  expect(await refreshed.issue(sender, id, afterIssue, pending)).toEqual(prepared)
  expect(await refreshed.retry(sender, pending.resumeId, ["owner"])).toEqual(recovered)
  expect(await intake.issue(sender, id)).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit(sender, unusedPermit.value.token, input, ["owner"])).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit(sender, permit.value.token, input, ["owner"])).toEqual(accepted)
  expect(await intake.submit(sender, permit.value.token, input, ["owner"], permit.value.expiresAt)).toEqual({ ok: false, errorCode: "unavailable" })
})

test("named Board owners link Projects to shared Goals without publishing private progress or Pillars", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const tasks = new NamedBoardTaskRepository(db, marker)
  const planning = new NamedBoardPlanningRepository(db, marker)
  const workUser = { kind: "ha_user", id: "work-owner" } as const
  const homeUser = { kind: "ha_user", id: "home-owner" } as const
  const [work, home] = [await boards.create(workUser.id, "Work"), await boards.create(homeUser.id, "Home")]
  if (work.status !== "committed" || home.status !== "committed") throw new Error("Expected two Boards")
  const workBoard = work.result.id
  const homeBoard = home.result.id
  await boards.updateMember(homeUser.id, homeBoard, workUser.id, {
    role: "viewer", denyCompletion: false, denyDeletion: false,
  }, [workUser.id, homeUser.id])
  expect(await planning.save(workUser.id, homeBoard, { action: "area", title: "No unauthorized changes" })).toBe(false)
  expect(await planning.save(workUser.id, workBoard, { action: "area", title: "Work Area" })).toBe(true)
  expect(await planning.save(homeUser.id, homeBoard, { action: "area", title: "Home Area" })).toBe(true)
  const workArea = (await tasks.view(workUser, workBoard))?.planning?.areas[0]?.id
  const homeArea = (await tasks.view(homeUser, homeBoard))?.planning?.areas[0]?.id
  if (!workArea || !homeArea) throw new Error("Expected both Areas")
  expect(await planning.save(workUser.id, workBoard, {
    action: "goal", title: "Shared outcome", description: "Work details remain private", areaId: workArea,
  })).toBe(true)
  const goal = (await tasks.view(workUser, workBoard))?.planning?.goals[0]?.id
  if (!goal) throw new Error("Expected a shared Goal")
  const homeProject = { action: "project", title: "Visible Home Project", description: "", areaId: homeArea, goalId: goal } as const
  expect(await planning.save(homeUser.id, homeBoard, homeProject)).toBe(false)
  expect(await planning.save(workUser.id, workBoard, { action: "goal-share", id: goal, areaId: homeArea, enabled: true })).toBe(true)
  expect((await tasks.view(homeUser, homeBoard))?.planning?.linkableGoals).toContainEqual({
    id: goal, title: "Shared outcome", sharedAreaId: homeArea,
  })
  expect(await planning.save(homeUser.id, homeBoard, homeProject)).toBe(true)
  const visibleProjectId = (await tasks.view(homeUser, homeBoard))?.planning?.projects[0]?.id
  if (!visibleProjectId) throw new Error("Expected a Home Project")
  expect(await planning.save(homeUser.id, homeBoard, { action: "project-status", id: visibleProjectId, status: "completed" })).toBe(true)
  expect(await planning.save(workUser.id, workBoard, { action: "goal-share", id: goal, areaId: homeArea, enabled: true })).toBe(true)
  const revision = await readBoardGrantRevision(marker)
  if (!revision) throw new Error("Expected the current revision")
  const homeBefore = await readSharedGoals(db, homeUser.id, { areaId: homeArea }, revision)
  expect(homeBefore).toEqual([{ id: goal, title: "Shared outcome", area_id: homeArea, project_count: 1, completed_project_count: 1 }])
  expect(await planning.save(workUser.id, workBoard, {
    action: "project", title: "Private Work Project", description: "", areaId: workArea, goalId: goal,
  })).toBe(true)
  const privateProjectId = (await tasks.view(workUser, workBoard))?.planning?.projects[0]?.id
  if (!privateProjectId) throw new Error("Expected a Work Project")
  expect(await planning.save(workUser.id, workBoard, { action: "project-status", id: privateProjectId, status: "completed" })).toBe(true)
  expect(await readSharedGoals(db, homeUser.id, { areaId: homeArea }, revision)).toEqual(homeBefore)
  expect(await readSharedGoals(db, workUser.id, { areaId: homeArea }, revision)).toMatchObject([
    { id: goal, project_count: 2, completed_project_count: 2 },
  ])
  expect(await planning.save(workUser.id, workBoard, {
    action: "pillar", title: "Work Pillar", description: "Visible to Work only",
  })).toBe(true)
  const boardPillar = (await tasks.view(workUser, workBoard))?.planning?.pillars[0]
  if (!boardPillar) throw new Error("Expected a Board Pillar")
  expect(await planning.save(workUser.id, workBoard, {
    action: "pillar-principle", pillarId: boardPillar.id, title: "Keep this private", nonNegotiable: true,
  })).toBe(true)
  expect(await planning.save(workUser.id, workBoard, {
    action: "pillar-link", pillarId: boardPillar.id, entityType: "goal", id: goal, enabled: true,
  })).toBe(true)
  expect((await tasks.view(workUser, workBoard))?.planning?.pillars[0]).toMatchObject({
    principles: [{ statement: "Keep this private", nonNegotiable: true }],
    links: [{ id: goal, type: "goal", label: "Shared outcome" }],
  })
  expect(await planning.save(homeUser.id, homeBoard, {
    action: "pillar-link", pillarId: boardPillar.id, entityType: "task", id: goal, enabled: true,
  })).toBe(false)
  expect((await tasks.view(workUser, workBoard))?.planning?.pillars[0]).toMatchObject({ name: "Work Pillar" })
  expect((await tasks.view(homeUser, homeBoard))?.planning?.pillars).toEqual([])
  expect(await tasks.view(homeUser, workBoard)).toBeNull()
  expect(await planning.save(workUser.id, workBoard, {
    action: "routine", title: "Private Work Routine", description: "Weekly fixture",
    areaId: workArea, cadence: "weekly",
  })).toBe(true)
  const workRoutine = (await tasks.view(workUser, workBoard))?.planning?.routines[0]?.id
  if (!workRoutine) throw new Error("Expected a Work Routine")
  expect((await tasks.view(homeUser, homeBoard))?.planning?.routines).toEqual([])
  expect(await tasks.completeRoutine(homeUser, workBoard, workRoutine)).toEqual({ ok: false, errorCode: "unavailable" })
  await boards.updateMember(workUser.id, workBoard, homeUser.id, {
    role: "member", denyCompletion: true, denyDeletion: false,
  }, [workUser.id, homeUser.id])
  expect(await tasks.completeRoutine(homeUser, workBoard, workRoutine)).toEqual({ ok: false, errorCode: "denied" })
  expect(await tasks.completeRoutine(workUser, workBoard, workRoutine, "2000-01-01"))
    .toEqual({ ok: false, errorCode: "stale" })
  const [completion, completionRetry] = await Promise.all([
    tasks.completeRoutine(workUser, workBoard, workRoutine), tasks.completeRoutine(workUser, workBoard, workRoutine),
  ])
  expect(completion).toMatchObject({ ok: true, value: { id: expect.any(String) } })
  expect(completionRetry).toEqual(completion)
  if (!completion.ok) throw new Error("Expected a completed routine ticket")
  const completedTicket = (await tasks.view(workUser, workBoard))?.tasks.find(ticket => ticket.id === completion.value.id)
  if (!completedTicket) throw new Error("Expected the visible routine ticket")
  expect(await tasks.delete(homeUser, workBoard, completedTicket.id, completedTicket.version)).toEqual({ ok: false, errorCode: "denied" })
  expect(await tasks.delete(workUser, workBoard, completedTicket.id, completedTicket.version)).toEqual({ ok: false, errorCode: "denied" })
  expect(await tasks.completeRoutine(workUser, workBoard, workRoutine)).toEqual(completion)
  const legacy = new TemplateRepository(db)
  expect(await legacy.findById(workRoutine)).toBeNull()
  expect(await legacy.findRoutines()).toEqual([])
  expect((await tasks.view(workUser, workBoard))?.planning?.routines[0]).toMatchObject({ complete: true })
  await boards.updateMember(workUser.id, workBoard, homeUser.id, null, [workUser.id, homeUser.id])
  expect(await planning.saveVisibility(workUser.id, workBoard, { action: "retire", entity: "area", id: workArea }))
    .toEqual({ status: "unchanged", result: "children" })
  expect(await planning.save(homeUser.id, homeBoard, { action: "project-goal", id: visibleProjectId, goalId: null })).toBe(true)
  expect(await planning.save(homeUser.id, homeBoard, { action: "project-goal", id: visibleProjectId, goalId: goal })).toBe(true)
  expect(await planning.save(workUser.id, workBoard, { action: "retire", entity: "routine", id: workRoutine })).toBe(true)
  expect(await planning.save(workUser.id, workBoard, { action: "retire", entity: "routine", id: workRoutine })).toBe(true)
  expect((await tasks.view(workUser, workBoard))?.planning?.routines).toEqual([])
  expect((await tasks.view(workUser, workBoard))?.tasks.some(task => task.id === completion.value.id)).toBe(true)
  const preRevokeSnapshot = await readFile(marker)
  expect(await planning.save(workUser.id, workBoard, { action: "goal-share", id: goal, areaId: homeArea, enabled: false })).toBe(true)
  const latest = await readBoardGrantRevision(marker)
  expect(latest).not.toBe(revision)
  if (!latest) throw new Error("Expected a revised grant marker")
  expect(await readSharedGoals(db, homeUser.id, { areaId: homeArea }, latest)).toEqual([])
  expect(await readSharedGoals(db, homeUser.id, { projectId: visibleProjectId }, latest)).toEqual([])
  await writeFile(marker, preRevokeSnapshot)
  expect(await tasks.view(workUser, workBoard)).toBeNull()
})
