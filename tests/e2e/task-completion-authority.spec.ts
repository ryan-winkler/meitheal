import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { expect, test as base, type APIRequestContext } from "@playwright/test"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { startCoreFixture } from "../scripts/task-pins-fixture"

interface CompletionFixture {
  api: APIRequestContext
  db: DatabaseSync
  databaseFile: string
  path: (value: string) => string
}

const test = base.extend<{ completion: CompletionFixture; timeZone: string }>({
  timeZone: ["Europe/Dublin", { option: true }],
  completion: async ({ playwright, timeZone }, use) => {
    const work = await mkdtemp(join(tmpdir(), "meitheal-completion-api-"))
    const child = startCoreFixture(work, true, undefined, timeZone)
    const previousTimeZone = process.env.TZ
    child.stdout?.resume()
    child.stderr?.resume()
    let api
    let db
    try {
      const [info] = await once(child, "message", { signal: AbortSignal.timeout(10000) })
      const origin = `http://127.0.0.1:${info.port}`
      api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { cookie: "feedback-fixture=admin", origin } })
      const databaseFile = join(work, "pins.db")
      db = new DatabaseSync(databaseFile)
      process.env.TZ = timeZone
      await use({ api, db, databaseFile, path: (value: string) => info.configuredPath + value })
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimeZone
      db?.close()
      await api?.dispose()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit")
        child.kill()
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  },
})

async function createTask({ api, path }: CompletionFixture, title: string, fields: Record<string, string> = {}) {
  const response = await api.post(path("/api/tasks"), { data: { title, priority: 1, ...fields } })
  expect(response.status()).toBe(201)
  return response.json()
}

async function getStats({ api, path }: CompletionFixture) {
  const response = await api.get(path("/api/gamification"))
  expect(response.status()).toBe(200)
  return (await response.json()).stats
}

test("canonical transitions award once across concurrent and repeated writes and preserve successful writes when statistics fail", async ({ completion }) => {
  const { api, db, path } = completion
  const initial = await getStats(completion)
  const task = await createTask(completion, "Concurrent completion")
  const target = path(`/api/tasks/${task.id}`)
  const completed = await Promise.all([api.put(target, { data: { status: "complete" } }), api.put(target, { data: { status: "done" } })])
  expect(completed.map(response => response.status())).toEqual([200, 200])
  const results = await Promise.all(completed.map(response => response.json()))
  expect(results.filter(result => result.gamification?.xp === 50)).toHaveLength(1)
  const again = await api.put(target, { data: { status: "complete" } })
  expect((await again.json()).gamification).toBeUndefined()
  expect((await api.post(path("/api/gamification"), { data: { priority: 1 } })).status()).toBe(410)
  const recorded = await getStats(completion)
  expect(recorded.totalCompleted).toBe(initial.totalCompleted + 1)
  expect(recorded.totalPoints).toBe(initial.totalPoints + 50)
  const another = await createTask(completion, "Optional stats failure")
  db.exec("CREATE TRIGGER reject_completion_stats BEFORE INSERT ON gamification_stats BEGIN SELECT RAISE(ABORT, 'fixture failure'); END")
  const saved = await api.put(path(`/api/tasks/${another.id}`), { data: { status: "complete" } })
  expect(saved.status()).toBe(200)
  expect(await saved.json()).toMatchObject({ status: "complete", gamification: { error: "Task saved; completion statistics unavailable" } })
  expect((await (await api.get(path(`/api/tasks/${another.id}`))).json()).status).toBe("complete")
})

const weekdayRule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
const friday = "2031-02-14"
const monday = "2031-02-17"

for (const timeZone of ["America/Los_Angeles", "Pacific/Kiritimati"]) {
  test.describe(`calendar dates in ${timeZone}`, () => {
    test.use({ timeZone })

    test("completion advances the written calendar day across offsets and clock changes", async ({ completion }) => {
      const { api, db, path } = completion
      const cases = [
        { due: friday, rule: weekdayRule, next: monday },
        { due: "2031-02-14T23:30:00-08:00", rule: `${weekdayRule};UNTIL=20310217`, next: monday },
        { due: "2031-02-14 00:30:00+14:00", rule: weekdayRule, next: monday },
        { due: "2031-02-14T18:00:00", rule: weekdayRule, next: monday },
        { due: "2026-03-07t16:30:00-08:00", rule: "FREQ=DAILY;UNTIL=20260309", next: "2026-03-08" },
        { due: "2026-03-07\t16:30:00-08:00", rule: "FREQ=DAILY;UNTIL=20260309", next: "2026-03-08" },
        { due: "2026-03-08", rule: "FREQ=DAILY", next: "2026-03-09" },
        { due: "2026-01-31", rule: "FREQ=MONTHLY", next: "2026-02-28" },
        { due: "-271821-04-19T23:30:00-01:00", rule: "FREQ=DAILY", next: "-271821-04-21" },
        { due: "2031-02-14Tinvalid", rule: weekdayRule, next: null },
      ]
      for (const { due, rule, next } of cases) {
        const title = `Calendar recurrence fixture ${due}`
        const task = await createTask(completion, title, { due_date: due, recurrence_rule: rule })
        const response = await api.patch(path(`/api/tasks/${task.id}`), { data: { status: "complete" } })
        expect(response.status(), await response.text()).toBe(200)
        const rows = db.prepare("SELECT id, status, due_date FROM tasks WHERE title = ? ORDER BY ticket_number").all(title)
        expect.soft(rows, due).toEqual([
          { id: task.id, status: "complete", due_date: due },
          ...(next ? [{ id: expect.any(String), status: "pending", due_date: next }] : []),
        ])
      }
    })
  })
}

