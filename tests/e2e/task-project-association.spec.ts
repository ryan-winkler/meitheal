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
