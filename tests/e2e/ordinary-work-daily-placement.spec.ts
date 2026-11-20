import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { getTodayTaskRows, getTodayTaskCounts } from "../../apps/web/src/lib/task-queries"
import { calendarToday, shiftCalendarDay } from "../../apps/web/src/lib/date"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"

let directory: string, previousUrl: string | undefined
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-daily-placement-"))
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
  test(`daily read context includes project-only Area work and unfiled Projects without changing Board-wide reads: ${encoding}`, async () => {
    const db = getPersistenceClient(), owner = fixturePrincipal(), created = await new NamedBoardRepository(db).create(owner, "Daily Work")
    if (created.status !== "committed") throw new Error("Board creation failed")
    const board = encoding === "legacy" ? "household" : created.result.id
    const scope = await currentBoardScope(db, board, owner), hierarchy = new HierarchyRepository(db, scope), repo = new TaskRepository(db, scope)
    const areaA = crypto.randomUUID(), areaB = crypto.randomUUID(), projectA = crypto.randomUUID(), unfiledProject = crypto.randomUUID()
    await hierarchy.createArea({ id: areaA, name: "Kitchen" }); await hierarchy.createArea({ id: areaB, name: "Garden" })
    expect(await hierarchy.createProject({ id: projectA, title: "Kitchen Project", area_id: areaA })).toBe(true)
    expect(await hierarchy.createProject({ id: unfiledProject, title: "Unfiled Project" })).toBe(true)
    const today = calendarToday("UTC"), due = shiftCalendarDay(today, -1)
    const add = async (title: string, placement: { area_id?: string, project_id?: string } = {}, complete = false) => {
      const prepared = await prepareTaskCreation(repo, { title, due_date: due, ...placement, status: complete ? "complete" : "pending" }, { useDefaultAssignee: false })
      if (!prepared.ok) throw new Error(prepared.error)
      const result = await repo.createWorkCommand(prepared.task)
      if (!result.ok) throw new Error(result.errorCode)
      expect((await repo.updateTask(result.task.id, { is_favorite: 1 })).ok).toBe(true)
      return result.task.id
    }
    const directA = await add("Direct Area", { area_id: areaA }), projectOnly = await add("Project only Area", { project_id: projectA })
    const completeA = await add("Project complete today", { project_id: projectA }, true)
    await add("Other Area", { area_id: areaB }); await add("Other complete today", { area_id: areaB }, true)
    const unfiled = await add("Unfiled Project", { project_id: unfiledProject }); await add("Unfiled standalone")
    // Explicitly retain a project-only normalized tuple for the effective parent
    // Area predicate, rather than relying on direct area placement.
    expect((await repo.updateTask(projectOnly, { area_id: null })).ok).toBe(true)
    for (const [placement, openIds, completeIds, total] of [
      [{ areaId: areaA }, [directA, projectOnly], [completeA], 3],
      [{ projectId: projectA }, [projectOnly], [completeA], 2],
      [{ areaId: areaA, projectId: projectA }, [projectOnly], [completeA], 2],
      [{ areaId: null, projectId: unfiledProject }, [unfiled], [], 1],
    ] as const) {
      const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id).sort()
      expect(ids(await repo.getOpenTasks(50, placement))).toEqual([...openIds].sort())
      expect(ids(await repo.getFavoriteTasks(50, placement))).toEqual([...openIds].sort())
      expect((await repo.getRecentTasks(50, placement))).toHaveLength(total)
      expect(await repo.getStatusCounts(placement)).toMatchObject({ total, open: openIds.length, completed: completeIds.length })
      expect(await repo.getOverdueCount(today, "UTC", placement)).toBe(openIds.length)
      expect(ids(await repo.getTasksInRange(due, today, "UTC", placement))).toEqual([...openIds].sort())
      const daily = await getTodayTaskRows(today, true, "UTC", new Date(), scope, placement)
      expect(ids(daily.tasks)).toEqual([...openIds].sort())
      expect(daily.completedTodayCount).toBe(completeIds.length)
      expect(ids(daily.completedTasks)).toEqual([...completeIds].sort())
      const badge = await getTodayTaskCounts(new Date(), "UTC", true, scope, placement)
      expect(badge.completedToday).toBe(completeIds.length)
      expect(badge.remaining).toBe(openIds.length)
      expect(ids(badge.completedTasks ?? [])).toEqual([...completeIds].sort())
    }
    expect(await repo.getStatusCounts()).toMatchObject({ total: 7, open: 5, completed: 2 })
    expect(await repo.getOverdueCount(today, "UTC")).toBe(5)
    expect((await getTodayTaskRows(today, true, "UTC", new Date(), scope)).tasks).toHaveLength(5)
    expect(await repo.archiveCompletedForDay(today, "UTC", { projectId: projectA })).toBe(1)
    expect((await repo.findById(completeA))?.status).toBe("archived")
    expect((await repo.findAll({})).tasks.filter(task => task.status === "complete")).toHaveLength(1)
    expect(await repo.archiveCompletedForDay(today, "UTC", { projectId: projectA })).toBe(0)
    await changeBoardGrants(db, owner, async tx => {
      await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES('group',?,?,'nobody','[]',1)", args: [areaA, board] })
      return { next: true }
    })
    const current = await currentBoardScope(db, board, owner), restricted = new TaskRepository(db, current)
    expect(await restricted.getStatusCounts({ areaId: areaA })).toMatchObject({ total: 0, open: 0, completed: 0 })
    expect(await restricted.getOpenTasks(50, { projectId: projectA })).toEqual([])
    expect((await getTodayTaskRows(today, true, "UTC", new Date(), current, { areaId: areaA })).completedTodayCount).toBe(0)
  })
}