test("a failed recurrence insert rolls back guarded completion and an identical retry creates one successor", async ({ completion }) => {
  const { api, db, path } = completion
  const area = await api.post(path("/api/areas"), { data: { name: "Recurrence atomicity area" } })
  expect(area.status()).toBe(201)
  const { id: areaId } = await area.json()
  const project = await api.post(path("/api/projects"), { data: { title: "Recurrence atomicity project", area_id: areaId } })
  expect(project.status()).toBe(201)
  const { id: projectId } = await project.json()

  const title = "Recurring completion with synthetic insert failure"
  const firstStep = { id: "recurrence-step", text: "Confirm the follow-up", done: false }
  const addedStep = { id: "recurrence-added-step", text: "File the receipt", done: false }
  const checklists = JSON.stringify([firstStep])
  const completedChecklists = JSON.stringify([{ ...firstStep, done: true }, { ...addedStep, done: true }])
  const task = await createTask(completion, title, {
    area_id: areaId,
    project_id: projectId,
    assigned_to: "recurrence_fixture_owner",
    due_date: friday,
    recurrence_rule: weekdayRule,
    checklists,
  })
  const target = path(`/api/tasks/${task.id}`)
  const sourceRow = db.prepare("SELECT * FROM tasks WHERE id = ?")
  const activity = db.prepare("SELECT * FROM task_activity_log WHERE task_id = ? ORDER BY id")
  const successors = db.prepare("SELECT * FROM tasks WHERE title = ? AND id <> ?")
  const initial = sourceRow.get(task.id)!
  const initialActivity = activity.all(task.id)
  const initialStats = await getStats(completion)
  const data = {
    status: "complete",
    description: "Confirmed and filed the receipt.",
    updated_at: initial.updated_at,
    checklists: completedChecklists,
    expected_checklists: checklists,
  }

  db.exec(`CREATE TRIGGER reject_recurrence_successor BEFORE INSERT ON tasks
    WHEN NEW.title = 'Recurring completion with synthetic insert failure' AND NEW.due_date = '2031-02-17'
    BEGIN SELECT RAISE(ABORT, 'fixture rejected next occurrence'); END`)
  try {
    const failed = await api.patch(target, { data })
    expect.soft(failed.status(), await failed.text()).toBe(500)
    expect.soft(failed.headers()["content-type"]).toBe("application/problem+json")
    expect.soft(failed.headers()["x-meitheal-ha-event-authority"]).toBeUndefined()
    expect.soft(await failed.json()).toEqual({
      type: "https://meitheal.local/problems/internal-error",
      title: "Internal Server Error",
      status: 500,
      detail: "Could not save task completion. Try again.",
      error: "Could not save task completion. Try again.",
    })
    expect.soft(sourceRow.get(task.id)).toEqual(initial)
    expect.soft(activity.all(task.id)).toEqual(initialActivity)
    expect.soft(successors.all(title, task.id)).toHaveLength(0)
    const failedStats = await getStats(completion)
    expect.soft(failedStats.totalCompleted).toBe(initialStats.totalCompleted)
    expect.soft(failedStats.totalPoints).toBe(initialStats.totalPoints)
  } finally {
    db.exec("DROP TRIGGER reject_recurrence_successor")
  }

  const retried = await api.patch(target, { data })
  expect(retried.status(), await retried.text()).toBe(200)
  expect(retried.headers()["x-meitheal-ha-event-authority"]).toContain("meitheal_task_completed")
  const result = await retried.json()
  expect(result).toMatchObject({ id: task.id, ticket_key: task.ticket_key, status: "complete", gamification: { xp: 50 } })
  expect(result.task).toBeUndefined()
  expect(sourceRow.get(task.id)).toMatchObject({
    status: "complete",
    description: data.description,
    checklists: completedChecklists,
  })
  expect(sourceRow.get(task.id)?.updated_at).not.toBe(initial.updated_at)
  expect(activity.all(task.id).filter(row => row.feed_action === "closed")).toHaveLength(1)
  const next = successors.all(title, task.id)
  expect(next).toHaveLength(1)
  expect(next[0]).toMatchObject({
    title,
    description: data.description,
    status: "pending",
    due_date: monday,
    project_id: projectId,
    area_id: areaId,
    assigned_to: "recurrence_fixture_owner",
    recurrence_rule: weekdayRule,
    checklists: JSON.stringify([firstStep, addedStep]),
  })
  const recorded = await getStats(completion)
  expect(recorded.totalCompleted).toBe(initialStats.totalCompleted + 1)
  expect(recorded.totalPoints).toBe(initialStats.totalPoints + 50)
})

