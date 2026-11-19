import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { getStats, getWeeklyData, recordTaskCompletion } from "../../apps/web/src/domains/gamification/streak-tracker"
import { getAllAchievements, getYearlyHeatmapData } from "../../apps/web/src/domains/gamification/achievement-engine"

let directory: string, previous: string | undefined
const parent = () => registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
async function scope(boardId: string, user = parent()) {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(user, boardId, { resource: "task", action: "read" })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-work-stats-")); previous = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  await ensureSchema()
})
test.afterEach(async () => {
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL; else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})
test("daily statistics and achievements remain in their original Board with no global request cache", async () => {
  const db = getPersistenceClient()
  const created = await new NamedBoardRepository(db).create(parent(), "Work")
  if (created.status !== "committed") throw new Error("Work unavailable")
  const home = await scope("household"), work = await scope(created.result.id)
  const now = new Date("2026-11-19T12:00:00Z")
  await recordTaskCompletion(home, 30, now)
  await recordTaskCompletion(work, 50, now)
  expect(await getStats(home, now)).toMatchObject({ todayCompleted: 1, totalPoints: 30 })
  expect(await getStats(work, now)).toMatchObject({ todayCompleted: 1, totalPoints: 50 })
  expect((await getWeeklyData(home, now)).at(-1)?.points).toBe(30)
  expect((await getWeeklyData(work, now)).at(-1)?.points).toBe(50)
  expect((await db.execute("SELECT board_id, points FROM gamification_stats ORDER BY points")).rows).toEqual([{ board_id: "household", points: 30 }, { board_id: created.result.id, points: 50 }])
})
test("a reader missing a private Area cannot read unattributed historical totals or achievement counts", async () => {
  const db = getPersistenceClient(), original = await scope("household")
  await new HierarchyRepository(db, original).createArea({ id: "private-area", name: "Private work" })
  await recordTaskCompletion(original, 50)
  await changeBoardGrants(db, async tx => {
    await tx.execute("INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('group','private-area','household','selected','[\"parent\"]',1)")
    return { next: true }
  })
  const other = await scope("household", registerVerifiedPrincipal({ kind: "ha_user", id: "other" }, { administrator: false, expiresAt: Date.now() + 60_000 }))
  await expect(getStats(other)).rejects.toMatchObject({ errorCode: "unavailable" })
  await expect(getAllAchievements(other)).rejects.toMatchObject({ errorCode: "unavailable" })
  await expect(getYearlyHeatmapData(other, 2026)).rejects.toMatchObject({ errorCode: "unavailable" })
  expect(await getStats(await scope("household"))).toMatchObject({ totalPoints: 50 })
})
