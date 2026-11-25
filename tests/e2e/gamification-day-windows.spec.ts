import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { currentBoardScope } from "../helpers/current-board-scope"
import {
  ensureGamificationSchema,
  getDailyProgress,
  getStats,
  getWeeklyData,
  recordTaskCompletion,
} from "../../apps/web/src/domains/gamification/streak-tracker"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"

test("gamification keeps consecutive UTC days across a local DST transition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-gamification-days-"))
  const previousDb = process.env.MEITHEAL_DB_URL
  const previousTimezone = process.env.TZ
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  process.env.TZ = "America/Los_Angeles"
  resetPersistenceForTests()

  try {
    await ensureSchema()
    await ensureGamificationSchema()
    await getPersistenceClient().execute(
      "INSERT INTO gamification_stats(board_id, date, completed_count, streak_count, points) VALUES ('household', '2026-11-01', 2, 4, 60)",
    )
    const scope = await currentBoardScope(getPersistenceClient())
    const now = new Date("2026-11-02T00:30:00Z")
    expect(await getDailyProgress(scope, now)).toEqual({ currentStreak: 4, points: 0 })
    expect(await getStats(scope, now)).toMatchObject({ currentStreak: 4, todayCompleted: 0 })
    expect((await getWeeklyData(scope, now)).slice(-2)).toEqual([
      { date: "2026-11-01", completedCount: 2, streakCount: 4, points: 60 },
      { date: "2026-11-02", completedCount: 0, streakCount: 0, points: 0 },
    ])
    expect(await recordTaskCompletion(scope, 30, now)).toMatchObject({ currentStreak: 5, todayCompleted: 1 })
    expect(await getDailyProgress(scope, now)).toEqual({ currentStreak: 5, points: 30 })
  } finally {
    resetPersistenceForTests()
    if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDb
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
    await rm(directory, { recursive: true, force: true })
  }
})
