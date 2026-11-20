import { generateAgentToken } from "../../packages/domain-auth/src/index"
import { createAgentToken, ensureAgentTokenSchema } from "../../apps/web/src/domains/auth/agent-token-store"
import { resolveAgentAuth } from "../../apps/web/src/lib/agent-token-guard"
import { verifiedBoardRequestPrincipal } from "../../apps/web/src/lib/board-request-context"
import { readWorkDestinations } from "../../apps/web/src/domains/tasks/integration-destinations"
import { saveWorkBinding } from "../../apps/web/src/domains/tasks/work-binding-manager"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
import { readTaskDeletionReceipt } from "../../apps/web/src/domains/tasks/persistence/task-deletion-receipt"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { personalPillarScope } from "../../apps/web/src/domains/pillars/pillar-owner"
import { scopeCommentOwnerKey, scopeMentionRecipientKey, type BoardScope } from "../../apps/web/src/domains/tasks/board-scope"
import { currentBoardScope, fixturePrincipal } from "../helpers/current-board-scope"
import { ScopedBoardTasks, ScopedBoardPlanning, ScopedBoardIntake, fixtureAgent } from "../helpers/scoped-board-drivers"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { NamedBoardTaskRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-task-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
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

import { editTaskHomeAssistantArea, setTaskHomeAssistantArea } from "../../apps/web/src/domains/tasks/persistence/home-assistant-task-area"
import { TaskInactivityRepository } from "../../apps/web/src/domains/tasks/persistence/task-inactivity-repository"

import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { closeHAConnection, getHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import { startCalendarSync, stopCalendarSync, syncFromHA, pushTaskToCalendar, removeTaskCalendarEvent } from "../../apps/web/src/domains/calendar/calendar-bridge"
import { startTodoSync, stopTodoSync, pushTaskToTodoList, removeTaskFromTodoList } from "../../apps/web/src/domains/todo/todo-bridge"
import { updateCalendarEvent } from "../../apps/web/src/domains/ha/ha-services"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"

import { PATCH as patchComment } from "../../apps/web/src/pages/api/tasks/[id]/comments/[commentId]"
import { resolveTaskAuthor } from "../../apps/web/src/lib/task-participant"

let directory: string
let marker: string
const previous = process.env.MEITHEAL_DB_URL
let parent = fixturePrincipal("parent")
let homeWork: BoardScope

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "meitheal-lifecycle-"))
  marker = join(directory, "grants.json")
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "meitheal.db")}`
  await ensureSchema({ markerPath: marker })
  parent = fixturePrincipal("parent")
  homeWork = await currentBoardScope(getPersistenceClient(), "household", parent)
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
  const result = await repository.create(parent, "Retained work")
  if (result.status !== "committed") throw new Error("Board creation failed")
  homeWork = await currentBoardScope(getPersistenceClient(), "household", parent)
  return { repository, id: result.result.id }
}

async function providerBinding(integration: "calendar" | "todo", sourceId: string) {
  const db = getPersistenceClient(), configuration = await readWorkDestinations(db)
  if (!configuration) throw new Error("Expected current destination metadata")
  const saved = await saveWorkBinding(db, parent, configuration.revision, {
    id: crypto.randomUUID(), generation: 1, integration, sourceId, purpose: `${integration}.sync`, enabled: true,
    destination: { boardId: "household" }, allowedOperations: (["read", "create", "edit", "complete", "reopen", "delete"] as const).map(action => ({ resource: "task", action } as const)),
  })
  if (!saved.ok) throw new Error("Expected approved provider binding")
  homeWork = await currentBoardScope(db, "household", parent)
  const resolved = await resolveIntegrationScope(db, saved.binding.id, saved.binding.generation, { resource: "task", action: "read" }, homeWork, { resource: "task", action: "edit" })
  if (!resolved.ok) throw new Error(resolved.errorCode)
  return { binding: saved.binding, context: resolved.value }
}

test("named retirement is reversible, owner-private and preserves populated Board identity", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  const { rows: [lane] } = await db.execute({ sql: "SELECT id FROM kanban_lanes WHERE board_id = ? AND key = 'pending'", args: [id] })
  const tasks = new ScopedBoardTasks(db)
  await tasks.create(parent, id, { title: "Keep this ticket", description: "Retain relationships" }, { laneId: String(lane!.id) })
  const before = await db.execute({ sql: "SELECT * FROM tasks WHERE task_board_id = ?", args: [id] })
  expect(before.rows).toHaveLength(1)
  expect(await repository.changeLifecycle(fixtureAgent("token"), id, "retired", 1)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle(fixturePrincipal("outsider"), id, "retired", 1)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle(parent, id, "retired", 99)).toMatchObject({ result: "stale" })
  expect(await repository.changeLifecycle(parent, id, "retired", 1)).toMatchObject({ status: "committed", result: "saved" })
  expect(await repository.findAccess(parent, id)).toMatchObject({ state: "retired" })
  expect((await repository.findDirectory(parent)).some(board => board.id === id)).toBe(false)
  expect(await repository.findDeleted(fixturePrincipal("outsider"))).toEqual([])
  expect(await repository.findDeleted(parent)).toEqual([{ id, name: "Retained work", revision: 2 }])
  expect(await tasks.create(parent, id, { title: "Rejected ticket", description: "" }, { laneId: String(lane!.id) })).toMatchObject({ ok: false })
  expect((await db.execute({ sql: "SELECT * FROM tasks WHERE task_board_id = ?", args: [id] })).rows).toEqual(before.rows)
  expect(await repository.changeLifecycle(parent, id, "retired", 1)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle(parent, id, "active", 2)).toMatchObject({ status: "committed", result: "saved" })
  expect(await repository.findAccess(parent, id)).toMatchObject({ state: "active", revision: 3 })
  expect((await db.execute({ sql: "SELECT * FROM tasks WHERE task_board_id = ?", args: [id] })).rows).toEqual(before.rows)
})

test("deletion restrictions apply to Board lifecycle even for an owner", async () => {
  const { repository, id } = await namedBoard()
  await repository.updateMember(parent, id, "child", { role: "owner", denyCompletion: true, denyDeletion: true }, [parent.id, "child"])
  expect(await repository.changeLifecycle(fixturePrincipal("child"), id, "retired", 1)).toMatchObject({ result: "unavailable" })
  await repository.updateRestrictions(parent, id, { denyCompletion: false, denyDeletion: true, denyAgentDeletion: true })
  expect(await repository.changeLifecycle(parent, id, "retired", 1)).toMatchObject({ result: "unavailable" })
})

test("Household retirement pauses storage and aggregates without losing work or breaking restart", async () => {
  const db = getPersistenceClient()
  const { repository, id: named } = await namedBoard()
  await db.execute(`INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at)
    VALUES ('kept-household', 'Keep shared work', 'pending', 'kept-household', 'kept-household', 1, 1)`)
  const before = (await db.execute("SELECT * FROM tasks WHERE id = 'kept-household'")).rows
  const personalOwner = personalPillarScope(parent)
  const sharedPillar = await createPillar(homeWork, { name: "Shared commitment" })
  const privatePillar = await createPillar(personalOwner, { name: "Private commitment" })
  await createPrinciple(homeWork, { pillarId: sharedPillar.id, statement: "Shared principle" })
  await createPrinciple(personalOwner, { pillarId: privatePillar.id, statement: "Private principle" })
  expect((await getPillars(homeWork)).map(pillar => pillar.id)).toEqual([sharedPillar.id])
  expect((await getPillars(personalOwner)).map(pillar => pillar.id)).toEqual([privatePillar.id])
  expect((await getTodayTaskRows("2031-07-08", true, "Europe/Dublin", new Date("2031-07-08T12:00:00Z"), homeWork)).tasks).toHaveLength(1)
  const counter = (await db.execute("SELECT ticket_high_water FROM task_boards WHERE id = 'household'")).rows
  expect(await repository.changeLifecycle(fixturePrincipal("not-manager", false), "household", "retired", 1)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle(fixtureAgent("token"), "household", "retired", 1, true)).toMatchObject({ result: "unavailable" })
  expect(await repository.changeLifecycle(parent, "household", "retired", 1, true)).toMatchObject({ status: "committed", result: "saved" })
  expect(await new BoardAccessService(db).resolve(parent, "household", { resource: "task", action: "read" })).toEqual({ ok: false, errorCode: "denied" })
  for (const sql of [
    "UPDATE tasks SET title = 'changed' WHERE id = 'kept-household'",
    "DELETE FROM tasks WHERE id = 'kept-household'",
    "INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at) VALUES ('paused', 'Paused', 'paused', 'paused', 1, 1)",
    "UPDATE areas SET name = 'changed' WHERE owner_board_id IS NULL",
    "UPDATE projects SET title = 'changed' WHERE owner_board_id IS NULL",
    "UPDATE kanban_lanes SET label = 'changed' WHERE board_id = 'household'",
  ]) await expect(db.execute(sql)).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  await expect(db.execute({
    sql: `INSERT OR REPLACE INTO tasks (id, title, status, area_id, task_board_id, board_column_id, ticket_ref,
        idempotency_key, request_id, created_at, updated_at)
      SELECT 'kept-household', 'Replacement attempt', 'pending', '__meitheal_no_area__', board.id,
        lane.id, board.ticket_prefix || '-1', 'replace-shared', 'replace-shared', 1, 1
      FROM task_boards AS board JOIN kanban_lanes AS lane ON lane.board_id = board.id
      WHERE board.id = ? AND lane.key = 'pending'`,
    args: [named],
  })).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  await expect(new TaskRepository(db, homeWork).getOpenTasks()).rejects.toMatchObject({ errorCode: "stale" })
  await expect(new TaskRepository(db, homeWork).getRecentTasks()).rejects.toMatchObject({ errorCode: "stale" })
  await expect(getTodayTaskCounts(new Date("2031-07-08T12:00:00Z"), "Europe/Dublin", true, homeWork)).rejects.toMatchObject({ errorCode: "stale" })
  await expect(getTodayTaskRows("2031-07-08", true, "Europe/Dublin", new Date("2031-07-08T12:00:00Z"), homeWork)).rejects.toMatchObject({ errorCode: "stale" })
  await expect(getTasksForView({ requireAvailable: true }, homeWork)).rejects.toMatchObject({ errorCode: "stale" })
  expect((await getPillars(personalOwner)).map(pillar => pillar.id)).toEqual([privatePillar.id])
  await expect(getPillarById(homeWork, sharedPillar.id)).rejects.toMatchObject({ errorCode: "stale" })
  await expect(getPrinciplesForPillar(homeWork, sharedPillar.id)).rejects.toMatchObject({ errorCode: "stale" })
  expect((await getAllPrinciples(personalOwner)).has(sharedPillar.id)).toBe(false)
  expect((await getPrinciplesForPillar(personalOwner, privatePillar.id)).map(principle => principle.statement)).toEqual(["Private principle"])
  await createPrinciple(personalOwner, { pillarId: privatePillar.id, statement: "Still private and writable" })
  await expect(db.execute({ sql: "UPDATE pillars SET name = 'changed' WHERE id = ?", args: [sharedPillar.id] })).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  await expect(db.execute({ sql: "DELETE FROM principles WHERE pillar_id = ?", args: [sharedPillar.id] })).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  expect(await repository.findAccess(parent, named)).toMatchObject({ state: "active" })
  resetPersistenceForTests()
  await ensureSchema({ markerPath: marker })
  const restoredDb = getPersistenceClient()
  const restarted = new NamedBoardRepository(restoredDb, marker)
  expect(await new BoardAccessService(restoredDb).resolve(parent, "household", { resource: "task", action: "read" })).toEqual({ ok: false, errorCode: "denied" })
  const transaction = await restoredDb.transaction("read")
  try { await validateStartupTaskSchema(transaction) } finally { transaction.close() }
  expect((await restoredDb.execute("SELECT * FROM tasks WHERE id = 'kept-household'")).rows).toEqual(before)
  expect((await restoredDb.execute("SELECT ticket_high_water FROM task_boards WHERE id = 'household'")).rows).toEqual(counter)
  expect(await restarted.changeLifecycle(parent, "household", "active", 2, true)).toMatchObject({ result: "saved" })
  expect(await new TaskRepository(restoredDb, await currentBoardScope(restoredDb, "household", parent)).getOpenTasks()).toHaveLength(1)
  expect((await restoredDb.execute("PRAGMA foreign_key_check")).rows).toEqual([])
})

test("empty Household can be deleted and restored before named grants initialize", async () => {
  const repository = new NamedBoardRepository(getPersistenceClient(), marker)
  expect(await repository.changeLifecycle(parent, "household", "retired", 1, true)).toMatchObject({ status: "committed", result: "saved" })
  expect(await repository.changeLifecycle(parent, "household", "active", 2, true)).toMatchObject({ status: "committed", result: "saved" })
})


test("retired Household activity, mentions, reminders and pins disappear while authorized named Goals remain", async () => {
  const recipient = scopeMentionRecipientKey(homeWork)!
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
  const pins = new TaskPinRepository(db, homeWork)
  const mentions = new CommentMentionRepository(db, homeWork)
  const reminders = new SettingsRepository(db)
  await pins.set("parent", "inbox-task", true)
  expect((await readRecentActivity(db, homeWork, {})).items).toHaveLength(1)
  expect((await mentions.page(recipient, null)).unread).toBe(1)
  expect((await reminders.getPendingReminders(homeWork)).reminders).toHaveLength(1)
  expect(await pins.hasAny("parent")).toBe(true)
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  await expect(readRecentActivity(db, homeWork, {})).rejects.toMatchObject({ errorCode: "stale" })
  await expect(mentions.page(recipient, null)).rejects.toMatchObject({ errorCode: "stale" })
  expect(await mentions.mark(recipient, null, true)).toBe(false)
  expect((await db.execute("SELECT read_at FROM comment_mentions")).rows[0]?.read_at).toBeNull()
  await expect(reminders.getPendingReminders(homeWork)).rejects.toMatchObject({ errorCode: "stale" })
  await expect(pins.hasAny("parent")).rejects.toMatchObject({ errorCode: "stale" })
  await expect(pins.list("parent", 1)).rejects.toMatchObject({ errorCode: "stale" })
  await expect(pins.get("parent", "inbox-task")).rejects.toMatchObject({ errorCode: "stale" })
  const revision = await readBoardGrantRevision(marker)
  expect(revision).not.toBeNull()
  expect(await readSharedGoals(db, await currentBoardScope(db, id, parent), {})).toMatchObject([
    { id: "named-goal", title: "Authorized named Goal", project_count: 1, completed_project_count: 1 },
  ])
  expect((await new BoardAccessService(db).resolve(fixturePrincipal("outsider", false), id, { resource: "goal", action: "read" })).ok).toBe(false)
})

function observeQueries(db: ReturnType<typeof getPersistenceClient>, observe: (sql: string) => Promise<void>) {
  const originalExecute = db.execute.bind(db), originalTransaction = db.transaction.bind(db)
  db.execute = async statement => {
    const result = await originalExecute(statement)
    await observe(typeof statement === "string" ? statement : statement.sql)
    return result
  }
  db.transaction = async (...args: Parameters<typeof db.transaction>) => {
    const tx = await originalTransaction(...args), execute = tx.execute.bind(tx)
    tx.execute = async statement => {
      const result = await execute(statement)
      await observe(typeof statement === "string" ? statement : statement.sql)
      return result
    }
    return tx
  }
  return () => { db.execute = originalExecute; db.transaction = originalTransaction }
}

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
  const pins = new TaskPinRepository(db, homeWork)
  const reactions = new TaskReactionRepository(db, homeWork)
  await pins.set("parent", "late-task", true)
  const reaction = await reactions.add({ taskId: "late-task", commentId: null }, "+", "Parent", scopeCommentOwnerKey(homeWork)!)
  expect(reaction).not.toBeNull()
  const namedTasks = new ScopedBoardTasks(db)
  await namedTasks.create(parent, id, { title: "Named still works", description: "" }, {})
  const namedTask = String((await db.execute({ sql: "SELECT id FROM tasks WHERE task_board_id = ?", args: [id] })).rows[0]!.id)
  const before = (await db.execute("SELECT * FROM task_reactions WHERE task_id = 'late-task'")).rows
  const otherWork = await currentBoardScope(db, "household", fixturePrincipal("other", false))
  const delayed = Array.from({ length: 4 }, () => delayWriters(db, 1))
  const pending = [
    new TaskPinRepository(delayed[0]!.client, homeWork).set("parent", "late-task", false),
    new TaskPinRepository(delayed[1]!.client, otherWork).set("other", "late-task", true),
    new TaskReactionRepository(delayed[2]!.client, homeWork).remove({ taskId: "late-task", commentId: null }, reaction!.id, scopeCommentOwnerKey(homeWork)!),
    new TaskReactionRepository(delayed[3]!.client, otherWork).add({ taskId: "late-task", commentId: null }, "new", "Other", scopeCommentOwnerKey(otherWork)!),
  ].map(operation => operation.then(value => ({ value }), error => ({ error })))
  await Promise.all(delayed.map(writer => writer.ready))
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  const results = []
  for (const [index, operation] of pending.entries()) {
    delayed[index]!.release()
    results.push(await operation)
  }
  for (const result of results) {
    expect("error" in result).toBe(true)
    if ("error" in result) expect(String(result.error)).toMatch(/permissions changed|continuity|work operation is unavailable/i)
  }
  expect((await new BoardAccessService(db).resolve(parent, "household", { resource: "task", action: "edit" })).ok).toBe(false)
  expect((await new BoardAccessService(db).resolve(parent, id, { resource: "task", action: "edit" })).ok).toBe(true)
  for (const statement of [
    { sql: "DELETE FROM task_pins WHERE owner_id = 'parent' AND task_id = 'late-task'" },
    { sql: "INSERT INTO task_pins(owner_id, task_id, pinned_at) VALUES ('other', 'late-task', 1)" },
    { sql: "UPDATE task_pins SET task_id = ? WHERE task_id = 'late-task'", args: [namedTask] },
    { sql: "DELETE FROM task_reactions WHERE id = ?", args: [reaction!.id] },
    { sql: "INSERT INTO task_reactions(task_id, owner_key, content, author) VALUES ('late-task', 'other', 'new', 'Other')" },
    { sql: "UPDATE task_reactions SET task_id = ? WHERE id = ?", args: [namedTask, reaction!.id] },
    { sql: "INSERT OR REPLACE INTO task_reactions(id, task_id, owner_key, content, author) VALUES (?, ?, 'other', 'new', 'Other')", args: [reaction!.id, namedTask] },
  ]) await expect(db.execute(statement)).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  expect((await db.execute("SELECT * FROM task_reactions WHERE task_id = 'late-task'")).rows).toEqual(before)
  expect((await db.execute("SELECT owner_id FROM task_pins WHERE task_id = 'late-task'")).rows).toEqual([{ owner_id: "parent" }])
  await expect(reactions.list({ taskId: "late-task", commentId: null }, Number.MAX_SAFE_INTEGER, scopeCommentOwnerKey(homeWork)!)).rejects.toMatchObject({ errorCode: "stale" })
  await expect(reactions.countCards(["late-task"])).rejects.toMatchObject({ errorCode: "stale" })
  const namedReactions = new TaskReactionRepository(db, await currentBoardScope(db, id, parent))
  const namedReaction = await namedReactions.add({ taskId: namedTask, commentId: null }, "+", "Parent", scopeCommentOwnerKey(homeWork)!)
  expect(namedReaction).not.toBeNull()
  expect(await namedReactions.remove({ taskId: namedTask, commentId: null }, namedReaction!.id, scopeCommentOwnerKey(homeWork)!)).toBe(true)
  await repository.changeLifecycle(parent, "household", "active", 2, true)
  homeWork = await currentBoardScope(db, "household", parent)
  expect((await new TaskReactionRepository(db, homeWork).list({ taskId: "late-task", commentId: null }, Number.MAX_SAFE_INTEGER, scopeCommentOwnerKey(homeWork)!))?.reactions).toHaveLength(1)
  expect(await new TaskPinRepository(db, homeWork).hasAny("parent")).toBe(true)
})


test("late Household location edits and inactivity policy changes pause; existing comment triggers reject late writes atomically", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  const old = Date.now() - 30 * 86_400_000
  await db.batch([
    { sql: `INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at)
        VALUES ('late-location', 'Location target', 'late-location', 'late-location', ?, ?),
          ('old-inactivity', 'Old inactive title', 'old-inactivity', 'old-inactivity', ?, ?)`, args: [old, old, old, old] },
    `INSERT INTO comments (task_id, content, author, owner_key) VALUES ('late-location', 'Original comment', 'Parent', '${scopeCommentOwnerKey(homeWork)}')`,
    `INSERT INTO organization_access_policies (scope, scope_id, audience, selected_users, revision)
      VALUES ('feature', 'home_assistant_area', 'everyone', '[]', 'area-policy')
      ON CONFLICT(scope, scope_id, board_id) DO UPDATE SET audience = 'everyone', selected_users = '[]', revision = 'area-policy'`,
    setTaskHomeAssistantArea(homeWork, "late-location", "kitchen"),
  ], "write")
  const commentId = Number((await db.execute("SELECT id FROM comments WHERE task_id = 'late-location'")).rows[0]!.id)
  const commentsBefore = (await db.execute("SELECT * FROM comments")).rows
  const locationBefore = (await db.execute("SELECT * FROM home_assistant_task_areas")).rows
  const inactivity = new TaskInactivityRepository(db, homeWork)
  const scope = await inactivity.preview({ areaId: null, page: 1, filter: "all", now: Date.now() })
  const policyInput = { areaId: null, days: 7, expectedRevision: scope.policy.revision,
    expectedDefaultRevision: scope.defaultPolicy.revision, areaGeneration: null, expectedAreaCatalogRevision: scope.areaCatalogRevision }
  expect(await inactivity.savePolicy(policyInput)).toMatchObject({ status: "saved" })
  const baseline = await inactivity.preview({ areaId: null, page: 1, filter: "all", now: Date.now() })
  expect(baseline.tasks.map(task => task.title)).toContain("Old inactive title")
  const policiesBefore = (await db.execute("SELECT * FROM task_inactivity_policy")).rows
  const admissions = Array.from({ length: 4 }, () => delayWriters(db, 1))
  const create = new CommentMentionRepository(admissions[0]!.client, homeWork).create("late-location", "Late comment", "Parent", scopeCommentOwnerKey(homeWork)!, [], {
    key: "b".repeat(32), issuedAt: Date.now(), rawContent: "Late comment", cutoff: 0,
  }).then(value => ({ value }), error => ({ error: String(error) }))
  const edit = new CommentMentionRepository(admissions[1]!.client, homeWork).editChecked("late-location", commentId, scopeCommentOwnerKey(homeWork)!, "Changed late comment", [])
    .then(value => ({ value }), error => ({ error: String(error) }))
  const remove = new TaskRepository(admissions[2]!.client, homeWork).deleteComment("late-location", commentId, scopeCommentOwnerKey(homeWork)!)
    .then(value => ({ value }), error => ({ error: String(error) }))
  const location = (async () => {
    const tx = await admissions[3]!.client.transaction("write")
    try { return await editTaskHomeAssistantArea(tx, homeWork, "late-location", old, 1, { id: "yard", revision: "area-policy" }) }
    finally { tx.close() }
  })()
  await Promise.all(admissions.map(writer => writer.ready))
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  // Release each admitted writer after the preceding one closes its SQLite transaction.
  // This isolates the retirement guard from unrelated same-connection busy errors.
  for (const [index, pending] of [create, edit, remove].entries()) {
    admissions[index]!.release()
    const result = await pending
    if ("error" in result) expect(result.error).toMatch(/permissions changed|continuity|work operation is unavailable/i)
    else expect(result.value).toMatchObject({ state: "not_found" })
  }
  admissions[3]!.release()
  expect(await location).toEqual({ ok: false, errorCode: "denied" })
  expect((await db.execute("SELECT * FROM comments")).rows).toEqual(commentsBefore)
  expect((await db.execute("SELECT * FROM home_assistant_task_areas")).rows).toEqual(locationBefore)
  expect((await db.execute("SELECT * FROM comment_mention_attempts")).rows).toEqual([])
  for (const sql of [
    "UPDATE home_assistant_task_areas SET area_id = 'yard' WHERE task_id = 'late-location'",
    "DELETE FROM home_assistant_task_areas WHERE task_id = 'late-location'",
    "INSERT OR REPLACE INTO home_assistant_task_areas(task_id, area_id) VALUES ('late-location', 'yard')",
    "INSERT INTO home_assistant_task_areas(task_id, area_id) VALUES ('old-inactivity', 'yard')",
  ]) await expect(db.execute(sql)).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  await expect(inactivity.preview({ areaId: null, page: 1, filter: "all", now: Date.now() })).rejects.toMatchObject({ errorCode: "stale" })
  await expect(inactivity.savePolicy({ ...policyInput, expectedRevision: baseline.policy.revision })).rejects.toMatchObject({ errorCode: "stale" })
  expect((await db.execute("SELECT * FROM task_inactivity_policy")).rows).toEqual(policiesBefore)
  const namedTasks = new ScopedBoardTasks(db)
  await namedTasks.create(parent, id, { title: "Named location remains usable", description: "" }, {})
  const namedId = String((await db.execute({ sql: "SELECT id FROM tasks WHERE task_board_id = ?", args: [id] })).rows[0]!.id)
  expect((await db.execute(setTaskHomeAssistantArea(await currentBoardScope(db, id, parent), namedId, "yard"))).rows).toHaveLength(1)
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
  const approved = await providerBinding("calendar", "calendar.fixture")
  await db.execute({ sql: "UPDATE calendar_confirmations SET binding_id=? WHERE confirmation_id='saved-calendar'", args: [approved.binding.id] })
  const calendar = (await db.execute("SELECT * FROM calendar_confirmations ORDER BY confirmation_id")).rows
  const todo = (await db.execute("SELECT * FROM todo_sync_confirmations")).rows
  const delayed = delayWriters(db, 1)
  const pending = new TaskRepository(delayed.client, approved.context.scope).commitSyncMutationChunks([{
    kind: "link", taskId: "calendar-retained",
    replacedCalendarLinks: [{ confirmationId: "saved-calendar", taskId: "calendar-retained", externalId: "old-event" }],
    confirmation: { source: "calendar", entityId: "calendar.fixture", externalId: "new-event", payload: "{}" },
  }, {
    kind: "link", taskId: "calendar-retained",
    confirmation: { source: "ha_todo", entityId: "todo.fixture", externalId: "new-todo", payload: "{}" },
  }], approved.context).then(value => ({ value }), error => ({ error }))
  await delayed.ready
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  delayed.release()
  const deniedSync = await pending
  expect("error" in deniedSync).toBe(true)
  if ("error" in deniedSync) expect(String(deniedSync.error)).toMatch(/continuity|work operation is unavailable|Board is deleted/i)
  for (const sql of [
    "DELETE FROM calendar_confirmations WHERE confirmation_id = 'saved-calendar'",
    "UPDATE calendar_confirmations SET payload = '{}' WHERE confirmation_id = 'saved-calendar'",
    "INSERT OR REPLACE INTO calendar_confirmations(confirmation_id, task_id, request_id, created_at) VALUES ('saved-calendar', 'deleted-task', 'replace-saved', 1)",
    "DELETE FROM todo_sync_confirmations WHERE confirmation_id = 'saved-todo'",
    "UPDATE todo_sync_confirmations SET payload = 'changed' WHERE confirmation_id = 'saved-todo'",
    "INSERT OR REPLACE INTO todo_sync_confirmations(confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid, created_at, updated_at) VALUES ('saved-todo', 'deleted-task', 'replace-todo', 'todo.fixture', 'other', 1, 1)",
  ]) await expect(db.execute(sql)).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  expect((await db.execute("SELECT * FROM calendar_confirmations ORDER BY confirmation_id")).rows).toEqual(calendar)
  expect((await db.execute("SELECT * FROM todo_sync_confirmations")).rows).toEqual(todo)
  // Tombstones have no parent to infer a Board from. Keep that existing schema contract.
  expect((await db.execute("SELECT task_id FROM calendar_confirmations WHERE confirmation_id = 'orphan-calendar'")).rows).toEqual([{ task_id: "deleted-task" }])
  const tasks = new ScopedBoardTasks(db)
  await tasks.create(parent, id, { title: "Named relation", description: "" }, {})
  const namedId = String((await db.execute({ sql: "SELECT id FROM tasks WHERE task_board_id = ?", args: [id] })).rows[0]!.id)
  await db.execute({ sql: "INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, created_at) VALUES ('named-confirmation', ?, 'named-receipt', 1)", args: [namedId] })
  expect((await db.execute("DELETE FROM calendar_confirmations WHERE confirmation_id = 'named-confirmation'")).rowsAffected).toBe(1)
})

test("a calendar stale-snapshot reconciliation admitted before retirement keeps a manually linked confirmation", async () => {
  const previous = Object.fromEntries(["SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
  const ha = await startHAWebSocketFixture()
  const db = getPersistenceClient()
  const approved = await providerBinding("calendar", "calendar.fixture")
  const execute = db.execute.bind(db)
  let restoreQueries = () => {}
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
    await db.execute({ sql: "UPDATE calendar_confirmations SET binding_id=? WHERE confirmation_id='manual-calendar-link'", args: [approved.binding.id] })
    const before = (await execute("SELECT * FROM calendar_confirmations WHERE confirmation_id = 'manual-calendar-link'")).rows
    restoreQueries = observeQueries(db, async sql => {
      if (sql.includes("FROM calendar_confirmations c") && sql.includes("visible_task_id")) { admitted(); await gate }
    })
    ha.setCalendarEvents([{ uid: "present-event", summary: "Current external event", start: "2026-11-18T12:00:00Z", end: "2026-11-18T13:00:00Z" }])
    await startCalendarSync({ bindingId: approved.binding.id, generation: approved.binding.generation, entityId: "calendar.fixture", syncEnabled: true, syncMode: "import", writeBack: false, syncIntervalMs: 0 })
    const syncing = syncFromHA(approved.binding.id)
    await ready
    await repository.changeLifecycle(parent, "household", "retired", 1, true)
    release()
    await syncing
    expect((await execute("SELECT * FROM calendar_confirmations WHERE confirmation_id = 'manual-calendar-link'")).rows).toEqual(before)
  } finally {
    release?.()
    restoreQueries()
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

test("retiring Household during a failed Calendar update prevents fallback external calls", async () => {
  const previous = Object.fromEntries(["SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
  const ha = await startHAWebSocketFixture({ holdServices: [{ domain: "calendar", service: "update_event" }] })
  const db = getPersistenceClient()
  const approved = await providerBinding("calendar", "calendar.fixture")
  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = "calendar-dispatch-retirement-fixture"
    closeHAConnection()
    expect(await getHAConnection()).not.toBeNull()
    await db.batch([
      `INSERT INTO tasks(id, title, idempotency_key, request_id, created_at, updated_at)
        VALUES ('outbound-calendar', 'Retained outbound task', 'outbound-calendar', 'outbound-calendar', 1, 1)`,
      `INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
        VALUES ('outbound-calendar-link', 'outbound-calendar', 'outbound-calendar-link', 'writeback-outbound-calendar', 'ha.write_back', '{"entity_id":"calendar.fixture"}', 1)`,
    ], "write")
    await db.execute("UPDATE tasks SET due_date='2031-07-08' WHERE id='outbound-calendar'")
    await db.execute({ sql: "UPDATE calendar_confirmations SET binding_id=? WHERE confirmation_id='outbound-calendar-link'", args: [approved.binding.id] })
    const before = (await db.execute("SELECT * FROM calendar_confirmations")).rows
    await startCalendarSync({ bindingId: approved.binding.id, generation: approved.binding.generation, entityId: "calendar.fixture", syncEnabled: true, syncMode: "export", writeBack: true, syncIntervalMs: 0 })
    const pushing = pushTaskToCalendar(approved.context, "outbound-calendar", "Retained outbound task", "2031-07-08")
    await expect.poll(() => ha.serviceCalls.filter(call => call.service === "update_event").length).toBe(1)
    const repository = new NamedBoardRepository(db, marker)
    expect(await repository.changeLifecycle(parent, "household", "retired", 1, true)).toMatchObject({ result: "saved" })
    ha.releaseService("calendar", "update_event", false)
    expect(await pushing).toBe(false)
    expect(ha.serviceCalls.map(call => call.service)).toEqual(["update_event"])
    expect((await db.execute("SELECT * FROM calendar_confirmations")).rows).toEqual(before)

    // Existing generic HA callers retain their fallback behavior without a task policy.
    const generic = updateCalendarEvent("calendar.other", { uid: "independent", summary: "Independent event", start: "2031-07-08", end: "2031-07-09" })
    await expect.poll(() => ha.serviceCalls.filter(call => call.service === "update_event").length).toBe(2)
    ha.releaseService("calendar", "update_event", false)
    expect(await generic).toBe(true)
    expect(ha.serviceCalls.map(call => call.service)).toEqual(["update_event", "update_event", "delete_event", "create_event"])

    expect(await repository.changeLifecycle(parent, "household", "active", 2, true)).toMatchObject({ result: "saved" })
    const refreshed = await resolveIntegrationScope(db, approved.binding.id, approved.binding.generation, { resource: "task", action: "read" }, await currentBoardScope(db, "household", parent), { resource: "task", action: "edit" })
    if (!refreshed.ok) throw new Error(refreshed.errorCode)
    const restored = pushTaskToCalendar(refreshed.value, "outbound-calendar", "Retained outbound task", "2031-07-08")
    await expect.poll(() => ha.serviceCalls.filter(call => call.service === "update_event").length).toBe(3)
    ha.releaseService("calendar", "update_event", true)
    expect(await restored).toBe(true)
  } finally {
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

test("Calendar and Todo pushes and removals recheck retirement after held confirmation lookups", async () => {
  const previous = Object.fromEntries(["SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map(key => [key, process.env[key]]))
  const ha = await startHAWebSocketFixture()
  const db = getPersistenceClient()
  const approved = await providerBinding("calendar", "calendar.fixture")
  const todoApproved = await providerBinding("todo", "todo.fixture")
  const fresh = await resolveIntegrationScope(db, approved.binding.id, approved.binding.generation, { resource: "task", action: "read" }, homeWork, { resource: "task", action: "edit" })
  if (!fresh.ok) throw new Error(fresh.errorCode)
  const calendarContext = fresh.value
  const execute = db.execute.bind(db)
  let restoreQueries = () => {}
  const gates: Array<() => void> = []
  let lookups = 0
  let operations: Promise<unknown>[] = []
  try {
    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = "held-confirmation-retirement-fixture"
    closeHAConnection()
    expect(await getHAConnection()).not.toBeNull()
    await db.batch([
      `INSERT INTO tasks(id, title, idempotency_key, request_id, created_at, updated_at)
        VALUES ('outbound-held', 'Retained task', 'outbound-held', 'outbound-held', 1, 1), ('deleted-held', 'Deleted task', 'deleted-held', 'deleted-held', 1, 1)`,
      `INSERT INTO calendar_confirmations(confirmation_id, task_id, request_id, provider_event_id, source, payload, created_at)
        VALUES ('held-calendar-link', 'outbound-held', 'held-calendar-link', 'writeback-outbound-held', 'ha.write_back', '{"entity_id":"calendar.fixture"}', 1)`,
      `INSERT INTO todo_sync_confirmations(confirmation_id, task_id, request_id, ha_entity_id, ha_todo_uid, payload, created_at, updated_at)
        VALUES ('held-todo-link', 'outbound-held', 'held-todo-link', 'todo.fixture', 'retained-uid', '{"summary":"Retained task"}', 1, 1)`,
    ], "write")
    await db.execute({ sql: "UPDATE calendar_confirmations SET binding_id=? WHERE confirmation_id='held-calendar-link'", args: [approved.binding.id] })
    await db.execute({ sql: "UPDATE todo_sync_confirmations SET binding_id=? WHERE confirmation_id='held-todo-link'", args: [todoApproved.binding.id] })
    await db.execute({ sql: `INSERT INTO calendar_confirmations(confirmation_id,task_id,request_id,provider_event_id,source,payload,created_at,binding_id)
      VALUES ('deleted-calendar','deleted-held','deleted-calendar','deleted-event','ha.write_back','{"entity_id":"calendar.fixture"}',1,?)`, args: [approved.binding.id] })
    await db.execute({ sql: `INSERT INTO todo_sync_confirmations(confirmation_id,task_id,request_id,ha_entity_id,ha_todo_uid,payload,created_at,updated_at,binding_id)
      VALUES ('deleted-todo','deleted-held','deleted-todo','todo.fixture','deleted-uid','{}',1,1,?)`, args: [todoApproved.binding.id] })
    await db.execute("UPDATE tasks SET due_date='2031-07-08' WHERE id='outbound-held'")
    const deletion = await new TaskRepository(db, homeWork).deleteWorkCommand("deleted-held")
    if (!deletion.ok) throw new Error(deletion.errorCode)
    const receipt = await readTaskDeletionReceipt(db, homeWork, deletion.eventId, "deleted-held")
    if (!receipt) throw new Error("Expected committed scoped deletion receipt")
    const calendarRemoval = await resolveIntegrationScope(db, approved.binding.id, approved.binding.generation, { resource: "task", action: "read" }, homeWork, { resource: "task", action: "delete" })
    const todoRemoval = await resolveIntegrationScope(db, todoApproved.binding.id, todoApproved.binding.generation, { resource: "task", action: "read" }, homeWork, { resource: "task", action: "delete" })
    if (!calendarRemoval.ok || !todoRemoval.ok) throw new Error("Expected deletion receiver contexts")
    const calendarBefore = (await execute("SELECT * FROM calendar_confirmations")).rows
    const todoBefore = (await execute("SELECT * FROM todo_sync_confirmations")).rows
    await startCalendarSync({ bindingId: approved.binding.id, generation: approved.binding.generation, entityId: "calendar.fixture", syncEnabled: true, syncMode: "export", writeBack: true, syncIntervalMs: 0 })
    await startTodoSync({ bindingId: todoApproved.binding.id, generation: todoApproved.binding.generation, entityId: "todo.fixture", syncEnabled: true, syncDirection: "outbound", writeBack: true })
    restoreQueries = observeQueries(db, async sql => {
      if (/FROM\s+(calendar_confirmations|todo_sync_confirmations)\s+WHERE\s+(binding_id|task_id)/.test(sql) && lookups < 4) {
        lookups++
        await new Promise<void>(resolve => { gates.push(resolve) })
      }
    })
    operations = [
      pushTaskToCalendar(calendarContext, "outbound-held", "Retained task", "2031-07-08"),
      pushTaskToTodoList("outbound-held", "Retained task", "pending", "todo.fixture", undefined, undefined, undefined, todoApproved.context),
      removeTaskCalendarEvent(calendarRemoval.value, receipt),
      removeTaskFromTodoList("deleted-held", todoRemoval.value, receipt),
    ]
    await expect.poll(() => lookups).toBe(4)
    expect(await new NamedBoardRepository(db, marker).changeLifecycle(parent, "household", "retired", 1, true)).toMatchObject({ result: "saved" })
    for (const release of gates.splice(0)) release()
    const outcomes = await Promise.allSettled(operations)
    for (const [index, result] of outcomes.entries()) {
      if (result.status === "fulfilled") expect(result.value).toBe(index === 3 ? 0 : false)
      else if (result.reason?.name === "BoardOperationError") expect(result.reason).toMatchObject({ errorCode: "stale" })
      else if (result.reason?.name === "ContinuityLockedError") expect(result.reason).toMatchObject({ status: 503 })
      else expect(String(result.reason)).toContain("Current permissions changed")
    }
    expect(ha.serviceCalls).toEqual([])
    expect((await execute("SELECT * FROM calendar_confirmations")).rows).toEqual(calendarBefore)
    expect((await execute("SELECT * FROM todo_sync_confirmations")).rows).toEqual(todoBefore)
  } finally {
    for (const release of gates) release()
    restoreQueries()
    await Promise.allSettled(operations)
    stopCalendarSync()
    stopTodoSync()
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
  expect(await new TemplateRepository(db, homeWork).findRoutines()).toHaveLength(1)
  await repository.changeLifecycle(parent, "household", "retired", 1, true)
  await expect(new TemplateRepository(db, homeWork).findAll()).rejects.toMatchObject({ errorCode: "stale" })
  await expect(new TemplateRepository(db, homeWork).findRoutines()).rejects.toMatchObject({ errorCode: "stale" })
  await expect(new TemplateRepository(db, homeWork).getRoutinesWithStats()).rejects.toMatchObject({ errorCode: "stale" })
  expect(await new ScopedBoardTasks(db).routineLibrary(parent, id)).toMatchObject([
    { id: "named-routine", name: "Named check-in remains" },
  ])
  expect(await new ScopedBoardTasks(db).routineLibrary(fixturePrincipal("outsider"), id)).toEqual([])
})


test("already-admitted unchanged-content comment PATCH denies retirement without reconciling saved mentions or receipts", async () => {
  const db = getPersistenceClient()
  const { repository, id } = await namedBoard()
  await ensureAgentTokenSchema()
  const credential = generateAgentToken(), tokenId = crypto.randomUUID()
  await createAgentToken({ id: tokenId, name: "Comment fixture", tokenHash: credential.tokenHash, tokenPrefix: credential.tokenPrefix, scopes: ["tasks:read", "tasks:write"] }, homeWork)
  homeWork = await currentBoardScope(db, "household", parent)
  const url = new URL("http://localhost/api/tasks/noop-comment/comments/1?board_id=household")
  const request = new Request(url, { method: "PATCH", headers: { "Authorization": `Bearer ${credential.token}`, "content-type": "application/json" }, body: JSON.stringify({ content: "Unchanged comment" }) })
  const agent = await resolveAgentAuth(request)
  if (!agent) throw new Error("Expected current verified automation credential")
  const locals = { behindIngress: false, agentToken: agent } as App.Locals
  const principal = await verifiedBoardRequestPrincipal({ request, locals })
  if (!principal) throw new Error("Expected actual request principal")
  const agentScope = await currentBoardScope(db, "household", principal, { resource: "task", action: "edit" })
  const actor = resolveTaskAuthor(locals)!
  const content = "Unchanged comment"
  await db.execute(`INSERT INTO tasks(id, title, idempotency_key, request_id, created_at, updated_at)
    VALUES ('noop-comment', 'Retained comment parent', 'noop-comment', 'noop-comment', 1, 1)`)
  const comments = new CommentMentionRepository(db, agentScope)
  const created = await comments.create("noop-comment", content, actor.author, actor.owner!, ["a".repeat(32)], {
    key: "c".repeat(32), issuedAt: 1, rawContent: content, cutoff: 0,
  })
  if (created.state !== "created") throw new Error("Expected initial comment")
  const commentId = Number(created.comment.id)
  await db.execute({ sql: "INSERT INTO comment_mentions(task_id, comment_id, recipient_key, created_at, withdrawn) VALUES ('noop-comment', ?, ?, 1, 1)", args: [commentId, "b".repeat(32)] })
  const before = {
    comments: (await db.execute("SELECT * FROM comments WHERE task_id = 'noop-comment'")).rows,
    mentions: (await db.execute("SELECT * FROM comment_mentions WHERE task_id = 'noop-comment' ORDER BY id")).rows,
    attempts: (await db.execute("SELECT * FROM comment_mention_attempts WHERE task_id = 'noop-comment'")).rows,
    tasks: (await db.execute("SELECT * FROM tasks WHERE id = 'noop-comment'")).rows,
  }
  let admitted!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { admitted = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const transaction = db.transaction.bind(db)
  let holdNextWriter = true
  db.transaction = async (mode?: "write" | "read" | "deferred") => {
    if (mode === "write" && holdNextWriter) {
      holdNextWriter = false
      admitted()
      await gate
    }
    return transaction(mode)
  }
  let response: Response
  try {
    const pending = patchComment({ params: { id: "noop-comment", commentId: String(commentId) }, locals, url, request,
    } as unknown as Parameters<typeof patchComment>[0])
    await ready
    await repository.changeLifecycle(parent, "household", "retired", 1, true)
    release()
    response = await pending
  } finally {
    release?.()
    db.transaction = transaction
  }
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ detail: "Work access changed. Refresh before continuing." })
  expect((await db.execute("SELECT * FROM comments WHERE task_id = 'noop-comment'")).rows).toEqual(before.comments)
  expect((await db.execute("SELECT * FROM comment_mentions WHERE task_id = 'noop-comment' ORDER BY id")).rows).toEqual(before.mentions)
  expect((await db.execute("SELECT * FROM comment_mention_attempts WHERE task_id = 'noop-comment'")).rows).toEqual(before.attempts)
  expect((await db.execute("SELECT * FROM tasks WHERE id = 'noop-comment'")).rows).toEqual(before.tasks)
  await expect(comments.replay("noop-comment", actor.owner!, "c".repeat(32), content)).rejects.toMatchObject({ errorCode: "stale" })
  const named = new ScopedBoardTasks(db)
  await named.create(parent, id, { title: "Named comments retain their existing behavior", description: "" }, {})
  const namedId = String((await db.execute({ sql: "SELECT id FROM tasks WHERE task_board_id = ?", args: [id] })).rows[0]!.id)
  for (const statement of [
    { sql: "UPDATE comments SET content = content WHERE id = ?", args: [commentId] },
    { sql: "UPDATE comments SET author = author WHERE id = ?", args: [commentId] },
    { sql: "UPDATE comments SET task_id = ? WHERE id = ?", args: [namedId, commentId] },
    { sql: "INSERT OR REPLACE INTO comments(id, task_id, content, author) VALUES (?, ?, 'Replacement', 'Other')", args: [commentId, namedId] },
    { sql: "UPDATE comment_mentions SET withdrawn = 1 WHERE comment_id = ?", args: [commentId] },
    { sql: "DELETE FROM comment_mention_attempts WHERE task_id = 'noop-comment'" },
  ]) await expect(db.execute(statement)).rejects.toThrow(/Board.*(retired|deleted)|retired.*Board/i)
  // A valid named comment may still prune its own old metadata, but must retain Household history.
  const namedComments = new CommentMentionRepository(db, await currentBoardScope(db, id, parent))
  const namedComment = await namedComments.create(namedId, "Named content", "Parent", scopeCommentOwnerKey(homeWork)!, ["a".repeat(32)], {
    key: "d".repeat(32), issuedAt: Date.now(), rawContent: "Named content", cutoff: Date.now(),
  })
  expect(namedComment.state).toBe("created")
  if (namedComment.state !== "created") throw new Error("Expected named comment")
  expect((await namedComments.editChecked(namedId, Number(namedComment.comment.id), scopeCommentOwnerKey(homeWork)!, "Named content", [])).state).toBe("ok")
  expect((await db.execute("SELECT * FROM comment_mentions WHERE task_id = 'noop-comment' ORDER BY id")).rows).toEqual(before.mentions)
  expect((await db.execute("SELECT * FROM comment_mention_attempts WHERE task_id = 'noop-comment'")).rows).toEqual(before.attempts)
})
