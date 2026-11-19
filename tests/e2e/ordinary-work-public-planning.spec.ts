import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { openDatabaseForStartup, withStartupWriteTransaction } from "../../apps/web/scripts/database-client.mjs"
import { applyStartupTaskSchema } from "../../apps/web/scripts/task-schema-startup.mjs"
import { initializeBoardGrantContinuity, finalizeStartupBoardGrant } from "../../apps/web/scripts/board-grant-journal.mjs"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { projectPublicTaskFields } from "../../apps/web/src/domains/tasks/task-projection"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { withOrganizationAvailability } from "../../apps/web/src/lib/organization-request-context"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { changeGoalShare } from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { GET as taskDetail } from "../../apps/web/src/pages/api/tasks/[id]"
import { GET as taskList } from "../../apps/web/src/pages/api/tasks/index"

const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
let directory: string, previousUrl: string | undefined
const context = (boardId: string, userId: string, id?: string) => {
  const url = new URL(id ? `http://localhost/api/tasks/${id}` : "http://localhost/api/tasks")
  return { request: new Request(url, { headers: { "X-Meitheal-Board-Id": boardId, "X-Meitheal-Board-Session": boardSessionProof(userId) } }), url, params: id ? { id } : {}, locals: {} } as Parameters<typeof taskDetail>[0]
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-public-planning-"))
  previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
for (const encoding of ["legacy", "scoped"] as const) {
  test(`public planning identifiers hide retirement while physical history still enforces its audience: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!principal) throw new Error("Actual admitted operator required")
      const db = getPersistenceClient(), boards = new NamedBoardRepository(db)
      const named = await boards.create(principal, "Work")
      if (named.status !== "committed") throw new Error("Board creation failed")
      const boardId = encoding === "legacy" ? "household" : named.result.id
      const current = async () => {
        const result = await new BoardAccessService(db).resolve(principal, boardId, { resource: "task", action: "create" })
        if (!result.ok) throw new Error(result.errorCode)
        return result.scope
      }
      let scope = await current(), hierarchy = new HierarchyRepository(db, scope)
      const areaId = crypto.randomUUID(), projectId = crypto.randomUUID(), goalId = crypto.randomUUID()
      await hierarchy.createArea({ id: areaId, name: "Private parent audience" })
      expect(await hierarchy.createGoal({ id: goalId, title: "Goal", area_id: areaId })).toBe(true)
      expect(await hierarchy.createProject({ id: projectId, title: "Project", area_id: areaId, goal_id: goalId })).toBe(true)
      const prepared = await prepareTaskCreation(new TaskRepository(db, scope), { title: "Retain physical history", area_id: areaId, project_id: projectId, goal_id: goalId }, { useDefaultAssignee: false })
      if (!prepared.ok) throw new Error(prepared.error)
      const created = await new TaskRepository(db, scope).createWorkCommand(prepared.task)
      if (!created.ok) throw new Error(created.errorCode)
      expect(created.task).toMatchObject({ area_id: areaId, project_id: projectId, goal_id: goalId, public_area_id: areaId, public_project_id: projectId, public_goal_id: goalId })
      const readDetail = async () => {
        const response = await taskDetail(context(boardId, principal.id, created.task.id))
        expect(response.status, await response.clone().text()).toBe(200)
        return response.json()
      }
      expect(await readDetail()).toMatchObject({ area_id: areaId, project_id: projectId, goal_id: goalId })
      expect(await hierarchy.deleteProject(projectId)).toBe(true)
      scope = await current(); hierarchy = new HierarchyRepository(db, scope)
      const retained = await new TaskRepository(db, scope).findById(created.task.id)
      expect(retained).toMatchObject({ project_id: projectId, public_project_id: null, area_id: areaId, goal_id: goalId })
      expect(await readDetail()).toMatchObject({ project_id: null, area_id: areaId, goal_id: goalId })
      const listed = await taskList(context(boardId, principal.id))
      expect(listed.status).toBe(200)
      expect((await listed.json()).tasks).toEqual([expect.objectContaining({ id: created.task.id, project_id: null })])
      expect(await hierarchy.deleteGoal(goalId)).toBe(true)
      scope = await current(); hierarchy = new HierarchyRepository(db, scope)
      expect(await hierarchy.deleteArea(areaId)).toBe(true)
      scope = await current()
      const repo = new TaskRepository(db, scope)
      expect(await repo.findById(created.task.id)).toMatchObject({ area_id: areaId, project_id: projectId, goal_id: goalId, public_area_id: null, public_project_id: null, public_goal_id: null })
      const publicTask = await readDetail()
      expect(publicTask).toMatchObject({ area_id: null, project_id: null, goal_id: null })
      expect(Object.keys(publicTask).some(key => key.startsWith("public_"))).toBe(false)
      // Retirement does not erase the old Area audience or historical references.
      await changeBoardGrants(db, async tx => {
        await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('group',?,?,'nobody','[]',1)", args: [areaId, boardId] })
        return { next: true }
      })
      scope = await current()
      expect(await new TaskRepository(db, scope).findById(created.task.id)).toBeNull()
      expect((await taskDetail(context(boardId, principal.id, created.task.id))).status).toBe(404)
      const physical = encoding === "legacy" ? await db.execute("SELECT area_id,project_id,goal_id FROM tasks WHERE id=?", [created.task.id]) : await db.execute("SELECT area_id,project_id,goal_id FROM board_task_planning WHERE task_id=?", [created.task.id])
      expect(physical.rows[0]).toMatchObject({ area_id: areaId, project_id: projectId, goal_id: goalId })
    })
  })
  test(`eligible incoming shared Goal remains a public association: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const principal = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!principal) throw new Error("Actual admitted operator required")
      const db = getPersistenceClient(), boards = new NamedBoardRepository(db)
      const work = await boards.create(principal, "Private Work"), home = await boards.create(principal, "Home")
      if (work.status !== "committed" || home.status !== "committed") throw new Error("Board creation failed")
      const boardId = encoding === "legacy" ? "household" : home.result.id
      const current = async (id: string) => {
        const result = await new BoardAccessService(db).resolve(principal, id, { resource: "task", action: "create" })
        if (!result.ok) throw new Error(result.errorCode)
        return result.scope
      }
      let source = await current(work.result.id)
      const goalId = crypto.randomUUID()
      expect(await new HierarchyRepository(db, source).createGoal({ id: goalId, title: "Shared outcome", description: "Private Work narrative" })).toBe(true)
      expect(await changeGoalShare(db, source, goalId, { kind: "board", boardId }, true)).toMatchObject({ result: "saved" })
      const receiver = await current(boardId), repo = new TaskRepository(db, receiver)
      const prepared = await prepareTaskCreation(repo, { title: "Home contribution", goal_id: goalId }, { useDefaultAssignee: false })
      if (!prepared.ok) throw new Error(prepared.error)
      const created = await repo.createWorkCommand(prepared.task)
      if (!created.ok) throw new Error(created.errorCode)
      expect(created.task).toMatchObject({ goal_id: goalId, public_goal_id: goalId })
      const response = await taskDetail(context(boardId, principal.id, created.task.id))
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.goal_id).toBe(goalId)
      expect(JSON.stringify(body)).not.toContain("Private Work narrative")
    })
  })
}

