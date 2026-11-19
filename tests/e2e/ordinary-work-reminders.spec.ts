import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { ensureSchema, getPersistenceClient, resetPersistenceForTests } from "../helpers/persistence-fixture"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { getHAConnection, closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import { registerVerifiedPrincipal } from "../../apps/web/src/domains/tasks/board-scope"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import { readWorkDestinations, type WorkBinding } from "../../apps/web/src/domains/tasks/integration-destinations"
import { saveWorkBinding } from "../../apps/web/src/domains/tasks/work-binding-manager"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { checkDueDates, stopDueDateReminders } from "../../apps/web/src/domains/notifications/due-date-reminders"

let directory: string, ha: Awaited<ReturnType<typeof startHAWebSocketFixture>>
let previous: Record<string, string | undefined>
const keys = ["MEITHEAL_DB_URL", "HA_BASE_URL", "HA_TOKEN", "SUPERVISOR_TOKEN"] as const
const owner = () => registerVerifiedPrincipal({ kind: "ha_user", id: "parent" }, { administrator: true, expiresAt: Date.now() + 60_000 })
async function scope(boardId: string) {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(owner(), boardId, { resource: "task", action: "create" })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
async function board() {
  const created = await new NamedBoardRepository(getPersistenceClient()).create(owner(), "Work")
  if (created.status !== "committed") throw new Error("Board unavailable")
  return created.result.id
}
async function receiver(boardId: string, sourceId: string, previous?: WorkBinding) {
  const db = getPersistenceClient(), config = await readWorkDestinations(db)
  if (!config) throw new Error("Expected enrollment")
  const saved = await saveWorkBinding(db, owner(), config.revision, previous ? { ...previous, enabled: false } : {
    id: randomUUID(), generation: 1, integration: "calendar_reminder", sourceId, purpose: "calendar.reminder", enabled: true,
    destination: { boardId }, allowedOperations: [{ resource: "task", action: "read" }],
  })
  if (!saved.ok) throw new Error("Receiver unavailable")
  return saved.binding
}
async function enrollObserver(boardId: string, kind: "reminders" | "overdue") {
  const db = getPersistenceClient(), config = await readWorkDestinations(db)
  if (!config) throw new Error("Expected enrollment")
  const saved = await saveWorkBinding(db, owner(), config.revision, {
    id: randomUUID(), generation: 1, integration: "builtin", sourceId: `builtin:${kind}:${boardId}`,
    purpose: `builtin.${kind}.observe`, enabled: true, destination: { boardId },
    allowedOperations: [{ resource: "task", action: "read" }, { resource: "task", action: "edit" }],
  })
  if (!saved.ok) throw new Error("Observer unavailable")
}
async function task(boardId: string, title: string, due: number, projectId?: string) {
  const repo = new TaskRepository(getPersistenceClient(), await scope(boardId))
  const prepared = await prepareTaskCreation(repo, { title, due_date: new Date(due).toISOString(), ...(projectId ? { project_id: projectId } : {}) }, { useDefaultAssignee: false })
  if (!prepared.ok) throw new Error(prepared.error)
  const created = await repo.createWorkCommand(prepared.task)
  if (!created.ok) throw new Error(created.errorCode)
  return created.task
}
test.beforeEach(async () => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  directory = await mkdtemp(join(tmpdir(), "ordinary-reminder-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
  await ensureSchema()
  ha = await startHAWebSocketFixture({ holdServices: [{ domain: "calendar", service: "create_event" }] })
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "ordinary-reminder-source-fixture"
  expect(await getHAConnection()).not.toBeNull()
  await getPersistenceClient().execute({ sql: "INSERT INTO settings(key,value,updated_at) VALUES ('notification_preferences',?,1)", args: [JSON.stringify({ enabled: true, channels: { sidebar: false, mobile_push: false } })] })
})
test.afterEach(async () => {
  stopDueDateReminders(); stopEntitySubscription(); closeHAConnection()
  await ha.close()
  resetPersistenceForTests()
  for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]
  await rm(directory, { recursive: true, force: true })
})

test("an approved calendar reminder keeps its Board and stops after receiver revocation", async () => {
  const work = await board(), binding = await receiver("household", "calendar.home"), now = Date.now()
  await task("household", "First Home reminder", now + 60_000)
  await task("household", "Second Home reminder", now + 120_000)
  await task(work, "Private Work reminder", now + 30_000)
  const run = checkDueDates(now)
  await expect.poll(() => ha.serviceCalls.filter(call => call.service === "create_event").length).toBe(1)
  expect(ha.serviceCalls[0]?.service_data.summary).toContain("First Home reminder")
  await receiver("household", "calendar.home", binding)
  ha.releaseService("calendar", "create_event")
  await run
  await checkDueDates(now + 1_000)
  expect(ha.serviceCalls.filter(call => call.service === "create_event")).toHaveLength(1)
  expect(JSON.stringify(ha.serviceCalls)).not.toContain("Private Work reminder")
})

test("private parent Area work is absent from reminder queries and overdue ledgers", async () => {
  const db = getPersistenceClient(), boardId = await board(), now = Date.now()
  await enrollObserver(boardId, "reminders")
  await enrollObserver(boardId, "overdue")
  const hierarchy = new HierarchyRepository(db, await scope(boardId))
  await hierarchy.createArea({ id: "private-yard", name: "Private yard" })
  expect(await hierarchy.createProject({ id: "private-garden", title: "Private garden", area_id: "private-yard" })).toBe(true)
  const hidden = await task(boardId, "Private garden deadline", now + 1_000, "private-garden")
  const visible = await task(boardId, "Visible unfiled deadline", now + 1_000)
  await changeBoardGrants(db, async tx => {
    await tx.execute({ sql: "INSERT INTO organization_access_policies(scope,scope_id,board_id,audience,selected_users,revision) VALUES ('group','private-yard',?,'selected','[\"parent\"]',1)", args: [boardId] })
    return { next: true }
  })
  const config = await readWorkDestinations(db)
  const observer = config?.bindings.find(binding => binding.purpose === "builtin.reminders.observe" && binding.destination.boardId === boardId)
  if (!observer) throw new Error("Expected per-Board observer")
  const context = await resolveIntegrationScope(db, observer.id, observer.generation, { resource: "task", action: "read" })
  if (!context.ok) throw new Error(context.errorCode)
  expect((await new TaskRepository(db, context.value.scope).findDueReminderTasks(now, now + 60_000)).map(task => task.id)).toEqual([visible.id])
  await checkDueDates(now)
  await checkDueDates(now + 2_000)
  const ledger = await db.execute("SELECT task_id, payload FROM domain_events WHERE event_type='task.overdue'")
  expect(ledger.rows.map(row => row.task_id)).toEqual([visible.id])
  expect(JSON.stringify(ledger.rows)).not.toContain(hidden.title)
  expect(ha.serviceCalls).toHaveLength(0)
})
