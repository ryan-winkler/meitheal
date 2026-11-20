import { integrationRoute } from "../helpers/ordinary-integration-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { goalProgress, isValidGoalProgress } from "../../packages/domain-tasks/src/index"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { GET as listGoals, POST as createGoal } from "../../apps/web/src/pages/api/goals/index"
import { GET as getGoal, PUT as updateGoal } from "../../apps/web/src/pages/api/goals/[id]"

type Database = ReturnType<typeof getPersistenceClient>
const test = base.extend<{ db: Database }>({
  db: async ({}, use) => {
    const previous = process.env.MEITHEAL_DB_URL
    const work = await mkdtemp(join(tmpdir(), "meitheal-goal-progress-"))
    process.env.MEITHEAL_DB_URL = `file:${join(work, "goals.db")}`
    resetPersistenceForTests()
    try {
      await ensureSchema()
      const db = getPersistenceClient()
      await use(db)
    } finally {
      resetPersistenceForTests()
      if (previous === undefined) delete process.env.MEITHEAL_DB_URL
      else process.env.MEITHEAL_DB_URL = previous
      await rm(work, { recursive: true, force: true })
    }
  },
})

function update(id: string, body: unknown) {
  return integrationRoute(context => updateGoal({ ...context, params: { id } }), `/api/goals/${id}`, body, "PUT")
}

test("goal percentages are finite and bounded, including metric display", () => {
  expect(goalProgress(250, 1000)).toBe(25)
  expect(goalProgress(120, 100)).toBe(100)
  expect(goalProgress(-5, 100)).toBe(0)
  for (const target of [null, 0, -1, NaN, Infinity]) expect(goalProgress(5, target)).toBe(0)
  for (const current of [NaN, Infinity, -Infinity]) expect(goalProgress(current, 100)).toBe(0)
  for (const value of [0, 37.5, 100]) expect(isValidGoalProgress(value)).toBe(true)
  for (const value of [NaN, Infinity, -1, 101, "50", null]) expect(isValidGoalProgress(value)).toBe(false)
})

test("percentage save initializes its metric and survives API list/detail reads", async ({ db }) => {
  expect(db.closed).toBe(false)
  const created = await integrationRoute(createGoal, "/api/goals?board_id=household", { title: "Progress fixture" })
  expect(created.status).toBe(201)
  const { id } = await created.json()
  expect((await update(id, { progress: 37.5 })).status).toBe(200)
  const expected = { id, progress: 37.5, metric_type: "percentage", metric_target: 100, metric_current: 37.5 }
  const detail = await integrationRoute(context => getGoal({ ...context, params: { id } }), `/api/goals/${id}`, undefined, "GET")
  expect(await detail.json()).toMatchObject(expected)
  const list = await integrationRoute(listGoals, "/api/goals?board_id=household", undefined, "GET")
  expect((await list.json()).goals).toEqual(expect.arrayContaining([expect.objectContaining(expected)]))
})

test("percentage updates preserve a positive metric scale and recover a nonpositive target", async ({ db }) => {
  const repo = new HierarchyRepository(db, await currentBoardScope(db))
  await repo.createGoal({ id: "savings", title: "Savings", metric_type: "currency", metric_target: 1000, metric_current: 250 })
  expect(await repo.findGoalById("savings")).toMatchObject({ progress: 25 })
  expect((await update("savings", { progress: 37.5 })).status).toBe(200)
  expect(await repo.findGoalById("savings")).toMatchObject({ progress: 37.5, metric_current: 375, metric_target: 1000, metric_type: "currency" })
  await repo.createGoal({ id: "zero", title: "No positive target", metric_type: "count", metric_target: 0, metric_current: 2 })
  expect(await repo.findGoalById("zero")).toMatchObject({ progress: 0 })
  await update("zero", { progress: 100 })
  expect(await repo.findGoalById("zero")).toMatchObject({ progress: 100, metric_current: 100, metric_target: 100, metric_type: "percentage" })
  await update("savings", { progress: 0 })
  expect(await repo.findGoalById("savings")).toMatchObject({ progress: 0, metric_current: 0 })
})

test("invalid goal percentages reject the whole update and preserve prior values", async ({ db }) => {
  const repo = new HierarchyRepository(db, await currentBoardScope(db))
  await repo.createGoal({ id: "bounded", title: "Preserve me", metric_type: "count", metric_target: 100, metric_current: 40 })
  const before = await repo.findGoalById("bounded")
  for (const progress of [-1, 101, "50", null]) {
    expect((await update("bounded", { title: "Must not change", progress })).status).toBe(400)
    expect(await repo.findGoalById("bounded")).toEqual(before)
  }
})