test("a busy writer returns a retryable problem without consuming the task version", async ({ completion }) => {
  const { api, db, path } = completion
  const title = "Recurring completion while writer is busy"
  const task = await createTask(completion, title, { due_date: friday, recurrence_rule: weekdayRule })
  const target = path(`/api/tasks/${task.id}`)
  const data = { status: "complete", updated_at: task.updated_at }
  const occurrences = db.prepare("SELECT status, due_date FROM tasks WHERE title = ? ORDER BY due_date")

  db.exec("BEGIN IMMEDIATE")
  try {
    const busy = await api.patch(target, { data })
    expect(busy.status()).toBe(503)
    expect(busy.headers()["content-type"]).toBe("application/problem+json")
    expect(busy.headers()["retry-after"]).toBe("10")
    expect(busy.headers()["x-meitheal-ha-event-authority"]).toBeUndefined()
    expect(await busy.json()).toEqual({
      type: "https://meitheal.local/problems/database-unavailable",
      title: "Database temporarily unavailable",
      status: 503,
      detail: "The local database is temporarily unavailable. Retry after the interval in the Retry-After header.",
      error: "Database temporarily unavailable",
      retry_after: 10,
    })
    expect(db.prepare("SELECT updated_at FROM tasks WHERE id = ?").get(task.id)?.updated_at).toBe(task.updated_at)
    expect(occurrences.all(title)).toEqual([{ status: "pending", due_date: friday }])
  } finally {
    db.exec("ROLLBACK")
  }

  const retried = await api.patch(target, { data })
  expect(retried.status()).toBe(200)
  expect(occurrences.all(title)).toEqual([
    { status: "complete", due_date: friday },
    { status: "pending", due_date: monday },
  ])
})

test("completion retries acquisition after a competing writer releases its lock", async ({ completion }) => {
  const { db, databaseFile } = completion
  const task = await createTask(completion, "Recurring completion after a writer lock", { due_date: friday, recurrence_rule: weekdayRule })
  const client = openDatabase(pathToFileURL(databaseFile).href)
  db.exec("BEGIN IMMEDIATE")
  try {
    const repo = new TaskRepository(client)
    const completionWrite = repo.updateTask(task.id, { status: "complete" }, { version: { updatedAt: task.updated_at } })
    db.exec("ROLLBACK")
    const result = await completionWrite
    expect(result).toMatchObject({
      ok: true,
      previousStatus: "pending",
      task: { id: task.id, status: "complete" },
      successor: { dueDate: monday },
    })
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK")
    client.close()
  }
})

test("native recurrence completion leaves the writer available for another task edit", async ({ completion }) => {
  const task = await createTask(completion, "Recurring completion beside a normal edit", { due_date: friday, recurrence_rule: weekdayRule })
  const other = await createTask(completion, "Independent task edit")
  const client = openDatabase(pathToFileURL(completion.databaseFile).href)
  try {
    const repo = new TaskRepository(client)
    const [completed, updated] = await Promise.all([
      repo.updateTask(task.id, { status: "complete" }),
      repo.updateTask(other.id, { title: "Independent task edited" }),
    ])
    expect(completed).toMatchObject({ ok: true, successor: { dueDate: monday } })
    expect(updated).toMatchObject({ ok: true, task: { id: other.id, title: "Independent task edited" } })
  } finally {
    client.close()
  }
})

