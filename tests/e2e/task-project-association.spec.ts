/**
 * Task-Project Association Tests
 *
 * Verifies that tasks created with a project_id are correctly
 * persisted and queryable via findByProjectId.
 *
 * @domain domain-tasks (project association)
 */
import { test, expect } from "@playwright/test"
import { tmpdir } from "node:os"
import { join } from "node:path"

function createTestDb() {
  const dbUrl = `file:${join(tmpdir(), `task-project-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)}`
  process.env.MEITHEAL_DB_URL = dbUrl
  return dbUrl
}

async function setupDb() {
  const { resetPersistenceForTests, ensureSchema } = await import("../../apps/web/src/domains/tasks/persistence/store")
  resetPersistenceForTests()
  await ensureSchema()
}

async function getRepos() {
  const { getPersistenceClient } = await import("../../apps/web/src/domains/tasks/persistence/store")
  const { TaskRepository } = await import("../../apps/web/src/domains/tasks/persistence/task-repository")
  const { HierarchyRepository } = await import("../../apps/web/src/domains/tasks/persistence/hierarchy-repository")
  const client = getPersistenceClient()
  return { taskRepo: new TaskRepository(client), hierRepo: new HierarchyRepository(client) }
}

test("createTask persists project_id and findByProjectId returns it", async () => {
  createTestDb()
  await setupDb()
  const { taskRepo, hierRepo } = await getRepos()

  // Create a project
  await hierRepo.createProject({ id: "proj-test-1", title: "Test Project", icon: "🧪", color: "#FF0000" })

  // Create a task with project_id
  await taskRepo.createTask({
    id: "task-with-proj",
    title: "Task In Project",
    description: "Has project association",
    status: "pending",
    priority: 3,
    due_date: null,
    labels: "[]",
    framework_payload: "{}",
    parent_id: null,
    area_id: "default",
    custom_fields: "{}",
    project_id: "proj-test-1",
    start_date: null,
    end_date: null,
    progress: 0,
    color: null,
    is_favorite: 0,
    task_type: "task",
    ticket_number: 1,
    assigned_to: null,
  })

  // Verify findByProjectId returns the task
  const tasks = await taskRepo.findByProjectId("proj-test-1")
  expect(tasks).toHaveLength(1)
  expect(tasks[0]!.title).toBe("Task In Project")
  expect(tasks[0]!.project_id).toBe("proj-test-1")
})

test("createTask without project_id defaults to null", async () => {
  createTestDb()
  await setupDb()
  const { taskRepo } = await getRepos()

  // Create a task without project_id
  await taskRepo.createTask({
    id: "task-no-proj",
    title: "Standalone Task",
    description: "",
    status: "pending",
    priority: 3,
    due_date: null,
    labels: "[]",
    framework_payload: "{}",
    parent_id: null,
    area_id: "default",
    custom_fields: "{}",
    start_date: null,
    end_date: null,
    progress: 0,
    color: null,
    is_favorite: 0,
    task_type: "task",
    ticket_number: 2,
    assigned_to: null,
  })

  // Verify the task exists but is not associated with any project
  const tasks = await taskRepo.findByProjectId("proj-test-1")
  expect(tasks).toHaveLength(0)
})

test("completing a recurring task keeps the next occurrence in its project", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

  const area = await request.post("/api/areas", { data: { name: "Recurring project area" } })
  expect(area.status()).toBe(201)
  const { id: areaId } = await area.json()
  const project = await request.post("/api/projects", { data: { title: "Recurring work", area_id: areaId } })
  expect(project.status()).toBe(201)
  const { id: projectId } = await project.json()
  const title = "Recurring project checklist"
  const assignment = { area_id: areaId, assigned_to: "custom_recurring_fixture" }
  const created = await request.post("/api/tasks", {
    data: {
      ...assignment, title, project_id: projectId, due_date: "2031-02-14",
      recurrence_rule: "FREQ=DAILY", checklists: JSON.stringify([{ text: "Check supplies", done: true }]),
    },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const complete = await request.patch(`/api/tasks/${id}`, { data: { status: "complete" } })
  expect(complete.status()).toBe(200)

  const list = await request.get("/api/tasks", { params: { q: title, due_date: "2031-02-15" } })
  expect(list.status()).toBe(200)
  const { tasks } = await list.json()
  expect(tasks).toHaveLength(1)
  const next = await request.get(`/api/tasks/${tasks[0].id}`)
  expect(next.status()).toBe(200)
  const occurrence = await next.json()
  expect(occurrence.id).not.toBe(id)
  expect(occurrence).toMatchObject({
    ...assignment, title, project_id: projectId, status: "pending", due_date: "2031-02-15",
    recurrence_rule: "FREQ=DAILY",
  })
  expect(JSON.parse(occurrence.checklists)).toEqual([{ text: "Check supplies", done: false }])
})

test("task detail reassigns projects, rejects a deleted destination, and preserves the task", async ({ page, request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")

  const source = await request.post("/api/projects", { data: { title: "Project reassignment source" } })
  const destination = await request.post("/api/projects", { data: { title: "Project reassignment destination" } })
  expect(source.status()).toBe(201)
  expect(destination.status()).toBe(201)
  const sourceId = (await source.json()).id as string
  const destinationId = (await destination.json()).id as string
  const created = await request.post("/api/tasks", {
    data: { title: "Reassign this task", project_id: sourceId, status: "active", area_id: "default" },
  })
  expect(created.status()).toBe(201)
  const task = await created.json()
  const taskPath = `/api/tasks/${task.id}`
  const properties = { id: task.id, area_id: task.area_id, status: task.status, ticket_key: task.ticket_key }

  const detail = page.locator("#task-detail-overlay")
  const project = detail.getByLabel("Project", { exact: true })
  const openTask = async () => {
    await page.getByRole("button", { name: /^Task: Reassign this task,/ }).click()
    await expect(project).toBeEnabled()
  }
  const reloadTask = async () => {
    await detail.locator("#td-close").click()
    await expect(detail).not.toHaveClass(/active/)
    await page.reload()
    await openTask()
  }
  await page.goto("/tasks#kanban")
  await openTask()
  await expect(project).toHaveValue(sourceId)

  const projectUpdate = () => page.waitForResponse(response =>
    response.request().method() === "PUT" && new URL(response.url()).pathname === taskPath)
  const moved = projectUpdate()
  await project.selectOption(destinationId)
  expect(await (await moved).json()).toMatchObject({ ...properties, project_id: destinationId })
  await expect(project).toBeEnabled()
  await reloadTask()
  await expect(project).toHaveValue(destinationId)

  const deleteProject = (id: string) =>
    request.delete(`/api/projects/${id}`, { headers: { "content-type": "application/json" } })
  const deletedSource = await deleteProject(sourceId)
  expect(deletedSource.status(), await deletedSource.text()).toBe(200)
  const rejected = projectUpdate()
  await project.selectOption(sourceId)
  expect((await rejected).status()).toBe(409)
  await expect(project).toHaveValue(destinationId)
  await expect(project).toBeEnabled()

  const invalid = await request.patch(taskPath, { data: { project_id: 123, status: "complete" } })
  expect(invalid.status()).toBe(400)
  const missing = await request.patch(taskPath, { data: { project_id: sourceId, status: "complete" } })
  expect(missing.status()).toBe(409)
  expect(await (await request.get(taskPath)).json()).toMatchObject({ ...properties, project_id: destinationId })

  const detach = projectUpdate()
  await project.selectOption("")
  const detached = await detach
  expect(detached.status()).toBe(200)
  expect(await detached.json()).toMatchObject({ ...properties, project_id: null })
  await reloadTask()
  await expect(project).toHaveValue("")

  const reattached = await request.patch(taskPath, { data: { project_id: destinationId } })
  expect(reattached.status()).toBe(200)
  const deletedDestination = await deleteProject(destinationId)
  expect(deletedDestination.status(), await deletedDestination.text()).toBe(200)
  expect(await (await request.get(taskPath)).json()).toMatchObject({ ...properties, project_id: null })
})
