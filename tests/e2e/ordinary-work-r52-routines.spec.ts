import { mkdtemp, rm } from "node:fs/promises"
import { mock } from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TemplateRepository, routinePeriod } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { boardSessionProof } from "../../apps/web/src/lib/named-board-request"
import { GET as routines } from "../../apps/web/src/pages/api/boards/routines"
import { POST as habits } from "../../apps/web/src/pages/api/habits"
import { PUT as updateTask } from "../../apps/web/src/pages/api/tasks/[id]"
import { getTasksForView } from "../../apps/web/src/lib/task-queries"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"

let directory: string, previousUrl: string | undefined
const transport = { peer: "127.0.0.1", fromSupervisor: false, identityHeadersSafe: true, configuredPath: undefined }
function gate() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve }); return { wait, release } }
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-r52-common-")); previousUrl = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "work.db")}`; await ensureSchema()
})
test.afterEach(async () => {
  mock.timers.reset()
  resetPersistenceForTests()
  if (previousUrl === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previousUrl
  await rm(directory, { recursive: true, force: true })
})
async function board(encoding: "legacy" | "scoped", owner = fixturePrincipal()) {
  const created = await new NamedBoardRepository(getPersistenceClient()).create(owner, "Workshop")
  if (created.status !== "committed") throw new Error("Board creation failed")
  return encoding === "legacy" ? "household" : created.result.id
}
async function add(repo: TaskRepository, body: Record<string, unknown>) {
  const prepared = await prepareTaskCreation(repo, body, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  const result = await repo.createWorkCommand(prepared.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}
function context(boardId: string, userId: string, path: string, body?: unknown, id?: string) {
  const url = new URL(`http://localhost${path}`)
  return { url, params: id ? { id } : {}, locals: {}, request: new Request(url, { ...(body === undefined ? {} : { method: id ? "PUT" : "POST", body: JSON.stringify(body) }), headers: {
    "Content-Type": "application/json", "X-Meitheal-Board-Id": boardId, "X-Meitheal-Board-Session": boardSessionProof(userId),
  } }) } as unknown as Parameters<typeof routines>[0]
}
for (const encoding of ["legacy", "scoped"] as const) {
  test(`Routine library and check-in need no Project/Organizer catalogue; delete acknowledges journal commit: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!owner) throw new Error("Operator required")
      const db = getPersistenceClient(), boardId = await board(encoding, owner)
      let scope = await currentBoardScope(db, boardId, owner)
      const hierarchy = new HierarchyRepository(db, scope), templates = new TemplateRepository(db, scope)
      const projectId = crypto.randomUUID(), areaId = crypto.randomUUID(); await hierarchy.createArea({ id: areaId, name: "Routine Area" }); await hierarchy.createProject({ id: projectId, title: "Private implementation detail", area_id: areaId })
      const standalone = crypto.randomUUID(), linked = crypto.randomUUID()
      for (const id of [standalone, linked]) expect(await templates.create({ id, name: "Routine", templateJson: JSON.stringify({ title: "Routine work" }), icon: "R", position: 0, isRoutine: true, ...(id === linked ? { projectId } : {}) })).toBe(true)
      await changeBoardGrants(db, owner, async tx => {
        await tx.execute("INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('feature','projects','','nobody','[]',1),('feature','organizer','','nobody','[]',1)")
        return { next: true }
      })
      const library = await routines(context(boardId, owner.id, "/api/boards/routines"))
      expect(library.status).toBe(200)
      const json = await library.json(); expect(json.items).toHaveLength(2)
      expect(json.items.every((item: { canComplete: boolean }) => item.canComplete)).toBe(true)
      expect(JSON.stringify(json)).not.toContain(projectId); expect(JSON.stringify(json)).not.toContain("Private implementation detail")
      const linkedComplete = await habits(context(boardId, owner.id, "/api/habits", { action: "complete", templateId: linked }))
      expect(linkedComplete.status).toBe(200); expect(await linkedComplete.json()).toMatchObject({ completed: true, alreadyExisted: false })
      const complete = await habits(context(boardId, owner.id, "/api/habits", { action: "complete", templateId: standalone }))
      expect(complete.status).toBe(200); expect(await complete.json()).toMatchObject({ completed: true, alreadyExisted: false })
      expect(await (await habits(context(boardId, owner.id, "/api/habits", { action: "complete", templateId: standalone }))).json()).toMatchObject({ completed: true, alreadyExisted: true })
      const deleted = await habits(context(boardId, owner.id, "/api/habits", { action: "delete", templateId: standalone }))
      expect(deleted.status).toBe(200); expect(await deleted.json()).toEqual({ ok: true }); expect(deleted.headers.get("cache-control")).toContain("no-store")
      expect((await habits(context(boardId, owner.id, "/api/habits", { action: "delete", templateId: standalone }))).status).toBe(404)
      scope = await currentBoardScope(db, boardId, owner)
      expect(await new TemplateRepository(db, scope).findById(standalone)).toBeNull()
      expect((await new TaskRepository(db, scope).findAll({})).tasks).toHaveLength(2)
    })
  })
  for (const action of ["generate", "complete"] as const) test(`cadence-only edit invalidates an in-flight ${action} without allocating work: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), boardId = await board(encoding, owner), scope = await currentBoardScope(db, boardId, owner)
    const templates = new TemplateRepository(db, scope), manager = new TemplateRepository(db, scope), id = crypto.randomUUID()
    await templates.create({ id, name: "Daily", templateJson: JSON.stringify({ title: "Routine task" }), icon: "R", position: 0, isRoutine: true, cadence: "daily" })
    const arrived = gate(), resume = gate(), original = templates.findById.bind(templates)
    templates.findById = async key => { const row = await original(key); arrived.release(); await resume.wait; return row }
    const pending = (action === "generate" ? templates.instantiateRoutineTask(id) : templates.completeRoutine(id, routinePeriod("daily"))).then(() => "committed", error => error.errorCode)
    await arrived.wait; expect(await manager.update(id, { cadence: "weekly" })).toBe(true)
    const before = (await db.execute("SELECT id,ticket_high_water FROM task_boards ORDER BY id")).rows
    resume.release(); expect(await pending).toBe("stale")
    expect((await db.execute("SELECT id FROM tasks WHERE source_template_id=?", [id])).rows).toEqual([])
    expect((await db.execute("SELECT id,ticket_high_water FROM task_boards ORDER BY id")).rows).toEqual(before)
    const current = await manager.completeRoutine(id)
    expect(current).toMatchObject({ completed: true, alreadyExisted: false })
    expect(await manager.completeRoutine(id)).toMatchObject({ taskId: current.taskId, completed: true, alreadyExisted: true })
    const facade = new NamedBoardTaskRepository(db, scope)
    expect(await facade.completeRoutine(owner, boardId, id, "1900-01-01")).toMatchObject({ ok: false, errorCode: "stale" })
  })
  test(`canonical recurrence edits persist, reject invalid mixed patches atomically, and control successors: ${encoding}`, async () => {
    await runWithIngressTransport(transport, async () => {
      const owner = await verifiedBoardRequestPrincipal({ request: new Request("http://localhost/boards"), locals: {} as App.Locals })
      if (!owner) throw new Error("Operator required")
      const db = getPersistenceClient(), boardId = await board(encoding, owner), scope = await currentBoardScope(db, boardId, owner), repo = new TaskRepository(db, scope)
      const task = await add(repo, { title: "Daily", recurrence_rule: "FREQ=DAILY", due_date: "2026-11-19" })
      const put = (body: unknown) => updateTask(context(boardId, owner.id, `/api/tasks/${task.id}`, body, task.id))
      const version = Number(task.task_version ?? task.updated_at)
      expect((await put({ title: "Weekly", recurrence_rule: "FREQ=WEEKLY", updated_at: version })).status).toBe(200)
      expect(await repo.findById(task.id)).toMatchObject({ title: "Weekly", recurrence_rule: "FREQ=WEEKLY" })
      for (const rule of [42, {}, "FREQ=HOURLY", "x".repeat(201)]) expect((await put({ title: "Must not persist", recurrence_rule: rule })).status).toBe(400)
      expect((await repo.findById(task.id))?.title).toBe("Weekly")
      expect((await put({ recurrence_rule: "FREQ=DAILY", updated_at: version })).status).toBe(409)
      expect((await put({ status: "complete" })).status).toBe(200)
      const successors = (await repo.findAll({})).tasks.filter(row => row.id !== task.id)
      expect(successors).toHaveLength(1); expect(successors[0]?.due_date).toBe("2026-11-26")
      for (const clear of [null, ""]) {
        const next = await add(repo, { title: "Clear recurrence", recurrence_rule: "FREQ=DAILY", due_date: "2026-11-19" })
        expect((await updateTask(context(boardId, owner.id, `/api/tasks/${next.id}`, { recurrence_rule: clear }, next.id))).status).toBe(200)
        expect((await repo.findById(next.id))?.recurrence_rule).toBeNull()
        expect((await updateTask(context(boardId, owner.id, `/api/tasks/${next.id}`, { status: "complete" }, next.id))).status).toBe(200)
      }
      expect((await repo.findAll({})).tasks).toHaveLength(4)
    })
  })
  test(`Routine check-in preserves child completion denial and Project lifecycle eligibility: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), boardId = await board(encoding, owner), boards = new NamedBoardRepository(db)
    expect(await boards.updateMember(owner, boardId, "child", { role: "member", denyCompletion: true, denyDeletion: true }, ["child"])).toMatchObject({ result: "saved" })
    const scope = await currentBoardScope(db, boardId, owner), templates = new TemplateRepository(db, scope), hierarchy = new HierarchyRepository(db, scope)
    const projectId = crypto.randomUUID(), id = crypto.randomUUID()
    await hierarchy.createProject({ id: projectId, title: "Routine Project" })
    await templates.create({ id, name: "Check", templateJson: '{"title":"Check task"}', icon: "R", position: 0, isRoutine: true, projectId })
    const child = fixturePrincipal("child", false), childScope = await currentBoardScope(db, boardId, child, { resource: "routine", action: "read" })
    await expect(new TemplateRepository(db, childScope).completeRoutine(id)).rejects.toMatchObject({ errorCode: "denied" })
    expect((await db.execute("SELECT id FROM tasks WHERE source_template_id=?", [id])).rows).toEqual([])
    const done = await templates.completeRoutine(id)
    expect(done.completed).toBe(true)
    expect(await hierarchy.updateProject(projectId, { status: "completed" })).toBe(true)
    expect(await new NamedBoardTaskRepository(db, scope).routineLibrary(owner)).toMatchObject([{ id, complete: true, canComplete: false }])
    expect(await templates.completeRoutine(id)).toEqual({ ...done, alreadyExisted: true })
  })
  test(`named requested period survives cadence change between facade and template reads: ${encoding}`, async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2031-07-10T12:00:00Z") })
    const db = getPersistenceClient(), owner = fixturePrincipal(), boardId = await board(encoding, owner), scope = await currentBoardScope(db, boardId, owner), templates = new TemplateRepository(db, scope)
    const id = crypto.randomUUID(); await templates.create({ id, name: "Check", templateJson: '{"title":"Check task"}', icon: "R", position: 0, isRoutine: true, cadence: "daily" })
    const original = TemplateRepository.prototype.completeRoutine
    TemplateRepository.prototype.completeRoutine = async function(key, period) {
      await templates.update(id, { cadence: "weekly" })
      return original.call(this, key, period)
    }
    try {
      expect(await new NamedBoardTaskRepository(db, scope).completeRoutine(owner, boardId, id, routinePeriod("daily"))).toMatchObject({ ok: false, errorCode: "stale" })
      expect((await db.execute("SELECT id FROM tasks WHERE source_template_id=?", [id])).rows).toEqual([])
    } finally { TemplateRepository.prototype.completeRoutine = original }
  })
  test(`period rollover after occurrence insert rolls back all effects before commit: ${encoding}`, async () => {
    mock.timers.enable({ apis: ["Date"], now: new Date("2031-07-10T23:59:59Z") })
    const db = getPersistenceClient(), owner = fixturePrincipal(), boardId = await board(encoding, owner), scope = await currentBoardScope(db, boardId, owner)
    const id = crypto.randomUUID(), templates = new TemplateRepository(db, scope)
    await templates.create({ id, name: "Check", templateJson: '{"title":"Check task"}', icon: "R", position: 0, isRoutine: true })
    const count = async () => (await db.execute("SELECT (SELECT COUNT(*) FROM tasks) AS tasks,(SELECT COUNT(*) FROM task_activity_log) AS activity,(SELECT ticket_high_water FROM task_boards WHERE id=?) AS counter", [boardId])).rows
    const before = await count(); let inserted = false
    const wrapped = new Proxy(db, { get(target, key) {
      if (key === "transaction") return async (mode?: "read" | "write" | "deferred") => {
        const tx = await target.transaction(mode)
        return new Proxy(tx, { get(inner, operation) {
          if (operation === "execute") return async (...args: unknown[]) => {
            const result = await (inner.execute as (...args: unknown[]) => Promise<unknown>).apply(inner, args)
            const statement = typeof args[0] === "string" ? args[0] : (args[0] as { sql?: string })?.sql ?? ""
            if (mode === "write" && !inserted && statement.includes("INSERT INTO tasks")) {
              inserted = true; mock.timers.setTime(Date.parse("2031-07-11T00:00:00Z"))
            }
            return result
          }
          const value = Reflect.get(inner, operation); return typeof value === "function" ? value.bind(inner) : value
        } })
      }
      const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value
    } }) as typeof db
    await expect(new TemplateRepository(wrapped, scope).completeRoutine(id)).rejects.toMatchObject({ errorCode: "stale" })
    expect(inserted).toBe(true); expect(await count()).toEqual(before)
  })
  test(`Project label inheritance uses visible metadata only and Task view versions normalize SQLite timestamps: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), boardId = await board(encoding, owner), scope = await currentBoardScope(db, boardId, owner), hierarchy = new HierarchyRepository(db, scope)
    const areaId = crypto.randomUUID(), goalId = crypto.randomUUID(), inherited = crypto.randomUUID(), direct = crypto.randomUUID(), hiddenDirect = crypto.randomUUID()
    await hierarchy.createArea({ id: areaId, name: "Kitchen" }); await hierarchy.createGoal({ id: goalId, title: "Visible Goal", area_id: areaId })
    await hierarchy.createProject({ id: inherited, title: "Duplicate", goal_id: goalId })
    await hierarchy.createProject({ id: direct, title: "Duplicate", area_id: areaId, goal_id: goalId })
    await hierarchy.createProject({ id: hiddenDirect, title: "Duplicate", area_id: areaId, goal_id: goalId })
    expect(await hierarchy.findProjectGroups()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: inherited, area_id: null, label_area_id: areaId }),
      expect.objectContaining({ id: direct, area_id: areaId, label_area_id: areaId })
    ]))
    // Historical invalid direct reference must not be treated as a missing one.
    // A known owned active row can be retired without deleting historical FKs.
    const retired = crypto.randomUUID(); await hierarchy.createArea({ id: retired, name: "Retired" })
    await hierarchy.updateProject(hiddenDirect, { area_id: retired })
    expect(await hierarchy.deleteArea(retired)).toBe(false)
    await db.execute("UPDATE areas SET retired_at=? WHERE id=?", [Date.now(), retired])
    expect((await hierarchy.findProjectGroups()).find(row => row.id === hiddenDirect)).toMatchObject({ area_id: null, label_area_id: null })
    const repo = new TaskRepository(db, scope), task = await add(repo, { title: "Versioned table" })
    await db.execute("UPDATE tasks SET updated_at='2026-11-19 12:34:56.123' WHERE id=?", [task.id])
    for (const options of [{}, { slim: true }, { descriptionPreviewChars: 5 }]) {
      const row = (await getTasksForView({ ...options, requireAvailable: true }, scope)).tasks.find(row => row.id === task.id)
      expect(row?.task_version).toBe(Date.parse("2026-11-19T12:34:56.123Z"))
    }
    await changeBoardGrants(db, owner, async tx => {
      await tx.execute("INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('feature','goals','','nobody','[]',1)")
      return { next: true }
    })
    const current = new HierarchyRepository(db, await currentBoardScope(db, boardId, owner))
    const groups = await current.findProjectGroups()
    expect(groups.find(row => row.id === inherited)).toMatchObject({ area_id: null, label_area_id: null })
    expect(groups.find(row => row.id === direct)).toMatchObject({ area_id: areaId, label_area_id: areaId })
    expect(JSON.stringify(groups)).not.toContain(goalId)
  })
  test(`backlog totals and items use effective Area and exact unfiled Project; custom lane reorder stays bounded: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), boardId = await board(encoding, owner), scope = await currentBoardScope(db, boardId, owner), hierarchy = new HierarchyRepository(db, scope), repo = new TaskRepository(db, scope)
    const a = crypto.randomUUID(), b = crypto.randomUUID(), project = crypto.randomUUID(), unfiled = crypto.randomUUID()
    await hierarchy.createArea({ id: a, name: "Kitchen" }); await hierarchy.createArea({ id: b, name: "Garden" })
    await hierarchy.createProject({ id: project, title: "Kitchen project", area_id: a }); await hierarchy.createProject({ id: unfiled, title: "Unfiled" })
    const direct = await add(repo, { title: "Direct", area_id: a, status: "backlog" }), nested = await add(repo, { title: "Project", project_id: project, status: "backlog" }), lone = await add(repo, { title: "Unfiled", project_id: unfiled, status: "backlog" })
    await add(repo, { title: "Other", area_id: b, status: "backlog" }); await repo.updateTask(nested.id, { area_id: null })
    expect((await repo.findBacklogPage(1, { areaId: a })).tasks.map(task => task.id).sort()).toEqual([direct.id, nested.id].sort())
    expect(await repo.findBacklogPage(1, { projectId: unfiled })).toMatchObject({ total: 1, tasks: [expect.objectContaining({ id: lone.id })] })
    expect((await repo.findBacklogPage(1)).total).toBe(4)
    await db.execute({ sql: "INSERT INTO kanban_lanes(id,key,label,board_id,position,includes,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)", args: [crypto.randomUUID(), "review", "Review", boardId, 8, '["backlog","pending"]'] })
    expect(await repo.reorderKanbanCard({ id: nested.id, anchorId: direct.id, lane: "review", before: true })).toBe(true)
    const foreignBoard = await new NamedBoardRepository(db).create(owner, "Foreign")
    if (foreignBoard.status !== "committed") throw new Error("Board required")
    const foreignScope = await currentBoardScope(db, foreignBoard.result.id, owner), foreign = await add(new TaskRepository(db, foreignScope), { title: "Foreign", status: "backlog" })
    const current = new TaskRepository(db, await currentBoardScope(db, boardId, owner))
    await expect(current.reorderKanbanCard({ id: nested.id, anchorId: foreign.id, lane: "review", before: true })).rejects.toMatchObject({ errorCode: "unavailable" })
  })
}
