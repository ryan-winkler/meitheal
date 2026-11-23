import { startCoreRosterFixture } from "../helpers/core-roster-fixture"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { loadKanbanBoard } from "../../apps/web/src/lib/kanban-board-data"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { ScopedBoardTasks, ScopedBoardPlanning, ScopedBoardIntake, fixtureAgent } from "../helpers/scoped-board-drivers"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { createAgentToken, ensureAgentTokenSchema, revokeAgentToken, updateAgentToken } from "../../apps/web/src/domains/auth/agent-token-store"
import { boardAuthorityKey, boardViewKey } from "../../apps/web/src/lib/board-view"
import { BoardIntakeRepository } from "../../apps/web/src/domains/tasks/persistence/board-intake-repository"
import { changeBoardGrants, readBoardGrantRevision } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { NamedBoardRepository, permitsBoardTaskAction } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardPlanningRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-planning-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { readSharedGoals } from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"

let closeCore: () => Promise<void>
let directory: string
let marker: string
const originalDatabase = process.env.MEITHEAL_DB_URL

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-board-authority-"))
  marker = join(directory, "meitheal-board-grants.json")
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "meitheal.db")}`
  await ensureSchema({ markerPath: marker })
  closeCore = await startCoreRosterFixture(["owner", "parent", "child", "sender"])
})

test.afterEach(async () => {
  await closeCore()
  resetPersistenceForTests()
  if (originalDatabase === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = originalDatabase
  await rm(directory, { recursive: true, force: true })
})

test("household Calendar and Deferred queues exclude named Board tickets", async () => {
  const db = getPersistenceClient()
  await db.batch([
    "INSERT INTO task_boards (id, name, visibility, ticket_prefix, created_at, updated_at) VALUES ('work', 'Work', 'restricted', 'WORKABCD', 1, 1)",
    "INSERT INTO kanban_lanes (id, key, label, board_id, created_at, updated_at) VALUES ('work-pending', 'pending', 'Pending', 'work', 1, 1)",
    `INSERT INTO tasks (id, title, status, area_id, task_board_id, board_column_id, ticket_ref, due_date,
        idempotency_key, request_id, created_at, updated_at)
      VALUES ('work-local', 'Private scheduled ticket', 'pending', '__meitheal_no_area__', 'work', 'work-pending',
        'WORKABCD-1', '2031-07-08', 'work-local', 'work-local', 1, 1)`,
    `INSERT INTO tasks (id, title, status, area_id, task_board_id, board_column_id, ticket_ref, due_date,
        calendar_sync_state, deferred_at, idempotency_key, request_id, created_at, updated_at)
      VALUES ('work-linked', 'Private linked ticket', 'pending', '__meitheal_no_area__', 'work', 'work-pending',
        'WORKABCD-2', '2031-07-08', 'synced', 1, 'work-linked', 'work-linked', 1, 1)`,
  ], "write")
  const repo = new TaskRepository(db, await currentBoardScope(db))
  expect(await repo.getCalendarTaskCounts("2031-07-01", "2031-07-31")).toEqual({})
  expect(await repo.getLinkedCalendarEvents("2031-07-01", "2031-07-31", "Europe/Dublin")).toEqual({})
  expect(await repo.findAll({ calendarDay: "2031-07-08" })).toEqual({ tasks: [], total: 0 })
  expect(await repo.findDeferredPage(1)).toEqual({ page: 1, total: 0, tasks: [] })
})

test("new Board presets change only labels on the common four status keys", async () => {
  const db = getPersistenceClient()
  const repo = new NamedBoardRepository(db, marker)
  const cases = [
    { preset: undefined, labels: ["Backlog", "Todo", "In Progress", "Done"] },
    { preset: "standard", labels: ["Backlog", "To Do", "In Progress", "Done"] },
    { preset: "project", labels: ["Backlog", "To Do", "In Progress", "Delivered"] },
    { preset: "chores", labels: ["Backlog", "To Do", "Doing", "Checked Off"] },
  ] as const
  for (const { preset, labels } of cases) {
    const board = await repo.create(fixturePrincipal("parent"), "Preset fixture", preset)
    if (board.status !== "committed") throw new Error("Expected a newly created Board")
    const { rows } = await db.execute({
      sql: "SELECT key, label, includes FROM kanban_lanes WHERE board_id = ? ORDER BY position",
      args: [board.result.id],
    })
    expect(rows.map(row => row.label)).toEqual(labels)
    expect(rows.map(row => row.key)).toEqual(["backlog", "pending", "active", "complete"])
    expect(rows.map(row => JSON.parse(String(row.includes)))).toEqual([["backlog"], ["pending"], ["active"], ["complete"]])
    expect(await repo.findAccess({ kind: "ha_user", id: "other" }, board.result.id)).toBeNull()
  }
})

test("named grants are scoped to their Board, apply denials, and cannot remove the last active owner", async () => {
  const db = getPersistenceClient()
  const repo = new NamedBoardRepository(db, marker)
  const creator = fixturePrincipal("parent")
  const member = fixturePrincipal("child")
  const owner = await repo.create(creator, "Child projects")
  expect(owner.status).toBe("committed")
  if (owner.status !== "committed") throw new Error("Expected a new board")
  const { id } = owner.result

  expect(await repo.findAccess(fixturePrincipal("ha-owner-outside-board"), id)).toBeNull()
  expect(await repo.findAccess(creator, id)).toMatchObject({ role: "owner", name: "Child projects" })
  expect(await repo.updateMember(creator, id, creator.id, null, [creator.id, member.id]))
    .toEqual({ status: "unchanged", result: "last-owner" })
  expect(await repo.updateMember(creator, id, member.id, { role: "member", denyCompletion: true, denyDeletion: true }, [creator.id, member.id]))
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

  const agent = fixtureAgent(crypto.randomUUID())
  await ensureAgentTokenSchema()
  await createAgentToken({
    id: agent.id, name: "Fixture", tokenHash: crypto.randomUUID(), tokenPrefix: "test",
    scopes: ["tasks:read", "tasks:write", "tasks:delete"],
  })
  expect(await repo.updateAgent(member, id, agent.id, true)).toEqual({ status: "unchanged", result: false })
  expect(await repo.updateAgent(creator, id, agent.id, true)).toEqual({ status: "committed", result: true })
  expect(await repo.updateRestrictions(creator, id, { denyCompletion: false, denyDeletion: false, denyAgentDeletion: true }))
    .toEqual({ status: "committed", result: true })
  const agentAccess = await repo.findAccess(agent, id)
  const ownerAccess = await repo.findAccess(creator, id)
  if (!agentAccess || !ownerAccess) throw new Error("Expected both valid grants")
  expect(permitsBoardTaskAction(agentAccess, "create")).toBe(true)
  expect(permitsBoardTaskAction(agentAccess, "delete")).toBe(false)
  expect(permitsBoardTaskAction(ownerAccess, "complete")).toBe(true)
  expect(permitsBoardTaskAction(ownerAccess, "delete")).toBe(true)

  const tasks = new ScopedBoardTasks(db)
  expect(await tasks.view(agent, id)).toMatchObject({ board: { role: "service" }, agents: [], intakes: [], members: [] })
  const inserted = await tasks.create(agent, id, { title: "Agent ticket", description: "" }, {})
  if (!inserted.ok) throw new Error("Expected an authorized agent to create a ticket")
  expect(await tasks.delete(agent, id, inserted.value.id, inserted.value.version)).toEqual({ ok: false, errorCode: "denied" })
  await updateAgentToken(agent.id, { scopes: ["tasks:read", "tasks:write:assigned"] })
  expect(await tasks.create(agent, id, { title: "Not created", description: "" }, {}))
    .toEqual({ ok: false, errorCode: "denied" })
  await revokeAgentToken(agent.id)
  expect(await tasks.view(agent, id)).toBeNull()
  expect(await repo.updateAgent(creator, id, agent.id, false)).toEqual({ status: "committed", result: true })

})

test("a restored, absent, or replaced grant marker fails closed", async () => {
  const db = getPersistenceClient()
  const repo = new NamedBoardRepository(db, marker)
  const first = await repo.create(fixturePrincipal("owner"), "Work")
  if (first.status !== "committed") throw new Error("Expected a new board")
  const { id } = first.result
  const previous = await readFile(marker)
  const current = await repo.create(fixturePrincipal("owner"), "Home")
  expect(current.status).toBe("committed")
  const active = await readFile(marker)
  expect(active.equals(previous)).toBe(false)
  const actor = fixturePrincipal("owner")

  await writeFile(marker, previous)
  expect(await repo.findAccess(actor, id)).toBeNull()
  let called = false
  const result = await changeBoardGrants(db, actor, async () => { called = true; return { next: "" } }, marker)
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
  let interrupted = false
  const interruptionClient = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver)
      return async (...args: Parameters<typeof db.transaction>) => {
        const tx = await db.transaction(...args)
        return new Proxy(tx, {
          get(transaction, operation) {
            if (operation === "commit") return async () => {
              await transaction.commit()
              if (!interrupted) {
                interrupted = true
                await rm(marker)
                await mkdir(marker)
              }
            }
            const value = Reflect.get(transaction, operation)
            return typeof value === "function" ? value.bind(transaction) : value
          },
        })
      }
    },
  })
  const repo = new NamedBoardRepository(interruptionClient, marker)
  const creation = await repo.create(fixturePrincipal("owner"), "Work")
  expect(creation.status).toBe("committed-locked")
  if (creation.status !== "committed-locked") throw new Error("Expected a durable Board with work still locked")
  const { id } = creation.result
  const actor = fixturePrincipal("owner")
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
  const tasks = new ScopedBoardTasks(db)
  const parent = fixturePrincipal("parent")
  const child = fixturePrincipal("child")

  const createdBoard = await boards.create(parent, "Home")
  const privateBoard = await boards.create(parent, "Work")
  if (createdBoard.status !== "committed" || privateBoard.status !== "committed") throw new Error("Expected two boards")
  const home = createdBoard.result.id
  const work = privateBoard.result.id
  await boards.updateMember(parent, home, child.id, { role: "member", denyCompletion: true, denyDeletion: true }, [parent.id, child.id])
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
  await new HierarchyRepository(db, await currentBoardScope(db, home, parent)).createArea({ id: "home-area", name: "An explicit Area" })
  const created = await tasks.create(child, home, content, { areaId: "home-area" })
  if (!created.ok) throw new Error("Expected an authorized ticket")
  expect(created.value.ticket).toBe("HOME-1")
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
  expect(beforeDelete.rows[0]).toMatchObject({ area_id: "home-area" })
  expect(await tasks.delete(parent, home, task, completed.value.version)).toEqual({ ok: true, value: true })
  const afterDelete = await db.execute({ sql: "SELECT 1 FROM board_task_planning WHERE task_id = ?", args: [task] })
  expect(afterDelete.rows).toHaveLength(0)
})

test("send-only intake accepts once, returns opaque retries, and can assign without granting reads", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const intake = new ScopedBoardIntake(db)
  const sender = fixturePrincipal("sender")
  const work = await boards.create(fixturePrincipal("owner"), "Private Work")
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
  expect(await intake.issue(fixturePrincipal("other"), id)).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit(fixturePrincipal("other"), permit.value.token, input, ["owner"]))
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
  expect(fallBack).toEqual({ ok: false, errorCode: "unavailable" })
  expect((await intake.submit(sender, staleRecipientPermit.value.token, { ...input, title: "Triage instead", assignToRecipient: false }, [])).ok).toBe(true)
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
  const refreshed = new ScopedBoardIntake(db)
  expect(await refreshed.findSubmissions(sender)).toEqual([
    { id: pending.resumeId, title: pending.title, acknowledgement: null },
  ])
  const other = fixturePrincipal("other")
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
  expect(await refreshed.issue(sender, id, afterIssue, pending)).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await refreshed.retry(sender, pending.resumeId, ["owner"])).toEqual(recovered)
  expect(await intake.issue(sender, id)).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit(sender, unusedPermit.value.token, input, ["owner"])).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await intake.submit(sender, permit.value.token, input, ["owner"])).toEqual(accepted)
  expect(await intake.submit(sender, permit.value.token, input, ["owner"], permit.value.expiresAt)).toEqual({ ok: false, errorCode: "unavailable" })
})

test("named Board owners link Projects to shared Goals without publishing private progress or Pillars", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const tasks = new ScopedBoardTasks(db)
  const planning = new ScopedBoardPlanning(db, marker)
  const workUser = fixturePrincipal("work-owner")
  const homeUser = fixturePrincipal("home-owner")
  const [work, home] = [await boards.create(workUser, "Work"), await boards.create(homeUser, "Home")]
  if (work.status !== "committed" || home.status !== "committed") throw new Error("Expected two Boards")
  const workBoard = work.result.id
  const homeBoard = home.result.id
  await boards.updateMember(homeUser, homeBoard, workUser.id, {
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
  await boards.updateMember(homeUser, homeBoard, workUser.id, { role: "owner", denyCompletion: false, denyDeletion: false }, [workUser.id, homeUser.id])
  expect(await planning.save(workUser.id, workBoard, { action: "goal-share", id: goal, areaId: homeArea, enabled: true })).toBe(true)
  expect((await tasks.view(homeUser, homeBoard))?.planning?.linkableGoals).toContainEqual({
    id: goal, title: "Shared outcome", sharedAreaId: null,
  })
  expect(await planning.save(homeUser.id, homeBoard, homeProject)).toBe(true)
  const visibleProjectId = (await tasks.view(homeUser, homeBoard))?.planning?.projects[0]?.id
  if (!visibleProjectId) throw new Error("Expected a Home Project")
  expect(await planning.save(homeUser.id, homeBoard, { action: "project-status", id: visibleProjectId, status: "completed" })).toBe(true)
  expect(await planning.save(workUser.id, workBoard, { action: "goal-share", id: goal, areaId: homeArea, enabled: true })).toBe(true)
  const revision = await readBoardGrantRevision(marker)
  if (!revision) throw new Error("Expected the current revision")
  const homeBefore = await readSharedGoals(db, await currentBoardScope(db, homeBoard, homeUser), { areaId: homeArea })
  expect(homeBefore).toEqual([{ id: goal, title: "Shared outcome", area_id: homeArea, project_count: 1, completed_project_count: 1 }])
  expect(await planning.save(workUser.id, workBoard, {
    action: "project", title: "Private Work Project", description: "", areaId: workArea, goalId: goal,
  })).toBe(true)
  const privateProjectId = (await tasks.view(workUser, workBoard))?.planning?.projects[0]?.id
  if (!privateProjectId) throw new Error("Expected a Work Project")
  expect(await planning.save(workUser.id, workBoard, { action: "project-status", id: privateProjectId, status: "completed" })).toBe(true)
  expect(await readSharedGoals(db, await currentBoardScope(db, homeBoard, homeUser), { areaId: homeArea })).toEqual(homeBefore)
  expect(await readSharedGoals(db, await currentBoardScope(db, homeBoard, workUser), { areaId: homeArea })).toMatchObject([
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
  await boards.updateMember(workUser, workBoard, homeUser.id, {
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
  expect(await tasks.edit(workUser, workBoard, completedTicket.id, completedTicket.version, { dueDate: null }))
    .toMatchObject({ ok: false, errorCode: "stale" })
  await boards.updateRestrictions(workUser, workBoard, { denyCompletion: false, denyDeletion: true, denyAgentDeletion: true })
  expect(await tasks.delete(homeUser, workBoard, completedTicket.id, completedTicket.version)).toEqual({ ok: false, errorCode: "denied" })
  expect(await tasks.delete(workUser, workBoard, completedTicket.id, completedTicket.version)).toEqual({ ok: false, errorCode: "denied" })
  expect(await tasks.completeRoutine(workUser, workBoard, workRoutine)).toEqual(completion)
  const legacy = new TemplateRepository(db, await currentBoardScope(db))
  expect(await legacy.findById(workRoutine)).toBeNull()
  expect(await legacy.findRoutines()).toEqual([])
  expect((await tasks.view(workUser, workBoard))?.planning?.routines[0]).toMatchObject({ complete: true })
  await boards.updateRestrictions(workUser, workBoard, { denyCompletion: false, denyDeletion: false, denyAgentDeletion: true })
  await boards.updateMember(workUser, workBoard, homeUser.id, null, [workUser.id, homeUser.id])
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
  expect(await readSharedGoals(db, await currentBoardScope(db, homeBoard, homeUser), { areaId: homeArea })).toEqual([])
  expect(await readSharedGoals(db, await currentBoardScope(db, homeBoard, homeUser), { projectId: visibleProjectId })).toEqual([])
  await writeFile(marker, preRevokeSnapshot)
  expect(await tasks.view(workUser, workBoard)).toBeNull()
})

test("workspace groups, Projects and task filing stay within the owning Board", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const planning = new ScopedBoardPlanning(db, marker)
  const tasks = new ScopedBoardTasks(db)
  const actor = fixturePrincipal("owner")
  const work = await boards.create(actor, "Work")
  const house = await boards.create(actor, "House")
  if (work.status !== "committed" || house.status !== "committed") throw new Error("Expected both Boards")
  const board = work.result.id
  const other = house.result.id
  expect(await planning.save(actor.id, board, { action: "area", title: "Operations", icon: "🛠", color: "#abcdef" })).toBe(true)
  expect(await planning.save(actor.id, other, { action: "area", title: "Yard" })).toBe(true)
  const group = (await tasks.groups(actor, board, null))!.items[0]!
  const foreign = (await tasks.groups(actor, other, null))!.items[0]!
  expect(group.name).toBe("Operations")
  expect(await tasks.groups(actor, board, null, group.id)).toMatchObject({ selected: { id: group.id, name: "Operations" } })
  expect(await tasks.groups(actor, board, null, foreign.id)).toMatchObject({ selected: null })
  await db.batch(Array.from({ length: 31 }, (_, index) => ({
    sql: "INSERT INTO areas (id, name, owner_board_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)",
    args: ["extra-group-" + index, "Group " + index, board, index + 1],
  })), "write")
  const firstGroups = await tasks.groups(actor, board, null)
  expect(firstGroups?.items).toHaveLength(30)
  expect(firstGroups?.next_cursor).toBeTruthy()
  const lastGroups = await tasks.groups(actor, board, firstGroups!.next_cursor)
  expect(lastGroups?.items).toHaveLength(2)
  expect(lastGroups?.next_cursor).toBeNull()
  expect(new Set([...firstGroups!.items, ...lastGroups!.items].map(item => item.id)).size).toBe(32)
  expect(await tasks.groups(fixturePrincipal("outsider"), board, null)).toBeNull()
  expect(await planning.save(actor.id, board, { action: "project", title: "Handoff", description: "", areaId: group.id, goalId: null })).toBe(true)
  const directory = await tasks.view(actor, board)
  expect(directory?.planning?.areas).toContainEqual({ id: group.id, name: group.name, icon: "🛠", color: "#abcdef" })
  const project = directory!.planning!.projects[0]!
  const workspace = { areaId: group.id, projectId: null, ticketId: null, planning: false }
  const ordinary = await tasks.create(actor, board, {
    title: "Write a handoff", description: "", dueDate: "2026-11-17",
  }, { local: true })
  if (!ordinary.ok) throw new Error("Expected an unfiled task")

  expect(await tasks.view(actor, board, 0, workspace)).toMatchObject({
    planning: null, context: { area: { id: group.id, name: group.name }, project: null }, tasks: [],
  })
  expect(await tasks.view(actor, board, 0, { ...workspace, areaId: foreign.id })).toBeNull()
  expect(await tasks.create(actor, board, { title: "Foreign placement", description: "" }, { local: true, areaId: foreign.id }))
    .toMatchObject({ ok: false, errorCode: "unavailable" })
  expect(await tasks.file(actor, board, ordinary.value.id, ordinary.value.version, foreign.id, null))
    .toMatchObject({ ok: false, errorCode: "stale" })
  const filed = await tasks.file(actor, board, ordinary.value.id, ordinary.value.version, group.id, project.id)
  expect(filed.ok).toBe(true)
  expect(await tasks.file(actor, board, ordinary.value.id, ordinary.value.version, null, null))
    .toMatchObject({ ok: false, errorCode: "stale" })
  expect((await tasks.view(actor, board, 0, { ...workspace, projectId: project.id }))?.tasks)
    .toMatchObject([{ id: ordinary.value.id, ticket: ordinary.value.ticket, dueDate: "2026-11-17" }])
  if (!filed.ok) throw new Error("Expected the task to be filed")
  expect(await tasks.dueWork(actor, board, "2026-11-16")).toEqual([])
  expect(await tasks.dueWork(fixturePrincipal("outsider"), board, "2026-11-17")).toEqual([])
  expect(await tasks.dueWork(fixtureAgent(actor.id), board, "2026-11-17")).toEqual([])
  expect(await tasks.dueWork(actor, board, "2026-11-17")).toMatchObject([
    { id: ordinary.value.id, title: "Write a handoff", dueDate: "2026-11-17", boardId: board, boardName: "Work" },
  ])
  const cleared = await tasks.edit(actor, board, ordinary.value.id, filed.value.version, { dueDate: null })
  expect(cleared.ok).toBe(true)
  expect((await tasks.view(actor, board, 0, { ...workspace, projectId: project.id }))?.tasks)
    .toMatchObject([{ id: ordinary.value.id, title: "Write a handoff", dueDate: null }])
})


test("Project Routine check-ins retain placement, completion identity, and current Board authority", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const planning = new ScopedBoardPlanning(db, marker)
  const tasks = new ScopedBoardTasks(db)
  const owner = fixturePrincipal("routine-owner")
  const outsider = fixturePrincipal("routine-outsider")
  const created = await boards.create(owner, "Project routines")
  if (created.status !== "committed") throw new Error("Expected Board")
  const board = created.result.id
  expect(await planning.save(owner.id, board, { action: "area", title: "Operations" })).toBe(true)
  const area = (await tasks.view(owner, board))!.planning!.areas[0]!.id
  expect(await planning.save(owner.id, board, { action: "project", title: "House checks", description: "", areaId: area, goalId: null })).toBe(true)
  const project = (await tasks.view(owner, board))!.planning!.projects[0]!.id
  await expect(planning.save(owner.id, board, {
    action: "routine", title: "Inspect filters", description: "", areaId: area, projectId: "foreign", cadence: "daily",
  })).rejects.toThrow("Template Project is unavailable")
  expect(await planning.save(owner.id, board, {
    action: "routine", title: "Inspect filters", description: "", areaId: area, projectId: project, cadence: "daily",
  })).toBe(true)
  const routine = (await tasks.view(owner, board))!.planning!.routines[0]!
  expect(routine.projectId).toBe(project)
  expect(await tasks.routineLibrary(outsider, board)).toEqual([])
  expect(await tasks.routineLibrary(owner, board)).toMatchObject([{ id: routine.id, canComplete: true, complete: false }])
  expect(await planning.save(owner.id, board, {
    action: "routine", id: routine.id, title: "Inspect filters again", description: "Updated", areaId: area, cadence: "daily",
  })).toBe(true)
  expect((await tasks.view(owner, board))!.planning!.routines[0]!.projectId).toBe(project)
  const completion = await tasks.completeRoutine(owner, board, routine.id, routine.period)
  if (!completion.ok) throw new Error("Expected check-in")
  const placement = await db.execute({ sql: "SELECT area_id, project_id FROM board_task_planning WHERE task_id = ?", args: [completion.value.id] })
  expect(placement.rows[0]).toMatchObject({ area_id: area, project_id: project })
  expect(await tasks.routineLibrary(owner, board)).toMatchObject([{ id: routine.id, complete: true }])
  expect(await planning.save(owner.id, board, { action: "project-status", id: project, status: "completed" })).toBe(true)
  expect(await tasks.completeRoutine(owner, board, routine.id, routine.period)).toEqual(completion)
  expect(await tasks.routineLibrary(owner, board)).toMatchObject([{ id: routine.id, canComplete: false }])
  expect(await boards.updateMember(owner, board, outsider.id, { role: "viewer", denyCompletion: false, denyDeletion: false }, [owner.id, outsider.id])).toMatchObject({ result: "saved" })
  expect(await tasks.routineLibrary(outsider, board)).toMatchObject([{ id: routine.id, canComplete: false }])
  expect(await tasks.completeRoutine(outsider, board, routine.id, routine.period)).toEqual({ ok: false, errorCode: "denied" })
  expect(await boards.updateMember(owner, board, outsider.id, null, [owner.id, outsider.id])).toMatchObject({ result: "saved" })
  expect(await tasks.routineLibrary(outsider, board)).toEqual([])
})

test("named Kanban filters the authorized index before per-lane paging and keeps versions fenced", async () => {
  const db = getPersistenceClient()
  const boards = new NamedBoardRepository(db, marker)
  const tasks = new ScopedBoardTasks(db)
  const parent = fixturePrincipal("parent")
  const child = fixturePrincipal("child")
  const created = await boards.create(parent, "Paged private work")
  if (created.status !== "committed") throw new Error("Expected Board")
  const id = created.result.id
  await boards.updateMember(parent, id, child.id, { role: "member", denyCompletion: true, denyDeletion: true }, [parent.id, child.id])
  const { rows: lanes } = await db.execute({ sql: "SELECT id, key FROM kanban_lanes WHERE board_id = ?", args: [id] })
  const pending = String(lanes.find(lane => lane.key === "pending")!.id)
  const active = String(lanes.find(lane => lane.key === "active")!.id)
  const done = String(lanes.find(lane => lane.key === "complete")!.id)
  const ids: string[] = []
  for (let index = 0; index < 56; index++) {
    const ticket = await tasks.create(parent, id, { title: `Work ${index}`, description: index === 0 ? "Needle in oldest details" : "Private details" }, { laneId: pending })
    if (!ticket.ok) throw new Error("Expected ticket")
    ids.push(ticket.value.id)
  }
  const selection = { areaId: null, projectId: null, ticketId: null, planning: false }
  const shared = new TaskRepository(db, await currentBoardScope(db, id, child))
  const commonLanes = await shared.getKanbanLanes()
  const first = await tasks.view(child, id, 0, selection)
  const firstPages = await loadKanbanBoard(shared, commonLanes, 0, new URLSearchParams())
  expect(firstPages.get("pending")).toMatchObject({ total: 56, matches: 56, page: 1, pageCount: 3 })
  expect(firstPages.get("pending")!.cards).toHaveLength(25)
  const lastPages = await loadKanbanBoard(shared, commonLanes, 0, new URLSearchParams("kp.pending=3"))
  expect(lastPages.get("pending")!.cards).toHaveLength(6)
  expect(new Set([...firstPages.get("pending")!.cards, ...lastPages.get("pending")!.cards].map(task => task.id)).size).toBe(31)
  const filtered = await loadKanbanBoard(shared, commonLanes, 0, new URLSearchParams("search=Needle"))
  expect(filtered.get("pending")!.cards.map(task => task.id)).toEqual([ids[0]])
  const matched = filtered.get("pending")!.cards[0]!
  const task = { id: matched.id, version: Number(matched.task_version) }
  expect(await tasks.move(child, id, task.id, done, task.version)).toMatchObject({ ok: false, errorCode: "denied" })
  expect(await tasks.delete(child, id, task.id, task.version)).toMatchObject({ ok: false, errorCode: "denied" })
  const moved = await tasks.move(child, id, task.id, active, task.version)
  expect(moved.ok).toBe(true)
  const refreshed = await tasks.view(child, id, 0, selection, undefined, { params: new URLSearchParams() })
  expect(boardAuthorityKey(first!, child.id)).toBe(boardAuthorityKey(refreshed!, child.id))
  const refreshedPages = await loadKanbanBoard(shared, commonLanes, 0, new URLSearchParams())
  expect(boardViewKey([...firstPages], child.id)).not.toBe(boardViewKey([...refreshedPages], child.id))
  expect(await tasks.edit(child, id, task.id, task.version, { title: "Stale overwrite" })).toMatchObject({ ok: false, errorCode: "stale" })
  await boards.updateMember(parent, id, child.id, null, [parent.id, child.id])
  expect(await tasks.view(child, id, 0, selection, undefined, { params: new URLSearchParams() })).toBeNull()
  expect(await tasks.edit(child, id, task.id, moved.ok ? moved.value.version : task.version, { title: "Revoked overwrite" })).toMatchObject({ ok: false, errorCode: "unavailable" })
})

test("omitted named repository markers use the explicit startup context for planning, Goal tickets, sidebar and intake", async () => {
  const db = getPersistenceClient()
  // Route adapters construct these repositories without a marker argument.
  const boards = new NamedBoardRepository(db)
  const planning = new ScopedBoardPlanning(db)
  const tasks = new ScopedBoardTasks(db)
  const intake = new ScopedBoardIntake(db)
  const owner = fixturePrincipal("context-owner")
  const sender = fixturePrincipal("context-sender")
  const created = await boards.create(owner, "Explicit context")
  if (created.status !== "committed") throw new Error("Expected current explicit-context Board")
  const board = created.result.id
  expect(await boards.findAccess(owner, board)).toMatchObject({ role: "owner", state: "active" })
  expect(await planning.save(owner.id, board, { action: "area", title: "Context Area" })).toBe(true)
  const area = (await tasks.view(owner, board))!.planning!.areas[0]!.id
  expect(await planning.save(owner.id, board, { action: "goal", title: "Context Goal", description: "", areaId: area })).toBe(true)
  const goal = (await tasks.view(owner, board))!.planning!.goals[0]!.id
  expect(await planning.save(owner.id, board, { action: "project", title: "Context Project", description: "", areaId: area, goalId: goal })).toBe(true)
  const project = (await tasks.view(owner, board))!.planning!.projects[0]!.id
  const ticket = await tasks.create(owner, board, { title: "Context Goal ticket", description: "" }, { areaId: area, projectId: project, goalId: goal })
  if (!ticket.ok) throw new Error("Expected a named ticket through the route's omitted-marker adapter")
  expect((await db.execute({ sql: "SELECT area_id, project_id, goal_id FROM board_task_planning WHERE task_id = ?", args: [ticket.value.id] })).rows)
    .toEqual([{ area_id: area, project_id: project, goal_id: goal }])
  expect(await tasks.edit(owner, board, ticket.value.id, ticket.value.version, { title: "Updated context ticket", description: "" })).toMatchObject({ ok: true })
  expect(await boards.setSidebarHidden(owner, board, true)).toBe(true)
  expect((await db.execute({ sql: "SELECT board_id FROM board_sidebar_preferences WHERE ha_user_id = ?", args: [owner.id] })).rows).toEqual([{ board_id: board }])
  const lane = String((await db.execute({ sql: "SELECT id FROM kanban_lanes WHERE board_id = ? AND key = 'pending'", args: [board] })).rows[0]!.id)
  const destination = await intake.create(owner.id, board, { label: "Context intake", laneId: lane, senders: [sender] })
  if (destination.status !== "committed" || !destination.result) throw new Error("Expected context intake")
  const permit = await intake.issue(sender, destination.result.id)
  if (!permit.ok) throw new Error("Expected context-bound sender permit")
  expect(await intake.submit(sender, permit.value.token, { title: "Context receipt", description: "", assignToRecipient: false }, []))
    .toMatchObject({ ok: true })
  expect(await new ScopedBoardPlanning(db, join(directory, "foreign-marker.json")).save(owner.id, board, { action: "area", title: "Denied foreign path" })).toBe(false)

  await rm(marker)
  expect(await planning.save(owner.id, board, { action: "area", title: "Denied after marker loss" })).toBe(false)
  expect(await tasks.create(owner, board, { title: "Denied ticket", description: "" }, { goalId: goal })).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await boards.setSidebarHidden(owner, board, false)).toBe(false)
  expect(await intake.issue(sender, destination.result.id)).toEqual({ ok: false, errorCode: "unavailable" })
  expect(await tasks.view(owner, board)).toBeNull()
})
