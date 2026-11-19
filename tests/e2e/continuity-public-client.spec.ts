import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { getPersistenceClient as getPublicClient, probeDatabaseConnectivity } from "../../apps/web/src/domains/tasks/persistence/store"
import { unwrapRegisteredContinuityClient } from "../../apps/web/src/domains/tasks/persistence/continuity-client"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { OrganizationAccessRepository } from "../../apps/web/src/domains/tasks/persistence/organization-access-repository"
import { TaskRepository, type TaskCreationData } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import {
  ensurePomodoroSchema, getSessionHistory, getTimeEntries, getTimerState,
  resetPomodoroForTests, startFocus, startTimeEntryForTask, stopTimeEntryForTask,
} from "../../apps/web/src/domains/pomodoro"
import { ensureSchema, getPersistenceClient as getFixtureClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { GET as getHealth } from "../../apps/web/src/pages/api/health"

let work: string
let marker: string
let previousDb: string | undefined
const task = (id: string): TaskCreationData => ({ id, title: id, description: "", status: "pending", priority: 3,
  due_date: null, labels: "[]", framework_payload: "{}", parent_id: null, area_id: "default", custom_fields: "{}",
  start_date: null, end_date: null, progress: 0, color: null, is_favorite: 0, task_type: "task", assigned_to: null })

test.beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "continuity-public-client-"))
  marker = join(work, "grants.json")
  previousDb = process.env.MEITHEAL_DB_URL
  process.env.MEITHEAL_DB_URL = "file:" + join(work, "tasks.db")
  resetPomodoroForTests()
  resetPersistenceForTests()
  await ensureSchema({ markerPath: marker })
  await new TaskRepository(getPublicClient()).createTask(task("retained"))
})

test.afterEach(async () => {
  resetPomodoroForTests()
  resetPersistenceForTests()
  if (previousDb === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previousDb
  await rm(work, { recursive: true, force: true })
})

async function timerRecords() {
  const db = getFixtureClient()
  return {
    sessions: (await db.execute("SELECT * FROM pomodoro_sessions ORDER BY id")).rows,
    entries: (await db.execute("SELECT * FROM time_entries ORDER BY id")).rows,
  }
}

test("the public client protects direct SQL and Pomodoro services while diagnostics and independent fixture inspection remain available", async () => {
  const client = getPublicClient()
  expect(getPublicClient()).toBe(client)
  expect(client).not.toBe(getFixtureClient())
  expect((await client.execute("SELECT id FROM tasks")).rows).toEqual([{ id: "retained" }])
  expect(await startTimeEntryForTask("retained")).toMatchObject({ ok: true, entry: { taskId: "retained" } })
  expect(await stopTimeEntryForTask("retained")).toMatchObject({ ok: true, entry: { taskId: "retained" } })
  expect(await getTimeEntries("retained")).toHaveLength(1)
  const before = await timerRecords()
  const valid = await readFile(marker)
  await rm(marker)
  for (const operation of [
    () => client.execute("SELECT id FROM tasks"),
    () => client.execute("UPDATE tasks SET title = 'must not persist' WHERE id = 'retained'"),
    () => startTimeEntryForTask("retained"),
    () => stopTimeEntryForTask("retained"),
    () => startFocus("retained"),
    () => getTimeEntries("retained"),
    () => getSessionHistory(),
  ]) await expect(operation()).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
  await expect(probeDatabaseConnectivity()).resolves.toBeUndefined()
  const previousSupervisor = process.env.SUPERVISOR_TOKEN
  try {
    delete process.env.SUPERVISOR_TOKEN
    const health = await getHealth({} as Parameters<typeof getHealth>[0])
    expect(health.status).toBe(200)
    const body = await health.json()
    expect(body).toMatchObject({ service: "meitheal-web", db_status: "connected" })
    expect(JSON.stringify(body)).not.toContain("retained")
  } finally {
    if (previousSupervisor === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = previousSupervisor
  }
  expect(await timerRecords()).toEqual(before)
  expect((await getFixtureClient().execute("SELECT title FROM tasks WHERE id = 'retained'")).rows).toEqual([{ title: "retained" }])
  await writeFile(marker, valid)
  expect(await startTimeEntryForTask("retained")).toMatchObject({ ok: true })
})

test("a public task-time writer rolls back its staged mutation when continuity disappears before commit", async () => {
  await ensurePomodoroSchema()
  const before = await timerRecords()
  const tx = await getPublicClient().transaction("write")
  try {
    await tx.execute("INSERT INTO time_entries(id, task_id, started_at, duration_seconds) VALUES ('late-time', 'retained', '2026-11-19T10:00:00Z', 0)")
    await rm(marker)
    await expect(tx.commit()).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
  } finally { tx.close() }
  expect(await timerRecords()).toEqual(before)
})

test("an admitted real task-time service cannot commit after losing continuity at its INSERT", async () => {
  await ensurePomodoroSchema()
  const db = getFixtureClient()
  const transaction = db.transaction.bind(db)
  let reached!: () => void
  let resume!: () => void
  const entered = new Promise<void>(resolve => { reached = resolve })
  const release = new Promise<void>(resolve => { resume = resolve })
  db.transaction = async (...args: Parameters<typeof db.transaction>) => {
    const tx = await transaction(...args)
    const execute = tx.execute.bind(tx)
    tx.execute = async (...statements: Parameters<typeof tx.execute>) => {
      const sql = typeof statements[0] === "string" ? statements[0] : statements[0].sql
      const result = await execute(...statements)
      if (sql.startsWith("INSERT INTO time_entries")) { reached(); await release }
      return result
    }
    return tx
  }
  const before = await timerRecords()
  const operation = startTimeEntryForTask("retained")
  const denied = expect(operation).rejects.toMatchObject({ name: "ContinuityLockedError", status: 503 })
  try {
    await entered
    await rm(marker)
    resume()
    await denied
    expect(await timerRecords()).toEqual(before)
  } finally { resume(); await operation.catch(() => {}); db.transaction = transaction }
})

test("an already running real Pomodoro timer cannot publish focus completion after marker loss", async () => {
  const originalInterval = globalThis.setInterval
  let tick: (() => void) | undefined
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback
    return originalInterval(() => {}, 60_000)
  }) as typeof setInterval
  try {
    await startFocus("retained")
    const before = await timerRecords()
    await rm(marker)
    const countdown = tick!
    const remaining = getTimerState().remaining
    for (let second = 0; second <= remaining; second++) countdown()
    await expect.poll(() => getTimerState().phase).toBe("short_break")
    expect(await timerRecords()).toEqual(before)
  } finally { resetPomodoroForTests(); globalThis.setInterval = originalInterval }
})