test("known-current25 foreign planning references stay physical and never become public IDs after conversion", async () => {
  resetPersistenceForTests()
  const database = join(directory, "known-current25.db"), markerPath = database + ".board-grants.json"
  process.env.MEITHEAL_DB_URL = `file:${database}`
  const predecessor = await openDatabaseForStartup(`file:${database}`, { markerPath })
  let revision: string | null = null
  try {
    await withStartupWriteTransaction(predecessor, async tx => {
      await applyStartupTaskSchema(tx)
      await tx.batch([
        "INSERT INTO task_boards(id,name,visibility,ticket_prefix,created_at,updated_at) VALUES('old-work','Work fixture','restricted','WORKABCD',1,1)",
        "INSERT INTO board_permissions(board_id) VALUES('old-work')",
        "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role) VALUES('old-work','ha_user','work-owner','owner')",
        "INSERT INTO areas(id,name,created_at,updated_at) VALUES('home-area','Home Area',1,1)",
        "INSERT INTO goals(id,title,area_id,created_at,updated_at) VALUES('home-goal','Home Goal','home-area',1,1)",
        "INSERT INTO projects(id,title,area_id,goal_id,created_at,updated_at) VALUES('home-project','Home Project','home-area','home-goal',1,1)",
        "INSERT INTO areas(id,name,owner_board_id,created_at,updated_at) VALUES('work-area','Private Work Area','old-work',1,1)",
        "INSERT INTO goals(id,title,area_id,owner_board_id,created_at,updated_at) VALUES('work-goal','Private Work Goal','work-area','old-work',1,1)",
        "INSERT INTO projects(id,title,area_id,goal_id,owner_board_id,created_at,updated_at) VALUES('work-project','Private Work Project','work-area','work-goal','old-work',1,1)",
        "INSERT INTO tasks(id,title,area_id,project_id,goal_id,idempotency_key,request_id,created_at,updated_at) VALUES('old-home-task','Home Task','work-area','work-project','work-goal','home','home',1,1)",
        "INSERT INTO kanban_lanes(id,key,label,board_id,created_at,updated_at) VALUES('work-pending','pending','Pending','old-work',1,1)",
        "INSERT INTO tasks(id,title,task_board_id,board_column_id,ticket_ref,area_id,idempotency_key,request_id,created_at,updated_at) VALUES('old-work-task','Work Task','old-work','work-pending','WORKABCD-1','__meitheal_no_area__','work','work',1,1)",
        "INSERT INTO board_task_planning(task_id,area_id,project_id,goal_id) VALUES('old-work-task','home-area','home-project','home-goal')",
      ])
      revision = await initializeBoardGrantContinuity(predecessor, tx)
    })
    if (!revision) throw new Error("Independent current25 authority required")
    await finalizeStartupBoardGrant(predecessor, revision)
  } finally { predecessor.close() }
  await ensureSchema({ markerPath })
  const db = getPersistenceClient()
  for (const [boardId, ownerId, taskId, prefix] of [["household", "home-owner", "old-home-task", "work"], ["old-work", "work-owner", "old-work-task", "home"]] as const) {
    const scope = await currentBoardScope(db, boardId, fixturePrincipal(ownerId)), repo = new TaskRepository(db, scope)
    const task = await repo.findById(taskId)
    expect(task).toMatchObject({ area_id: `${prefix}-area`, project_id: `${prefix}-project`, goal_id: `${prefix}-goal`, public_area_id: null, public_project_id: null, public_goal_id: null })
    expect(projectPublicTaskFields(task!)).toMatchObject({ area_id: null, project_id: null, goal_id: null })
    const list = await repo.findAll({})
    expect(list.tasks).toHaveLength(1)
    expect(projectPublicTaskFields(list.tasks[0]!)).toMatchObject({ id: taskId, area_id: null, project_id: null, goal_id: null })
    expect(JSON.stringify(projectPublicTaskFields(task!))).not.toContain("Private Work")
  }
  expect((await db.execute("SELECT area_id,project_id,goal_id FROM tasks WHERE id='old-home-task'")).rows[0]).toMatchObject({ area_id: "work-area", project_id: "work-project", goal_id: "work-goal" })
  expect((await db.execute("SELECT area_id,project_id,goal_id FROM board_task_planning WHERE task_id='old-work-task'")).rows[0]).toMatchObject({ area_id: "home-area", project_id: "home-project", goal_id: "home-goal" })
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toEqual([])
})

