import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { startDueDateReminders, stopDueDateReminders } from "../../apps/web/src/domains/notifications/due-date-reminders"
import { resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"

const signals = ["SIGTERM", "SIGINT", "beforeExit"] as const

// Supervisor stops the App with SIGTERM. A listener here would replace Node's default
// exit, and a referenced timer would hold the process open until Supervisor kills it.
test("the reminder scheduler keeps the default SIGTERM exit and does not hold the process open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-shutdown-"))
  const previousDbUrl = process.env.MEITHEAL_DB_URL
  const originalSetInterval = globalThis.setInterval
  const timers: Array<ReturnType<typeof setInterval>> = []
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  resetPersistenceForTests()
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = originalSetInterval(...args)
    timers.push(timer)
    return timer
  }) as typeof setInterval
  let firstRun: Promise<void> | undefined
  try {
    const before = signals.map(name => process.listenerCount(name))
    firstRun = startDueDateReminders()
    expect(signals.map(name => process.listenerCount(name))).toEqual(before)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.hasRef()).toBe(false)
  } finally {
    globalThis.setInterval = originalSetInterval
    stopDueDateReminders()
    // The first check runs immediately. Let it finish against this test's database
    // before the environment is restored, so it cannot open the default database.
    await firstRun
    const db = new DatabaseSync(join(directory, "test.db"))
    try {
      expect({ ...db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'tasks'").get() }).toEqual({ n: 1 })
    } finally {
      db.close()
    }
    resetPersistenceForTests()
    if (previousDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
    else process.env.MEITHEAL_DB_URL = previousDbUrl
    await rm(directory, { recursive: true, force: true })
  }
})
