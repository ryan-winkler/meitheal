import { expect, test } from "@playwright/test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { boardWorkspaceHref, parseBoardPlacement, readBoardWorkspaceSelection } from "../../apps/web/src/lib/board-workspace"
import { boardGroupCursor, readBoardGroupCursor } from "../../apps/web/src/lib/named-board-request"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

test("workspace links preserve context and reject mixed placement and foreign cursors", () => {
  expect(readBoardWorkspaceSelection(new URLSearchParams("area=a&project=p&ticket=t&from=a&view=groups"))).toEqual({
    areaId: "a", projectId: "p", ticketId: "t", fromArea: "a", planning: true,
  })
  expect(readBoardWorkspaceSelection(new URLSearchParams())).toEqual({
    areaId: null, projectId: null, ticketId: null, fromArea: null, planning: false,
  })
  expect(boardWorkspaceHref("a/b", { area: "room", project: "p", ticket: "t", groups: true, offset: 50, fromArea: "origin" }, "tasks"))
    .toBe("/boards/a%2Fb?view=groups&area=room&project=p&from=origin&ticket=t&offset=50#tasks")
  expect(boardWorkspaceHref("household")).toBe("/boards/household")
  expect(parseBoardPlacement({})).toEqual({ areaId: null, projectId: null })
  expect(parseBoardPlacement({ projectId: "p", areaId: null })).toEqual({ projectId: "p", areaId: null })
  for (const value of [null, [], "x", { goalId: "g" }, { areaId: "" }, { projectId: 1 }, { areaId: "x".repeat(151) }]) {
    expect(parseBoardPlacement(value)).toBeNull()
  }
  const cursor = boardGroupCursor("person", "board", "group")
  expect(readBoardGroupCursor("person", "board", cursor)).toBe("group")
  expect(readBoardGroupCursor("other", "board", cursor)).toBeNull()
  expect(readBoardGroupCursor("person", "other", cursor)).toBeNull()
  expect(readBoardGroupCursor("person", "board", cursor + "0")).toBeNull()
  expect(readBoardGroupCursor("person", "board", "invalid")).toBeNull()
})

test("Household filing preserves task identity and lists every group task across pages", async () => {
  const folder = await mkdtemp(join(tmpdir(), "meitheal-workspace-placement-"))
  const previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(folder, "tasks.db")
  resetPersistenceForTests()
  try {
    await ensureSchema()
    const db = getPersistenceClient()
    const tasks = new TaskRepository(db)
    const hierarchy = new HierarchyRepository(db)
    await db.batch([
      "INSERT INTO areas (id, name, created_at, updated_at) VALUES ('kitchen', 'Kitchen', 1, 1)",
      "INSERT INTO areas (id, name, created_at, updated_at) VALUES ('yard', 'Yard', 1, 1)",
      "INSERT INTO projects (id, title, area_id, created_at, updated_at) VALUES ('renovate', 'Renovate', 'kitchen', 1, 1)",
      ...Array.from({ length: 55 }, (_, index) => ({
        sql: "INSERT INTO tasks (id,title,status,area_id,created_at,updated_at,idempotency_key,request_id) VALUES (?,?,'pending','kitchen',1,1000000000000,?,?)",
        args: ["task-" + index, "Task " + index, "task-" + index, "task-" + index],
      })),
    ], "write")
    const first = await tasks.findAll({ workspaceAreaId: "kitchen", limit: 50 })
    const second = await tasks.findAll({ workspaceAreaId: "kitchen", limit: 50, offset: 50 })
    expect(first.total).toBe(55)
    expect(first.tasks).toHaveLength(50)
    expect(second.tasks).toHaveLength(5)
    expect(new Set([...first.tasks, ...second.tasks].map(task => task.id)).size).toBe(55)
    expect(await tasks.fileHouseholdTask("task-0", 0, { projectId: "renovate" })).toEqual({ ok: false, stale: true })
    expect(await tasks.fileHouseholdTask("task-0", 1000000000000, { areaId: "yard", projectId: "renovate" })).toEqual({ ok: false, stale: false })
    expect(await tasks.fileHouseholdTask("task-0", 1000000000000, { areaId: "missing" })).toEqual({ ok: false, stale: false })
    expect(await tasks.fileHouseholdTask("task-0", 1000000000000, { projectId: "missing" })).toEqual({ ok: false, stale: false })
    const placed = await tasks.fileHouseholdTask("task-0", 1000000000000, { projectId: "renovate" })
    expect(placed).toMatchObject({ ok: true, task: { id: "task-0", area_id: "kitchen", project_id: "renovate" } })
    if (!placed.ok) throw new Error("Expected filing")
    const unfiled = await tasks.fileHouseholdTask("task-0", Number(placed.task.task_version), { areaId: null, projectId: null })
    expect(unfiled).toMatchObject({ ok: true, task: { area_id: "default", project_id: null } })
    const page = await hierarchy.findAreaPage(null)
    expect(page.items.map(group => group.id)).toContain("kitchen")
    expect(await hierarchy.findAreaPage("missing")).toEqual({ items: [], next_cursor: null })
  } finally {
    resetPersistenceForTests()
    if (previous === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previous
    await rm(folder, { recursive: true, force: true })
  }
})