for (const guarded of [false, true]) {
  test(`concurrent ${guarded ? "guarded" : "unguarded"} canonical and legacy completions create one weekday successor`, async ({ completion }) => {
    const { api, db, path } = completion
    const title = "Concurrent recurring completion"
    const task = await createTask(completion, title, { due_date: friday, recurrence_rule: weekdayRule })
    const target = path(`/api/tasks/${task.id}`)
    const ticketTarget = path(`/api/tasks/${task.ticket_key}`)
    expect(task.ticket_key).toMatch(/^MTH-\d+$/)
    const version = guarded ? { updated_at: task.updated_at } : {}
    const responses = await Promise.all([
      api.patch(target, { data: { status: "complete", ...version } }),
      api.put(ticketTarget, { data: { status: "done", ...version } }),
    ])
    expect(responses.map(response => response.status()).sort()).toEqual(guarded ? [200, 409] : [200, 200])
    const completed = await Promise.all(responses.map(response => response.json()))
    expect(completed.filter(result => result.gamification?.xp === 50)).toHaveLength(1)
    if (guarded) {
      expect(completed.find(result => result.errorCode === "TASK_VERSION_CONFLICT")).toMatchObject({ client_updated_at: task.updated_at })
    }
    const repeated = await api.put(target, { data: { status: "done" } })
    expect(repeated.status()).toBe(200)
    expect((await repeated.json()).gamification).toBeUndefined()

    const successors = db.prepare("SELECT status, due_date FROM tasks WHERE title = ? AND id <> ?").all(title, task.id)
    expect(successors).toEqual([{ status: "pending", due_date: monday }])
  })
}

test("reopening the completed source permits a fresh successor", async ({ completion }) => {
  const { api, db, path } = completion
  const title = "Reopened recurring completion"
  const task = await createTask(completion, title, { due_date: friday, recurrence_rule: weekdayRule })
  const target = path(`/api/tasks/${task.id}`)
  const successors = db.prepare("SELECT id, status, due_date FROM tasks WHERE title = ? AND id <> ? ORDER BY ticket_number")
  const completed = await api.patch(target, { data: { status: "complete", updated_at: task.updated_at } })
  expect(completed.status()).toBe(200)
  const originalSuccessors = successors.all(title, task.id)
  expect(originalSuccessors).toEqual([{ id: expect.any(String), status: "pending", due_date: monday }])

  const reopened = await api.patch(target, { data: { status: "pending", updated_at: (await completed.json()).updated_at } })
  expect(reopened.status()).toBe(200)
  expect(successors.all(title, task.id)).toEqual(originalSuccessors)
  const completedAgain = await api.patch(target, { data: { status: "complete", updated_at: (await reopened.json()).updated_at } })
  expect(completedAgain.status()).toBe(200)
  expect(await completedAgain.json()).toMatchObject({ status: "complete", gamification: { xp: 50 } })
  const allSuccessors = successors.all(title, task.id)
  expect(allSuccessors).toEqual([...originalSuccessors, { id: expect.any(String), status: "pending", due_date: monday }])
  expect(allSuccessors[1]?.id).not.toBe(originalSuccessors[0]?.id)
})

test("normalizing a stored legacy done status preserves its completed occurrence", async ({ completion }) => {
  const { api, db, path } = completion
  const title = "Historically completed recurrence"
  const task = await createTask(completion, title, { due_date: friday, recurrence_rule: weekdayRule })
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(task.id)

  const response = await api.patch(path(`/api/tasks/${task.id}`), { data: { status: "complete" } })
  expect(response.status()).toBe(200)
  expect(response.headers()["x-meitheal-ha-event-authority"]).toContain("meitheal_task_completed")
  const saved = await response.json()
  expect(saved.status).toBe("complete")
  expect(saved.gamification).toBeUndefined()
  expect(db.prepare("SELECT id, status FROM tasks WHERE title = ?").all(title)).toEqual([{ id: task.id, status: "complete" }])
})

test("a successor beyond year 9999 retains its full ISO calendar date", async ({ completion }) => {
  const { api, db, path } = completion
  const title = "Recurrence with an extended ISO year"
  const task = await createTask(completion, title, { due_date: "9999-12-31", recurrence_rule: "FREQ=DAILY" })
  const response = await api.patch(path(`/api/tasks/${task.id}`), { data: { status: "complete" } })
  expect(response.status()).toBe(200)
  expect(db.prepare("SELECT due_date FROM tasks WHERE title = ? AND id <> ?").all(title, task.id)).toEqual([
    { due_date: "+010000-01-01" },
  ])
})

for (const { label, rule } of [
  { label: "invalid legacy", rule: "LEGACY_INVALID" },
  { label: "exhausted", rule: "FREQ=DAILY;UNTIL=20310214" },
]) {
  test(`completing a task with an ${label} rule still works without creating a successor`, async ({ completion }) => {
    const { api, db, path } = completion
    const title = `Recurring task with an ${label} rule`
    const task = await createTask(completion, title, { due_date: friday })
    db.prepare("UPDATE tasks SET recurrence_rule = ? WHERE id = ?").run(rule, task.id)

    const response = await api.patch(path(`/api/tasks/${task.id}`), { data: { status: "complete" } })
    expect(response.status()).toBe(200)
    expect(await response.json()).toMatchObject({ status: "complete", gamification: { xp: 50 } })
    expect(db.prepare("SELECT id, status FROM tasks WHERE title = ?").all(title)).toEqual([{ id: task.id, status: "complete" }])
  })
}
