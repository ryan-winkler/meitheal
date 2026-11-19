import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { todayCompletionFilter } from "../../apps/web/src/lib/task-queries"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { startCoreFixture } from "../scripts/task-pins-fixture"

function createCompletionTable(db: DatabaseSync) {
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, status TEXT, updated_at)")
}

test("Today completion windows follow the requested day and zone across calls", () => {
  const day = "2031-03-09"
  const zone = "America/Los_Angeles"
  const pacific = todayCompletionFilter(day, zone)
  expect(pacific.firstInstant).toBe(Date.parse("2031-03-09T08:00:00Z"))
  expect(todayCompletionFilter(day, "Europe/Dublin").firstInstant).toBe(Date.parse("2031-03-09T00:00:00Z"))
  expect(todayCompletionFilter("2031-03-10", zone).firstInstant).toBe(Date.parse("2031-03-10T07:00:00Z"))
  expect(todayCompletionFilter(day, zone)).toEqual(pacific)
})

for (const { timezone, day, firstInstant, nextDay, completions } of [
  {
    timezone: "America/Santiago",
    day: "2026-09-06",
    firstInstant: "2026-09-06T04:00:00.000Z",
    nextDay: "2026-09-07T03:00:00.000Z",
    completions: ["2026-09-06T04:00:00.000Z", "2026-09-06T05:00:00.000Z"],
  },
  {
    timezone: "Asia/Amman",
    day: "2021-10-29",
    firstInstant: "2021-10-28T21:00:00.000Z",
    nextDay: "2021-10-29T22:00:00.000Z",
    completions: ["2021-10-28T21:30:00.000Z", "2021-10-28T22:30:00.000Z"],
  },
]) {
  test(`Today completion predicate follows the midnight transition in ${timezone}`, () => {
    const db = new DatabaseSync(":memory:")
    try {
      createCompletionTable(db)
      const insert = db.prepare("INSERT INTO tasks (status, updated_at) VALUES ('complete', ?)")
      insert.run(Date.parse(firstInstant) - 1)
      insert.run(Date.parse(completions[0]!))
      insert.run(completions[1]!)
      insert.run(Date.parse(nextDay) - 1)
      insert.run(nextDay)
      db.prepare("INSERT INTO tasks (status, updated_at) VALUES ('pending', ?)").run(firstInstant)

      const filter = todayCompletionFilter(day, timezone)
      expect(filter.firstInstant).toBe(Date.parse(firstInstant))
      const eligible = db.prepare(`SELECT id FROM tasks WHERE ${filter.sql} ORDER BY id`).all(...filter.args)
      expect(eligible.map(row => row.id)).toEqual([2, 3, 4])
    } finally {
      db.close()
    }
  })
}

test("Today completion predicate excludes the rollback into yesterday", () => {
  const db = new DatabaseSync(":memory:")
  try {
    createCompletionTable(db)
    const insert = db.prepare("INSERT INTO tasks (status, updated_at) VALUES ('complete', ?)")
    insert.run(Date.parse("2010-11-07T02:59:59.999Z"))
    insert.run(Date.parse("2010-11-07T03:00:00Z"))
    insert.run("2010-11-07T03:00:59.999Z")
    insert.run(Date.parse("2010-11-07T03:01:00Z"))
    insert.run("2010-11-07T03:59:59.999Z")
    insert.run(Date.parse("2010-11-07T04:00:00Z"))
    insert.run("2010-11-07")
    insert.run("2010-11-08T04:00:00Z")
    insert.run("2010-11-07Z")
    insert.run("2010-11-07 junk")

    const filter = todayCompletionFilter("2010-11-07", "America/Goose_Bay")
    const archive = db.prepare(`UPDATE tasks SET status = 'archived' WHERE ${filter.sql} RETURNING id`)
    const selected = archive.all(...filter.args)
    expect(selected.map(row => row.id).sort()).toEqual([2, 3, 6, 7])
  } finally {
    db.close()
  }
})

