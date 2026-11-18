import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { NamedBoardRepository, householdBoardIsActive } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../../apps/web/src/domains/tasks/persistence/store"
import { getTodayTaskCounts, getTodayTaskRows, getTasksForView } from "../../apps/web/src/lib/task-queries"
import { createPillar, getPillars, getPillarById, resetPillarSchemaForTests } from "../../apps/web/src/domains/pillars/pillar-service"
import { createPrinciple, getAllPrinciples, getPrinciplesForPillar, resetPrincipleSchemaForTests } from "../../apps/web/src/domains/pillars/principle-service"
import { validateStartupTaskSchema } from "../../apps/web/scripts/task-schema-startup.mjs"

import { readRecentActivity } from "../../apps/web/src/domains/tasks/persistence/recent-activity"
import { CommentMentionRepository } from "../../apps/web/src/domains/tasks/persistence/comment-mention-repository"
import { SettingsRepository } from "../../apps/web/src/domains/tasks/persistence/settings-repository"
import { TaskPinRepository } from "../../apps/web/src/domains/tasks/persistence/task-pin-repository"
import { TaskReactionRepository } from "../../apps/web/src/domains/tasks/persistence/task-reaction-repository"
import { readSharedGoals } from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import { readBoardGrantRevision } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { householdWorkRoute } from "../../apps/web/src/lib/household-work-route"

import { editTaskHomeAssistantArea, setTaskHomeAssistantArea } from "../../apps/web/src/domains/tasks/persistence/home-assistant-task-area"
import { TaskInactivityRepository } from "../../apps/web/src/domains/tasks/persistence/task-inactivity-repository"