for (const encoding of ["legacy", "scoped"] as const) {
  test(`common sidebar Project paging returns 30 then 60 then 65 without foreign cursors: ${encoding}`, async () => {
    const db = getPersistenceClient(), principal = fixturePrincipal("page-owner")
    const created = await new NamedBoardRepository(db).create(principal, "Workshop")
    if (created.status !== "committed") throw new Error("Board creation failed")
    const boardId = encoding === "legacy" ? "household" : created.result.id
    const scope = await currentBoardScope(db, boardId, principal), hierarchy = new HierarchyRepository(db, scope)
    const areaId = crypto.randomUUID(), otherAreaId = crypto.randomUUID()
    await hierarchy.createArea({ id: areaId, name: "Workbench" })
    await hierarchy.createArea({ id: otherAreaId, name: "Other" })
    const ids = Array.from({ length: 65 }, (_, index) => `page-project-${String(index).padStart(2, "0")}`)
    await db.batch(ids.map((id, index) => ({ sql: "INSERT INTO projects(id,title,area_id,owner_board_id,position,created_at,updated_at) VALUES(?,?,?,?,?,1,1)",
      args: [id, `Project ${String(index).padStart(2, "0")}`, areaId, encoding === "legacy" ? null : boardId, Math.floor(index / 10)] })), "write")
    expect(await hierarchy.createProject({ id: "outside-page", title: "Outside", area_id: otherAreaId })).toBe(true)
    const first = await hierarchy.findProjectPage(areaId, null, ids[64]!)
    expect(first?.items.map(item => item.id)).toEqual(ids.slice(0, 30))
    expect(first?.selected).toEqual({ id: ids[64], name: "Project 64" })
    const second = await hierarchy.findProjectPage(areaId, first!.next_cursor)
    expect(second?.items.map(item => item.id)).toEqual(ids.slice(30, 60))
    const third = await hierarchy.findProjectPage(areaId, second!.next_cursor)
    expect(third?.items.map(item => item.id)).toEqual(ids.slice(60))
    expect(third?.next_cursor).toBeNull()
    expect(await hierarchy.findProjectPage(areaId, "outside-page")).toBeNull()
    expect(await hierarchy.findProjectPage(areaId, "missing-cursor")).toBeNull()
    expect((await hierarchy.findProjectPage(areaId, null, "outside-page"))?.selected).toBeNull()
    const facade = new NamedBoardTaskRepository(db, scope)
    expect(await facade.projects(principal, boardId, areaId, null, ids[64]!)).toEqual(first)
    for (const hidden of ["groups", "projects"] as const) {
      expect(await withOrganizationAvailability({ locked: false, needsVerification: false, includes: feature => feature !== hidden, revision: () => null },
        () => facade.projects(principal, boardId, areaId, null))).toBeNull()
    }
  })
}
