import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"

test("Today uses one household day for mixed completion snapshots and archive", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and authenticated ingress")
  const work = await mkdtemp(join(tmpdir(), "meitheal-today-dates-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  const api = await playwright.request.newContext()
  const db = new DatabaseSync(join(work, "pins.db"))
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const base = origin + info.configuredPath
    const headers = { origin, cookie: "feedback-fixture=admin", "sec-fetch-site": "same-origin" }
    const timezone = "Asia/Tokyo"
    expect((await api.put(base + "/api/settings", { headers, data: { key: "timezone", value: timezone } })).ok()).toBe(true)
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "short" }).format(new Date())
    const midnight = new Date(`${today}T00:00:00+09:00`).getTime()
    const insert = db.prepare(`INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
      VALUES (?, ?, 'complete', ?, ?, ?, ?)`)
    for (let index = 0; index < 22; index++) {
      const id = `today-${index}`
      const when = midnight + (index + 1) * 1000
      insert.run(id, id, id, id, when, index % 2 === 0 ? new Date(when).toISOString() : when)
    }
    insert.run("today-legacy-date", "Date-only row", "today-legacy-date", "today-legacy-date", midnight, today)
    insert.run("previous-day", "Late yesterday", "previous-day", "previous-day", midnight - 1, midnight - 1)
    insert.run("next-day", "Tomorrow", "next-day", "next-day", midnight + 86400000, midnight + 86400000)

    const legacy = await api.get(base + "/api/tasks/today-counts", { headers })
    expect(legacy.status()).toBe(200)
    const counts = await legacy.json()
    expect(counts).toMatchObject({ completedToday: 23 })
    expect(counts).not.toHaveProperty("completedTasks")
    const requested = await api.get(base + "/api/tasks/today-counts?completed=1", { headers })
    expect(requested.status()).toBe(200)
    const snapshot = await requested.json()
    expect(snapshot.completedToday).toBe(23)
    expect(snapshot.completedTasks.map((task: { id: string }) => task.id))
      .toEqual(Array.from({ length: 20 }, (_, index) => `today-${21 - index}`))

    const previousDay = new Date(midnight - 90_000_000).toISOString().slice(0, 10)
    const changedDay = await api.get(base + "/api/tasks/today-counts?completed=1&expected_day=" + previousDay, { headers })
    expect(changedDay.status(), await changedDay.text()).toBe(409)
    const stale = await api.post(base + "/api/tasks/clear-completed?expected_day=" + previousDay, { headers })
    expect(stale.status(), await stale.text()).toBe(409)
    expect(db.prepare("SELECT COUNT(*) AS total FROM tasks WHERE status = 'complete'").get()?.total).toBe(25)
    const archive = await api.post(base + "/api/tasks/clear-completed?expected_day=" + today, { headers })
    expect(archive.status(), await archive.text()).toBe(200)
    expect(await archive.json()).toMatchObject({ ok: true, cleared: 23 })
    const remaining = db.prepare("SELECT id FROM tasks WHERE status = 'complete' ORDER BY id").all()
    expect(remaining.map(row => row.id)).toEqual(["next-day", "previous-day"])
    const noChanges = await api.post(base + "/api/tasks/clear-completed", { headers })
    expect(noChanges.status()).toBe(200)
    expect(await noChanges.json()).toMatchObject({ ok: true, cleared: 0, message: "No completed tasks to clear" })
  } finally {
    db.close()
    await api.dispose()
    if (child.exitCode === null) {
      const stopped = once(child, "exit")
      child.kill("SIGTERM")
      await stopped
    }
    await rm(work, { recursive: true, force: true })
  }
})