test("Today uses one household day for mixed completion snapshots and archive", async ({ playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and authenticated ingress")
  const work = await mkdtemp(join(tmpdir(), "meitheal-today-dates-"))
  const child = startCoreFixture(work, true, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  const api = await playwright.request.newContext()
  const db = new DatabaseSync(join(work, "pins.db"), { timeout: 5_000 })
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://127.0.0.1:${info.port}`
    const base = origin + info.configuredPath
    const headers = { origin, cookie: "feedback-fixture=admin", "sec-fetch-site": "same-origin" }
    const householdHeaders = await currentBoardWriteHeaders(api, "household", headers, base)
    const timezone = "Asia/Tokyo"
    expect((await api.put(base + "/api/settings", { headers, data: { key: "timezone", value: timezone } })).ok()).toBe(true)
    const now = new Date()
    const dayIn = (timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(now)
    const today = dayIn(timezone)
    const midnight = new Date(`${today}T00:00:00+09:00`).getTime()
    const insert = db.prepare(`INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
      VALUES (?, ?, 'complete', ?, ?, ?, ?)`)
    db.exec("BEGIN IMMEDIATE")
    try {
      for (let index = 0; index < 22; index++) {
        const id = `today-${index}`
        const when = midnight + (index + 1) * 1000
        insert.run(id, id, id, id, when, index % 2 === 0 ? new Date(when).toISOString() : when)
      }
      insert.run("today-legacy-date", "Date-only row", "today-legacy-date", "today-legacy-date", midnight, today)
      insert.run("previous-day", "Late yesterday", "previous-day", "previous-day", midnight - 1, midnight - 1)
      insert.run("next-day", "Tomorrow", "next-day", "next-day", midnight + 86400000, midnight + 86400000)
      insert.run("invalid-date", "Legacy date with a suffix", "invalid-date", "invalid-date", midnight, today + " junk")
      db.exec("COMMIT")
    } catch (error) {
      db.exec("ROLLBACK")
      throw error
    }
    const boardCreated = await api.post(base + "/api/boards", { headers: householdHeaders, data: { name: "Private completion Board" } })
    expect(boardCreated.status(), await boardCreated.text()).toBe(201)
    const boardId = (await boardCreated.json()).id as string
    const foreignHeaders = await currentBoardWriteHeaders(api, boardId, headers, base)
    const foreignTitle = "Private completed task"
    const foreignTask = await api.post(base + "/api/tasks", { headers: foreignHeaders, data: { title: foreignTitle, status: "complete" } })
    expect(foreignTask.status(), await foreignTask.text()).toBe(201)
    const foreignId = (await foreignTask.json()).id as string
    const foreignCounts = await api.get(base + "/api/tasks/today-counts?completed=1", { headers: foreignHeaders })
    expect(foreignCounts.status()).toBe(200)
    expect(await foreignCounts.json()).toMatchObject({ completedToday: 1, completedTasks: [{ id: foreignId }] })
    const memberHeaders = await currentBoardWriteHeaders(api, boardId, { ...headers, cookie: "feedback-fixture=member" }, base)
    const privateCounts = await api.get(base + "/api/tasks/today-counts?completed=1", { headers: memberHeaders })
    const privateArchive = await api.post(base + "/api/tasks/clear-completed", { headers: memberHeaders, data: {} })
    for (const denied of [privateCounts, privateArchive]) {
      expect(denied.status()).toBe(404)
      expect(denied.headers()["cache-control"]).toBe("private, no-store")
      expect(await denied.text()).not.toContain(foreignTitle)
    }
    const householdCompletedCount = () => db.prepare(
      "SELECT COUNT(*) AS total FROM tasks WHERE status = 'complete' AND task_board_id IS NULL",
    ).get()?.total

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
    const page = await api.get(base + "/today", { headers })
    expect(page.status()).toBe(200)
    const pageHtml = await page.text()
    expect(pageHtml).toContain("Showing 20 of 23 completions. Archive applies to all 23.")
    expect(pageHtml).not.toContain(foreignTitle)

    const previousDay = new Date(midnight - 90_000_000).toISOString().slice(0, 10)
    const changedDay = await api.get(base + "/api/tasks/today-counts?completed=1&expected_day=" + previousDay, { headers })
    expect(changedDay.status(), await changedDay.text()).toBe(409)
    const stale = await api.post(base + "/api/tasks/clear-completed?expected_day=" + previousDay, { headers: householdHeaders, data: {} })
    expect(stale.status(), await stale.text()).toBe(409)
    expect(householdCompletedCount()).toBe(26)

    const scope = new URLSearchParams({ expected_day: today, expected_timezone: timezone })
    const differentTimezone = ["Asia/Kolkata", "Pacific/Guam"].find(candidate => dayIn(candidate) === today)!
    expect(differentTimezone).toBeTruthy()
    expect((await api.put(base + "/api/settings", { headers, data: { key: "timezone", value: differentTimezone } })).ok()).toBe(true)
    const changedZoneCounts = await api.get(base + "/api/tasks/today-counts?completed=1&" + scope, { headers })
    expect(changedZoneCounts.status(), await changedZoneCounts.text()).toBe(409)
    const changedZoneArchive = await api.post(base + "/api/tasks/clear-completed?" + scope, { headers: householdHeaders, data: {} })
    expect(changedZoneArchive.status(), await changedZoneArchive.text()).toBe(409)
    expect(householdCompletedCount()).toBe(26)

    expect((await api.put(base + "/api/settings", { headers, data: { key: "timezone", value: timezone } })).ok()).toBe(true)
    const archive = await api.post(base + "/api/tasks/clear-completed?" + scope, { headers: householdHeaders, data: {} })
    expect(archive.status(), await archive.text()).toBe(200)
    expect(await archive.json()).toMatchObject({ ok: true, cleared: 23 })
    expect(db.prepare("SELECT COUNT(*) AS total FROM tasks WHERE status = 'archived' AND task_board_id IS NULL").get()?.total).toBe(23)
    const remaining = db.prepare("SELECT id FROM tasks WHERE status = 'complete' ORDER BY id").all()
    expect(remaining.map(row => row.id)).toEqual([foreignId, "invalid-date", "next-day", "previous-day"].sort())
    const noChanges = await api.post(base + "/api/tasks/clear-completed", { headers: householdHeaders, data: {} })
    expect(noChanges.status()).toBe(200)
    expect(await noChanges.json()).toMatchObject({ ok: true, cleared: 0, message: "No completed tasks to clear" })

    const boardUrl = base + "/api/boards/" + boardId
    const currentBoard = await api.get(boardUrl, { headers: foreignHeaders })
    expect(currentBoard.status()).toBe(200)
    const { board } = await currentBoard.json()
    const retired = await api.patch(boardUrl, {
      headers: foreignHeaders, data: { action: "retire", revision: board.revision },
    })
    expect(retired.status(), await retired.text()).toBe(200)
    const retiredRead = await api.get(base + "/api/tasks/today-counts?completed=1", { headers: foreignHeaders })
    const retiredArchive = await api.post(base + "/api/tasks/clear-completed", { headers: foreignHeaders, data: {} })
    for (const denied of [retiredRead, retiredArchive]) {
      expect(denied.status()).toBe(403)
      expect(denied.headers()["cache-control"]).toBe("private, no-store")
      expect(await denied.text()).not.toContain(foreignTitle)
    }
    expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(foreignId)?.status).toBe("complete")
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