import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { closeHAConnection, getHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import { startCalendarSync, stopCalendarSync, syncFromHA } from "../../apps/web/src/domains/calendar/calendar-bridge"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"

let directory: string
let marker: string
const previous = process.env.MEITHEAL_DB_URL
const parent = { kind: "ha_user", id: "parent" } as const

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-lifecycle-"))
  marker = join(directory, "grants.json")
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "meitheal.db")}`
  await ensureSchema()
})

test.afterEach(async () => {
  resetPersistenceForTests()
  resetPillarSchemaForTests()
  resetPrincipleSchemaForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})

async function namedBoard() {
  const repository = new NamedBoardRepository(getPersistenceClient(), marker)
  const result = await repository.create(parent.id, "Retained work")
  if (result.status !== "committed") throw new Error("Board creation failed")
  return { repository, id: result.result.id }
}

test("named retirement is reversible, owner-private and preserves populated Board identity", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  const { rows: [lane] } = await db.execute({ sql: "SELECT id FROM kanban_lanes WHERE board_id = ? AND key = 'pending'", args: [id] })
  const tasks = new NamedBoardTaskRepository(db, marker)
  await tasks.create(parent, id, { title: "Keep this ticket", description: "Retain relationships" }, { laneId: String(lane!.id) })
  const before = await db.execute({ sql: "SELECT * FROM tasks WHERE task_board_id = ?", args: [id] })
  expect(before.rows).toHaveLength(1)
  expect(await repository.changeLifecycle({ kind: "agent", id: "token" }, id, "retired", 1)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle({ kind: "ha_user", id: "outsider" }, id, "retired", 1)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle(parent, id, "retired", 99)).toMatchObject({ result: "stale" })
  expect(await repository.changeLifecycle(parent, id, "retired", 1)).toMatchObject({ status: "committed", result: "saved" })
  expect(await repository.findAccess(parent, id)).toBeNull()
  expect(await repository.findDirectory(parent)).toEqual([])
  expect(await repository.findDeleted({ kind: "ha_user", id: "outsider" })).toEqual([])
  expect(await repository.findDeleted(parent)).toEqual([{ id, name: "Retained work", revision: 2 }])
  expect(await tasks.create(parent, id, { title: "Rejected ticket", description: "" }, { laneId: String(lane!.id) })).toMatchObject({ ok: false })
  expect((await db.execute({ sql: "SELECT * FROM tasks WHERE task_board_id = ?", args: [id] })).rows).toEqual(before.rows)
  expect(await repository.changeLifecycle(parent, id, "retired", 1)).toMatchObject({ result: "saved" })
  expect(await repository.changeLifecycle(parent, id, "active", 2)).toMatchObject({ status: "committed", result: "saved" })
  expect(await repository.findAccess(parent, id)).toMatchObject({ state: "active", revision: 3 })
  expect((await db.execute({ sql: "SELECT * FROM tasks WHERE task_board_id = ?", args: [id] })).rows).toEqual(before.rows)
})

test("deletion restrictions apply to Board lifecycle even for an owner", async () => {
  const { repository, id } = await namedBoard()
  await repository.updateMember(parent.id, id, "child", { role: "owner", denyCompletion: true, denyDeletion: true }, [parent.id, "child"])
  expect(await repository.changeLifecycle({ kind: "ha_user", id: "child" }, id, "retired", 1)).toMatchObject({ result: "unavailable" })
  await repository.updateRestrictions(parent.id, id, { denyCompletion: false, denyDeletion: true, denyAgentDeletion: true })
  expect(await repository.changeLifecycle(parent, id, "retired", 1)).toMatchObject({ result: "unavailable" })
})

test("Household retirement pauses storage and aggregates without losing work or breaking restart", async () => {
  const db = getPersistenceClient()
  const { repository, id: named } = await namedBoard()
  await db.execute(`INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
    VALUES ('kept-household', 'Keep shared work', 'pending', 'kept-household', 'kept-household', 1, 1)`)
  const before = (await db.execute("SELECT * FROM tasks WHERE id = 'kept-household'")).rows
  const personalOwner = "a".repeat(64)
  const sharedPillar = await createPillar({ name: "Shared commitment" })
  const privatePillar = await createPillar({ name: "Private commitment" }, personalOwner)
  await createPrinciple({ pillarId: sharedPillar.id, statement: "Shared principle" })
  await createPrinciple({ pillarId: privatePillar.id, statement: "Private principle" }, personalOwner)
  expect((await getPillars({ personalOwner })).map(pillar => pillar.id)).toEqual(expect.arrayContaining([sharedPillar.id, privatePillar.id]))
  expect((await getTodayTaskRows("2031-07-08", true)).tasks).toHaveLength(1)
  const counter = (await db.execute("SELECT ticket_high_water FROM task_boards WHERE id = 'household'")).rows
  expect(await repository.changeLifecycle(parent, "household", "retired", 1)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle({ kind: "agent", id: "token" }, "household", "retired", 1, true)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle(parent, "household", "retired", 1, true)).toMatchObject({ status: "committed", result: "saved" })
  expect(await householdBoardIsActive(db)).toBe(false)
  for (const sql of [
    "UPDATE tasks SET title = 'changed' WHERE id = 'kept-household'",
    "DELETE FROM tasks WHERE id = 'kept-household'",
    "INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at) VALUES ('paused', 'Paused', 'paused', 'paused', 1, 1)",
    "UPDATE areas SET name = 'changed' WHERE owner_board_id IS NULL",
    "UPDATE projects SET title = 'changed' WHERE owner_board_id IS NULL",
    "UPDATE kanban_lanes SET label = 'changed' WHERE board_id = 'household'",
  ]) await expect(db.execute(sql)).rejects.toThrow(/Household Board is deleted/)
  await expect(db.execute({
    sql: `INSERT OR REPLACE INTO tasks (id, title, status, area_id, task_board_id, board_column_id, ticket_ref,
        idempotency_key, request_id, created_at, updated_at)
      SELECT 'kept-household', 'Replacement attempt', 'pending', '__meitheal_no_area__', board.id,
        lane.id, board.ticket_prefix || '-1', 'replace-shared', 'replace-shared', 1, 1
      FROM task_boards AS board JOIN kanban_lanes AS lane ON lane.board_id = board.id
      WHERE board.id = ? AND lane.key = 'pending'`,
    args: [named],
  })).rejects.toThrow(/Household Board is deleted/)
  expect(await new TaskRepository(db).getOpenTasks()).toEqual([])
  expect(await new TaskRepository(db).getRecentTasks()).toEqual([])
  expect(await getTodayTaskCounts(new Date("2031-07-08T12:00:00Z"), "Europe/Dublin", true)).toMatchObject({ dueToday: 0, completedToday: 0, carriedForward: 0, remaining: 0, completedTasks: [] })
  expect(await getTodayTaskRows("2031-07-08", true)).toMatchObject({ tasks: [], completedTodayCount: 0, openUnscheduledCount: 0 })
  expect((await getTasksForView()).tasks).toEqual([])
  expect((await getPillars({ personalOwner })).map(pillar => pillar.id)).toEqual([privatePillar.id])
  expect(await getPillarById(sharedPillar.id)).toBeNull()
  expect(await getPrinciplesForPillar(sharedPillar.id)).toEqual([])
  expect((await getAllPrinciples(personalOwner)).has(sharedPillar.id)).toBe(false)
  expect((await getPrinciplesForPillar(privatePillar.id, personalOwner)).map(principle => principle.statement)).toEqual(["Private principle"])
  await createPrinciple({ pillarId: privatePillar.id, statement: "Still private and writable" }, personalOwner)
  await expect(db.execute({ sql: "UPDATE pillars SET name = 'changed' WHERE id = ?", args: [sharedPillar.id] })).rejects.toThrow(/Household Board is deleted/)
  await expect(db.execute({ sql: "DELETE FROM principles WHERE pillar_id = ?", args: [sharedPillar.id] })).rejects.toThrow(/Household Board is deleted/)
  expect(await repository.findAccess(parent, named)).toMatchObject({ state: "active" })
  resetPersistenceForTests()
  await ensureSchema()
  const restoredDb = getPersistenceClient()
  const restarted = new NamedBoardRepository(restoredDb, marker)
  expect(await householdBoardIsActive(restoredDb)).toBe(false)
  const transaction = await restoredDb.transaction("read")
  try { await validateStartupTaskSchema(transaction) } finally { transaction.close() }
  expect((await restoredDb.execute("SELECT * FROM tasks WHERE id = 'kept-household'")).rows).toEqual(before)
  expect((await restoredDb.execute("SELECT ticket_high_water FROM task_boards WHERE id = 'household'")).rows).toEqual(counter)
  expect(await restarted.changeLifecycle(parent, "household", "active", 2, true)).toMatchObject({ result: "saved" })
  expect(await new TaskRepository(restoredDb).getOpenTasks()).toHaveLength(1)
  expect((await restoredDb.execute("PRAGMA foreign_key_check")).rows).toEqual([])
})

test("empty Household can be deleted and restored before named grants initialize", async () => {
  const repository = new NamedBoardRepository(getPersistenceClient(), marker)
  expect(await repository.changeLifecycle(parent, "household", "retired", 1, true)).toMatchObject({ status: "committed", result: "saved" })
  expect(await repository.changeLifecycle(parent, "household", "active", 2, true)).toMatchObject({ status: "committed", result: "saved" })
})


test("retired Household activity, mentions, reminders and pins disappear while authorized named Goals remain", async () => {
  const recipient = "a".repeat(32)
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  await db.batch([
    `INSERT INTO tasks (id, title, status, reminder_at, idempotency_key, request_id, created_at, updated_at)
      VALUES ('inbox-task', 'Private after removal', 'pending', '2000-01-01T00:00:00Z', 'inbox-task', 'inbox-task', 1, 1)`,
    `INSERT INTO task_activity_log (task_id, field, actor, created_at, feed_action)
      VALUES ('inbox-task', 'created', 'parent', 1, 'added')`,
    `INSERT INTO comments (task_id, content, author, owner_key) VALUES ('inbox-task', 'Retained comment', 'Parent', 'parent')`,
    `INSERT INTO comment_mentions (task_id, comment_id, recipient_key, created_at)
      SELECT 'inbox-task', id, '${recipient}', ${Date.now()} FROM comments WHERE task_id = 'inbox-task'`,
    { sql: "INSERT INTO areas (id, name, owner_board_id, created_at, updated_at) VALUES ('named-area', 'Named Area', ?, 1, 1)", args: [id] },
    { sql: "INSERT INTO goals (id, title, area_id, owner_board_id, created_at, updated_at) VALUES ('named-goal', 'Authorized named Goal', 'named-area', ?, 1, 1)", args: [id] },
    { sql: "INSERT INTO projects (id, title, goal_id, area_id, owner_board_id, status, created_at, updated_at) VALUES ('named-project', 'Completed named Project', 'named-goal', 'named-area', ?, 'completed', 1, 1)", args: [id] },
  ], "write")
  const pins = new TaskPinRepository(db)
  const mentions = new CommentMentionRepository(db)
  const reminders = new SettingsRepository(db)
  await pins.set("parent", "inbox-task", true)
  expect((await readRecentActivity(db, {})).items).toHaveLength(1)
  expect((await mentions.page(recipient, null)).unread).toBe(1)
  expect((await reminders.getPendingReminders()).reminders).toHaveLength(1)
  expect(await pins.hasAny("parent")).toBe(true)
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  expect((await readRecentActivity(db, {})).items).toEqual([])
  expect(await mentions.page(recipient, null)).toEqual({ rows: [], unread: 0, next: null })
  expect(await mentions.mark(recipient, null, true)).toBe(true)
  expect((await db.execute("SELECT read_at FROM comment_mentions")).rows[0]?.read_at).toBeNull()
  expect((await reminders.getPendingReminders()).reminders).toEqual([])
  expect(await pins.hasAny("parent")).toBe(false)
  expect(await pins.list("parent", 1)).toEqual({ page: 1, total: 0, items: [] })
  expect(await pins.get("parent", "inbox-task")).toBeNull()
  for (const method of ["GET", "HEAD"]) expect(householdWorkRoute("/api/goals", method)).toBe(false)
  expect(householdWorkRoute("/api/goals", "POST")).toBe(true)
  const revision = await readBoardGrantRevision(marker)
  expect(revision).not.toBeNull()
  expect(await readSharedGoals(db, parent.id, {}, revision!)).toMatchObject([
    { id: "named-goal", title: "Authorized named Goal", project_count: 1, completed_project_count: 1 },
  ])
  expect(await readSharedGoals(db, "outsider", {}, revision!)).toEqual([])
})

function delayWriters(db: ReturnType<typeof getPersistenceClient>, expected: number) {
  let release!: () => void
  let observed!: () => void
  let count = 0
  const ready = new Promise<void>(resolve => { observed = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const client = new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      if ((key === "execute" || key === "batch" || key === "transaction") && typeof value === "function") {
        return async (...args: unknown[]) => {
          count++
          if (count === expected) observed()
          await gate
          return Reflect.apply(value, target, args)
        }
      }
      return typeof value === "function" ? value.bind(target) : value
    },
  })
  return { client, ready, release }
}

test("admitted late pin and reaction writers cannot change a retired Household, including raw replacement and reparenting", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  await db.execute(`INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at)
    VALUES ('late-task', 'Late writer target', 'late-task', 'late-task', 1, 1)`)
  const pins = new TaskPinRepository(db)
  const reactions = new TaskReactionRepository(db)
  await pins.set("parent", "late-task", true)
  const reaction = await reactions.add({ taskId: "late-task", commentId: null }, "+", "Parent", "parent")
  expect(reaction).not.toBeNull()
  const namedTasks = new NamedBoardTaskRepository(db, marker)
  await namedTasks.create(parent, id, { title: "Named still works", description: "" }, {})
  const namedTask = String((await db.execute({ sql: "SELECT id FROM tasks WHERE task_board_id = ?", args: [id] })).rows[0]!.id)
  const before = (await db.execute("SELECT * FROM task_reactions WHERE task_id = 'late-task'")).rows
  const delayed = delayWriters(db, 4)
  const pending = [
    new TaskPinRepository(delayed.client).set("parent", "late-task", false),
    new TaskPinRepository(delayed.client).set("other", "late-task", true),
    new TaskReactionRepository(delayed.client).remove({ taskId: "late-task", commentId: null }, reaction!.id, "parent"),
    new TaskReactionRepository(delayed.client).add({ taskId: "late-task", commentId: null }, "new", "Parent", "other"),
  ]
  await delayed.ready
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  delayed.release()
  expect(await Promise.all(pending)).toEqual([null, null, false, null])
  for (const statement of [
    { sql: "DELETE FROM task_pins WHERE owner_id = 'parent' AND task_id = 'late-task'" },
    { sql: "INSERT INTO task_pins(owner_id, task_id, pinned_at) VALUES ('other', 'late-task', 1)" },
    { sql: "UPDATE task_pins SET task_id = ? WHERE task_id = 'late-task'", args: [namedTask] },
    { sql: "DELETE FROM task_reactions WHERE id = ?", args: [reaction!.id] },
    { sql: "INSERT INTO task_reactions(task_id, owner_key, content, author) VALUES ('late-task', 'other', 'new', 'Other')" },
    { sql: "UPDATE task_reactions SET task_id = ? WHERE id = ?", args: [namedTask, reaction!.id] },
    { sql: "INSERT OR REPLACE INTO task_reactions(id, task_id, owner_key, content, author) VALUES (?, ?, 'other', 'new', 'Other')", args: [reaction!.id, namedTask] },
  ]) await expect(db.execute(statement)).rejects.toThrow(/Household Board is deleted/)
  expect((await db.execute("SELECT * FROM task_reactions WHERE task_id = 'late-task'")).rows).toEqual(before)
  expect((await db.execute("SELECT owner_id FROM task_pins WHERE task_id = 'late-task'")).rows).toEqual([{ owner_id: "parent" }])
  expect(await reactions.list({ taskId: "late-task", commentId: null }, Number.MAX_SAFE_INTEGER, "parent")).toBeNull()
  expect(await reactions.countCards(["late-task"])).toEqual({})
  const namedReaction = await reactions.add({ taskId: namedTask, commentId: null }, "+", "Parent", "parent")
  expect(namedReaction).not.toBeNull()
  expect(await reactions.remove({ taskId: namedTask, commentId: null }, namedReaction!.id, "parent")).toBe(true)
  await repository.changeLifecycle(parent, "household", "active", 2, true)
  expect((await reactions.list({ taskId: "late-task", commentId: null }, Number.MAX_SAFE_INTEGER, "parent"))?.reactions).toHaveLength(1)
  expect(await pins.hasAny("parent")).toBe(true)
})


test("late Household location edits and inactivity policy changes pause; existing comment triggers reject late writes atomically", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  const old = Date.now() - 30 * 86_400_000
  await db.batch([
    { sql: `INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at)
        VALUES ('late-location', 'Location target', 'late-location', 'late-location', ?, ?),
          ('old-inactivity', 'Old inactive title', 'old-inactivity', 'old-inactivity', ?, ?)`, args: [old, old, old, old] },
    `INSERT INTO comments (task_id, content, author, owner_key) VALUES ('late-location', 'Original comment', 'Parent', 'parent')`,
    `INSERT INTO organization_access_policies (scope, scope_id, audience, selected_users, revision)
      VALUES ('feature', 'home_assistant_area', 'everyone', '[]', 'area-policy')
      ON CONFLICT(scope, scope_id, board_id) DO UPDATE SET audience = 'everyone', selected_users = '[]', revision = 'area-policy'`,
    setTaskHomeAssistantArea("late-location", "kitchen"),
  ], "write")
  const commentId = Number((await db.execute("SELECT id FROM comments WHERE task_id = 'late-location'")).rows[0]!.id)
  const commentsBefore = (await db.execute("SELECT * FROM comments")).rows
  const locationBefore = (await db.execute("SELECT * FROM home_assistant_task_areas")).rows
  const inactivity = new TaskInactivityRepository(db)
  const scope = await inactivity.preview({ areaId: null, page: 1, filter: "all", now: Date.now() })
  const policyInput = { areaId: null, days: 7, expectedRevision: scope.policy.revision,
    expectedDefaultRevision: scope.defaultPolicy.revision, areaGeneration: null, expectedAreaCatalogRevision: scope.areaCatalogRevision }
  expect(await inactivity.savePolicy(policyInput)).toMatchObject({ status: "saved" })
  const baseline = await inactivity.preview({ areaId: null, page: 1, filter: "all", now: Date.now() })
  expect(baseline.tasks.map(task => task.title)).toContain("Old inactive title")
  const policiesBefore = (await db.execute("SELECT * FROM task_inactivity_policy")).rows
  const admissions = Array.from({ length: 4 }, () => delayWriters(db, 1))
  const create = new CommentMentionRepository(admissions[0]!.client).create("late-location", "Late comment", "Parent", "parent", [], {
    key: "b".repeat(32), issuedAt: Date.now(), rawContent: "Late comment", cutoff: 0,
  }).then(value => ({ value }), error => ({ error: String(error) }))
  const edit = new CommentMentionRepository(admissions[1]!.client).editChecked("late-location", commentId, "parent", "Changed late comment", [])
    .then(value => ({ value }), error => ({ error: String(error) }))
  const remove = new TaskRepository(admissions[2]!.client).deleteComment("late-location", commentId, "parent")
    .then(value => ({ value }), error => ({ error: String(error) }))
  const location = (async () => {
    const tx = await admissions[3]!.client.transaction("write")
    try { return await editTaskHomeAssistantArea(tx, "late-location", null, old, 1, { id: "yard", revision: "area-policy" }) }
    finally { tx.close() }
  })()
  await Promise.all(admissions.map(writer => writer.ready))
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  // Release each admitted writer after the preceding one closes its SQLite transaction.
  // This isolates the retirement guard from unrelated same-connection busy errors.
  for (const [index, pending] of [create, edit, remove].entries()) {
    admissions[index]!.release()
    expect(await pending).toMatchObject({ error: expect.stringContaining("Household Board is deleted") })
  }
  admissions[3]!.release()
  expect(await location).toEqual({ ok: false, errorCode: "unavailable" })
  expect((await db.execute("SELECT * FROM comments")).rows).toEqual(commentsBefore)
  expect((await db.execute("SELECT * FROM home_assistant_task_areas")).rows).toEqual(locationBefore)
  expect((await db.execute("SELECT * FROM comment_mention_attempts")).rows).toEqual([])
  for (const sql of [
    "UPDATE home_assistant_task_areas SET area_id = 'yard' WHERE task_id = 'late-location'",
    "DELETE FROM home_assistant_task_areas WHERE task_id = 'late-location'",
    "INSERT OR REPLACE INTO home_assistant_task_areas(task_id, area_id) VALUES ('late-location', 'yard')",
    "INSERT INTO home_assistant_task_areas(task_id, area_id) VALUES ('old-inactivity', 'yard')",
  ]) await expect(db.execute(sql)).rejects.toThrow(/Household Board is deleted/)
  expect(householdWorkRoute("/inactivity", "GET")).toBe(true)
  expect(householdWorkRoute("/api/task-inactivity", "POST")).toBe(true)
  expect(await inactivity.preview({ areaId: null, page: 1, filter: "all", now: Date.now() })).toMatchObject({ tasks: [], total: 0, areas: [], hasEffectivePolicy: false })
  expect(await inactivity.savePolicy({ ...policyInput, expectedRevision: baseline.policy.revision })).toMatchObject({ status: "stale" })
  expect((await db.execute("SELECT * FROM task_inactivity_policy")).rows).toEqual(policiesBefore)
  const namedTasks = new NamedBoardTaskRepository(db, marker)
  await namedTasks.create(parent, id, { title: "Named location remains usable", description: "" }, {})
  const namedId = String((await db.execute({ sql: "SELECT id FROM tasks WHERE task_board_id = ?", args: [id] })).rows[0]!.id)
  expect((await db.execute(setTaskHomeAssistantArea(namedId, "yard"))).rows).toHaveLength(1)
})


test("confirmation-only sync writers and raw metadata changes retain retired Household links and named boundaries", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  await db.execute(`INSERT INTO tasks(id, title, idempotency_key, request_id, created_at, updated_at)
    VALUES ('calendar-retained', 'Hand-made task', 'calendar-retained', 'calendar-retained', 1, 1)`)
  await db.batch([
    `INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
      VALUES ('saved-calendar', 'calendar-retained', 'saved-calendar', 'old-event', 'ha.calendar_sync', '{"entity_id":"calendar.fixture"}', 1)`,
    `INSERT INTO todo_sync_confirmations(confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid, payload, created_at, updated_at)
      VALUES ('saved-todo', 'calendar-retained', 'saved-todo', 'todo.fixture', 'old-todo', '{}', 1, 1)`,
    `INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
      VALUES ('orphan-calendar', 'deleted-task', 'orphan-calendar', 'deleted-event', 'ha.calendar_sync', '{}', 1)`,
  ], "write")
  const calendar = (await db.execute("SELECT * FROM calendar_confirmations ORDER BY confirmation_id")).rows
  const todo = (await db.execute("SELECT * FROM todo_sync_confirmations")).rows
  const delayed = delayWriters(db, 1)
  const pending = new TaskRepository(delayed.client).commitSyncMutationChunks([{
    kind: "link", taskId: "calendar-retained",
    replacedCalendarLinks: [{ confirmationId: "saved-calendar", taskId: "calendar-retained", externalId: "old-event" }],
    confirmation: { source: "calendar", entityId: "calendar.fixture", externalId: "new-event", payload: "{}" },
  }, {
    kind: "link", taskId: "calendar-retained",
    confirmation: { source: "ha_todo", entityId: "todo.fixture", externalId: "new-todo", payload: "{}" },
  }])
  await delayed.ready
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  delayed.release()
  expect(await pending).toMatchObject({ created: 0, updated: 0, linked: 0, skipped: 2, errors: [] })
  for (const sql of [
    "DELETE FROM calendar_confirmations WHERE confirmation_id = 'saved-calendar'",
    "UPDATE calendar_confirmations SET payload = '{}' WHERE confirmation_id = 'saved-calendar'",
    "INSERT OR REPLACE INTO calendar_confirmations(confirmation_id, task_id, request_id, created_at) VALUES ('saved-calendar', 'deleted-task', 'replace-saved', 1)",
    "DELETE FROM todo_sync_confirmations WHERE confirmation_id = 'saved-todo'",
    "UPDATE todo_sync_confirmations SET payload = 'changed' WHERE confirmation_id = 'saved-todo'",
    "INSERT OR REPLACE INTO todo_sync_confirmations(confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid, created_at, updated_at) VALUES ('saved-todo', 'deleted-task', 'replace-todo', 'todo.fixture', 'other', 1, 1)",
  ]) await expect(db.execute(sql)).rejects.toThrow(/Household Board is deleted/)
  expect((await db.execute("SELECT * FROM calendar_confirmations ORDER BY confirmation_id")).rows).toEqual(calendar)
  expect((await db.execute("SELECT * FROM todo_sync_confirmations")).rows).toEqual(todo)
  // Tombstones have no parent to infer a Board from. Keep that existing schema contract.
  expect((await db.execute("SELECT task_id FROM calendar_confirmations WHERE confirmation_id = 'orphan-calendar'")).rows).toEqual([{ task_id: "deleted-task" }])
  const tasks = new NamedBoardTaskRepository(db, marker)
  await tasks.create(parent, id, { title: "Named relation", description: "" }, {})
  const namedId = String((await db.execute({ sql: "SELECT id FROM tasks WHERE task_board_id = ?", args: [id] })).rows[0]!.id)
  await db.execute({ sql: "INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, created_at) VALUES ('named-confirmation', ?, 'named-receipt', 1)", args: [namedId] })
  expect((await db.execute("DELETE FROM calendar_confirmations WHERE confirmation_id = 'named-confirmation'")).rowsAffected).toBe(1)
})

test("a calendar stale-snapshot reconciliation admitted before retirement keeps a manually linked confirmation", async () => {
  const previous = Object.fromEntries(["SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
  const ha = await startHAWebSocketFixture()
  const db = getPersistenceClient()
  const execute = db.execute.bind(db)
  let admitted!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { admitted = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = "calendar-retirement-fixture"
    closeHAConnection()
    expect(await getHAConnection()).not.toBeNull()
    const repository = new NamedBoardRepository(db, marker)
    await db.batch([
      `INSERT INTO tasks(id, title, idempotency_key, request_id, created_at, updated_at)
        VALUES ('manually-linked', 'Unrelated hand-made task', 'manually-linked', 'manually-linked', 1, 1)`,
      `INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
        VALUES ('manual-calendar-link', 'manually-linked', 'manual-calendar-link', 'missing-from-feed', 'ha.calendar_sync', '{"entity_id":"calendar.fixture"}', 1)`,
    ], "write")
    const before = (await execute("SELECT * FROM calendar_confirmations WHERE confirmation_id = 'manual-calendar-link'")).rows
    db.execute = async statement => {
      const result = await execute(statement)
      const sql = typeof statement === "string" ? statement : statement.sql
      if (sql.includes("AS created_by_sync") && sql.includes("FROM calendar_confirmations c")) {
        admitted()
        await gate
      }
      return result
    }
    ha.setCalendarEvents([{ uid: "present-event", summary: "Current external event", start: "2026-11-18T12:00:00Z", end: "2026-11-18T13:00:00Z" }])
    startCalendarSync({ entityId: "calendar.fixture", syncEnabled: true, syncMode: "import", writeBack: false, syncIntervalMs: 0 })
    const syncing = syncFromHA("calendar.fixture")
    await ready
    await repository.changeLifecycle(parent, "household", "retired", 1, true)
    release()
    await syncing
    expect((await execute("SELECT * FROM calendar_confirmations WHERE confirmation_id = 'manual-calendar-link'")).rows).toEqual(before)
  } finally {
    release?.()
    db.execute = execute
    stopCalendarSync()
    stopEntitySubscription()
    closeHAConnection()
    await ha.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("global Routine library keeps named check-ins when shared Household Routine readers pause", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  await db.batch([
    { sql: "INSERT INTO areas(id, name, owner_board_id, created_at, updated_at) VALUES ('routine-area', 'Named Area', ?, 1, 1)", args: [id] },
    { sql: `INSERT INTO task_templates(id, name, template_json, is_routine, cadence, owner_board_id, created_at, updated_at)
        VALUES ('named-routine', 'Named check-in remains', '{"area_id":"routine-area"}', 1, 'daily', ?, 1, 1)`, args: [id] },
    `INSERT INTO task_templates(id, name, template_json, is_routine, cadence, created_at, updated_at)
        VALUES ('shared-routine', 'Saved shared Routine', '{"area_id":"default"}', 1, 'daily', 1, 1)`,
  ], "write")
  expect(await new TemplateRepository(db).findRoutines()).toHaveLength(1)
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  expect(householdWorkRoute("/habits", "GET")).toBe(false)
  expect(householdWorkRoute("/habits", "HEAD")).toBe(false)
  expect(householdWorkRoute("/api/habits", "POST")).toBe(true)
  expect(await new TemplateRepository(db).findAll()).toEqual([])
  expect(await new TemplateRepository(db).findRoutines()).toEqual([])
  expect(await new TemplateRepository(db).getRoutinesWithStats()).toEqual([])
  expect(await new NamedBoardTaskRepository(db, marker).routineLibrary(parent)).toMatchObject([
    { id: "named-routine", name: "Named check-in remains" },
  ])
  expect(await new NamedBoardTaskRepository(db, marker).routineLibrary({ kind: "ha_user", id: "outsider" })).toEqual([])
})