test("journal authority writers still create Boards, restrict access and retire/restore Household through the public client", async () => {
  const client = getPublicClient()
  const boards = new NamedBoardRepository(client)
  const owner = { kind: "ha_user", id: "owner" } as const
  const created = await boards.create(owner.id, "Current named Board")
  expect(created.status).toBe("committed")
  if (created.status !== "committed") throw new Error("Expected a committed named Board")
  expect(await boards.findAccess(owner, created.result.id)).toMatchObject({ role: "owner", state: "active" })
  expect(await boards.updateRestrictions(owner.id, created.result.id, { denyCompletion: true, denyDeletion: false, denyAgentDeletion: true }))
    .toMatchObject({ status: "committed", result: true })
  expect(await new OrganizationAccessRepository(client).change({ scope: "feature", id: "goals", boardId: "" }, null, { audience: "nobody", users: [] }))
    .toMatchObject({ status: "committed", result: "saved" })
  expect(await boards.changeLifecycle(owner, "household", "retired", 1, true)).toMatchObject({ status: "committed", result: "saved" })
  expect(await boards.findAccess(owner, created.result.id)).toMatchObject({ state: "active" })
  expect(await boards.changeLifecycle(owner, "household", "active", 2, true)).toMatchObject({ status: "committed", result: "saved" })
  expect((await client.execute("SELECT id FROM tasks")).rows).toEqual([{ id: "retained" }])
})

test("only an actual registered guard is unwrapped; a journal transaction proxy keeps its barriers", async () => {
  const raw = getFixtureClient()
  expect(unwrapRegisteredContinuityClient(getPublicClient())).toBe(raw)
  const transparent = new Proxy(getPublicClient(), {})
  expect(unwrapRegisteredContinuityClient(transparent)).toBe(transparent)
  let writers = 0
  const instrumented = new Proxy(raw, { get(target, key) {
    if (key === "transaction") return async (...args: Parameters<typeof raw.transaction>) => { writers++; return target.transaction(...args) }
    const value = Reflect.get(target, key)
    return typeof value === "function" ? value.bind(target) : value
  } })
  expect(unwrapRegisteredContinuityClient(instrumented)).toBe(instrumented)
  expect(await new NamedBoardRepository(instrumented).create("owner", "Barrier preserved")).toMatchObject({ status: "committed" })
  expect(writers).toBe(2)
})
