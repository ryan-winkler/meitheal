/**
 * Hierarchy CRUD API Tests
 *
 * Tests the HierarchyRepository domain service with full CRUD
 * operations for Areas, Goals, and Projects.
 *
 * @domain domain-tasks (hierarchy context)
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */
import { test, expect } from "@playwright/test"
import { tmpdir } from "node:os"
import { join } from "node:path"

function createTestDb() {
  const dbUrl = `file:${join(tmpdir(), `hierarchy-crud-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)}`
  process.env.MEITHEAL_DB_URL = dbUrl
  return dbUrl
}

async function setupDb() {
  const { resetPersistenceForTests, ensureSchema } = await import("../../apps/web/src/domains/tasks/persistence/store")
  resetPersistenceForTests()
  await ensureSchema()
}

async function getRepo() {
  const { getPersistenceClient } = await import("../../apps/web/src/domains/tasks/persistence/store")
  const { HierarchyRepository } = await import("../../apps/web/src/domains/tasks/persistence/hierarchy-repository")
  return new HierarchyRepository(getPersistenceClient())
}

// ── Areas ────────────────────────────────────────────────────────

test("can create and retrieve an area", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-1", name: "Personal", icon: "🏠", color: "#FF5733" })
  const area = await repo.findAreaById("area-1")

  expect(area).not.toBeNull()
  expect(area!.name).toBe("Personal")
  expect(area!.icon).toBe("🏠")
  expect(area!.color).toBe("#FF5733")
})

test("findAllAreas returns areas ordered by position", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-z", name: "Zzz", position: 2 })
  await repo.createArea({ id: "area-a", name: "Aaa", position: 0 })
  await repo.createArea({ id: "area-m", name: "Mmm", position: 1 })

  const areas = await repo.findAllAreas()
  // Default 'Uncategorized' area + our 3
  const names = areas.map((a: { name: string }) => a.name)
  expect(names.indexOf("Aaa")).toBeLessThan(names.indexOf("Mmm"))
  expect(names.indexOf("Mmm")).toBeLessThan(names.indexOf("Zzz"))
})

test("can update an area", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-up", name: "Old Name" })
  const updated = await repo.updateArea("area-up", { name: "New Name", icon: "🎯" })
  expect(updated).toBe(true)

  const area = await repo.findAreaById("area-up")
  expect(area!.name).toBe("New Name")
  expect(area!.icon).toBe("🎯")
})

test("can delete an area", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-del", name: "To Delete" })
  const deleted = await repo.deleteArea("area-del")
  expect(deleted).toBe(true)

  const area = await repo.findAreaById("area-del")
  expect(area).toBeNull()
})

test("delete non-existent area returns false", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  const deleted = await repo.deleteArea("nonexistent")
  expect(deleted).toBe(false)
})

test("countAreas includes default area", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  const count = await repo.countAreas()
  expect(count).toBeGreaterThanOrEqual(1) // Default 'Uncategorized'
})

// ── Goals ────────────────────────────────────────────────────────

test("can create and retrieve a goal", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createGoal({ id: "goal-1", title: "Learn TypeScript", area_id: null, description: "Master TS", target_date: "2026-12-31" })
  const goal = await repo.findGoalById("goal-1")

  expect(goal).not.toBeNull()
  expect(goal!.title).toBe("Learn TypeScript")
  expect(goal!.description).toBe("Master TS")
  expect(goal!.status).toBe("active")
  expect(goal!.target_date).toBe("2026-12-31")
})

test("findAllGoals filters by area_id", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-work", name: "Work" })
  await repo.createArea({ id: "area-home", name: "Home" })
  await repo.createGoal({ id: "goal-w1", title: "Promotion", area_id: "area-work" })
  await repo.createGoal({ id: "goal-h1", title: "Tidy Garden", area_id: "area-home" })

  const workGoals = await repo.findAllGoals({ area_id: "area-work" })
  expect(workGoals).toHaveLength(1)
  expect(workGoals[0]!.title).toBe("Promotion")
})

test("findAllGoals filters by status", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createGoal({ id: "goal-act", title: "Active Goal", status: "active" })
  await repo.createGoal({ id: "goal-done", title: "Done Goal", status: "completed" })

  const activeGoals = await repo.findAllGoals({ status: "active" })
  expect(activeGoals.every((g: { status: string }) => g.status === "active")).toBe(true)
  expect(activeGoals.find((g: { id: string }) => g.id === "goal-act")).toBeDefined()
})

test("can update a goal", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createGoal({ id: "goal-up", title: "Old Title" })
  await repo.updateGoal("goal-up", { title: "New Title", status: "completed" })

  const goal = await repo.findGoalById("goal-up")
  expect(goal!.title).toBe("New Title")
  expect(goal!.status).toBe("completed")
})

test("can delete a goal", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createGoal({ id: "goal-del", title: "Delete Me" })
  const deleted = await repo.deleteGoal("goal-del")
  expect(deleted).toBe(true)
  expect(await repo.findGoalById("goal-del")).toBeNull()
})

// ── Projects ─────────────────────────────────────────────────────

test("can create and retrieve a project", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createProject({ id: "proj-1", title: "Build MVP", icon: "🚀", color: "#10B981" })
  const project = await repo.findProjectById("proj-1")

  expect(project).not.toBeNull()
  expect(project!.title).toBe("Build MVP")
  expect(project!.icon).toBe("🚀")
  expect(project!.color).toBe("#10B981")
  expect(project!.status).toBe("active")
})

test("findAllProjects filters by goal_id", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createGoal({ id: "goal-filt", title: "Filter Goal" })
  await repo.createProject({ id: "proj-f1", title: "Project A", goal_id: "goal-filt" })
  await repo.createProject({ id: "proj-f2", title: "Project B", goal_id: null })

  const goalProjects = await repo.findAllProjects({ goal_id: "goal-filt" })
  expect(goalProjects).toHaveLength(1)
  expect(goalProjects[0]!.title).toBe("Project A")
})

test("findAllProjects filters by status", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createProject({ id: "proj-act", title: "Active", status: "active" })
  await repo.createProject({ id: "proj-pau", title: "Paused", status: "paused" })

  const paused = await repo.findAllProjects({ status: "paused" })
  expect(paused).toHaveLength(1)
  expect(paused[0]!.title).toBe("Paused")
})

test("can create a project with area_id", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-proj", name: "Work" })
  await repo.createProject({ id: "proj-area", title: "Work Project", area_id: "area-proj" })

  const project = await repo.findProjectById("proj-area")
  expect(project).not.toBeNull()
  expect(project!.area_id).toBe("area-proj")
})

test("findAllProjects filters by area_id", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-f1", name: "Home" })
  await repo.createArea({ id: "area-f2", name: "Work" })
  await repo.createProject({ id: "proj-a1", title: "Home Project", area_id: "area-f1" })
  await repo.createProject({ id: "proj-a2", title: "Work Project", area_id: "area-f2" })
  await repo.createProject({ id: "proj-a3", title: "No Area", area_id: null })

  const homeProjects = await repo.findAllProjects({ area_id: "area-f1" })
  expect(homeProjects).toHaveLength(1)
  expect(homeProjects[0]!.title).toBe("Home Project")
})

test("findProjectsByArea convenience method", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-conv", name: "Side" })
  await repo.createProject({ id: "proj-c1", title: "Side A", area_id: "area-conv" })
  await repo.createProject({ id: "proj-c2", title: "Side B", area_id: "area-conv" })
  await repo.createProject({ id: "proj-c3", title: "Other" })

  const sideProjects = await repo.findProjectsByArea("area-conv")
  expect(sideProjects).toHaveLength(2)
  expect(sideProjects.map((p: { title: string }) => p.title).sort()).toEqual(["Side A", "Side B"])
})

test("can update a project", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createProject({ id: "proj-up", title: "Old", icon: "📋" })
  await repo.updateProject("proj-up", { title: "New", icon: "🎯", status: "paused" })

  const project = await repo.findProjectById("proj-up")
  expect(project!.title).toBe("New")
  expect(project!.icon).toBe("🎯")
  expect(project!.status).toBe("paused")
})

test("can delete a project", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createProject({ id: "proj-del", title: "Delete Me" })
  const deleted = await repo.deleteProject("proj-del")
  expect(deleted).toBe(true)
  expect(await repo.findProjectById("proj-del")).toBeNull()
})

// ── Cross-entity relationships ───────────────────────────────────

test("deleting an area cascades to set goal area_id to NULL", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createArea({ id: "area-cascade", name: "Cascade Test" })
  await repo.createGoal({ id: "goal-cascade", title: "Linked Goal", area_id: "area-cascade" })

  // Verify link
  let goal = await repo.findGoalById("goal-cascade")
  expect(goal!.area_id).toBe("area-cascade")

  // Delete area
  await repo.deleteArea("area-cascade")

  // Goal should still exist but area_id should be NULL
  goal = await repo.findGoalById("goal-cascade")
  expect(goal).not.toBeNull()
  expect(goal!.area_id).toBeNull()
})

test("deleting a goal cascades to set project goal_id to NULL", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  await repo.createGoal({ id: "goal-cascade2", title: "Cascade Goal" })
  await repo.createProject({ id: "proj-cascade2", title: "Linked Project", goal_id: "goal-cascade2" })

  // Delete goal
  await repo.deleteGoal("goal-cascade2")

  // Project should still exist but goal_id should be NULL
  const project = await repo.findProjectById("proj-cascade2")
  expect(project).not.toBeNull()
  expect(project!.goal_id).toBeNull()
})

test("getNextAreaPosition returns sequential positions", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  const pos1 = await repo.getNextAreaPosition()
  await repo.createArea({ id: "area-pos1", name: "First", position: pos1 })
  const pos2 = await repo.getNextAreaPosition()
  expect(pos2).toBe(pos1 + 1)
})

test("getNextProjectPosition returns sequential positions", async () => {
  createTestDb()
  await setupDb()
  const repo = await getRepo()

  const pos1 = await repo.getNextProjectPosition()
  await repo.createProject({ id: "proj-pos1", title: "First", position: pos1 })
  const pos2 = await repo.getNextProjectPosition()
  expect(pos2).toBe(pos1 + 1)
})
