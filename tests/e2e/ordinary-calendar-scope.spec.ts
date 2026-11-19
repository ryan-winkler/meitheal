import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests
} from "../helpers/persistence-fixture"
import { BoardAccessService } from "../../apps/web/src/domains/tasks/board-access-service"
import {
  registerVerifiedPrincipal,
  type BoardScope,
  type VerifiedPrincipal
} from "../../apps/web/src/domains/tasks/board-scope"
import { NamedBoardRepository } from "../../apps/web/src/domains/tasks/persistence/named-board-repository"
import { HierarchyRepository } from "../../apps/web/src/domains/tasks/persistence/hierarchy-repository"
import { TemplateRepository } from "../../apps/web/src/domains/tasks/persistence/template-repository"
import { TaskRepository } from "../../apps/web/src/domains/tasks/persistence/task-repository"
import { prepareTaskCreation } from "../../apps/web/src/domains/tasks/task-creation-service"
import {
  changeGoalShare,
  listSharedGoals
} from "../../apps/web/src/domains/tasks/persistence/shared-goal-repository"
import {
  createPillar,
  getPillars,
  getPillarById
} from "../../apps/web/src/domains/pillars/pillar-service"
import {
  createPrinciple,
  getAllPrinciples
} from "../../apps/web/src/domains/pillars/principle-service"
import { personalPillarScope } from "../../apps/web/src/domains/pillars/pillar-owner"
import {
  linkEntity,
  getPillarsForEntity,
  setEntityPillar
} from "../../apps/web/src/domains/pillars/pillar-association-service"
import { IdentityRepository } from "../../apps/web/src/domains/tasks/persistence/identity-repository"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import { getHAConnection, closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import {
  startMultiCalendarSync,
  stopCalendarSync,
  startCalDAVSync,
  syncCalDAVEvents,
  getCalendarSyncStatus,
  stopCalDAVSync,
  syncFromHA,
  pushTaskToCalendar,
  removeTaskCalendarEvent
} from "../../apps/web/src/domains/calendar/calendar-bridge"
import { changeBoardGrants } from "../../apps/web/src/domains/tasks/persistence/board-grant-fence"
import { resolveIntegrationScope } from "../../apps/web/src/domains/tasks/board-automation"
import { readTaskDeletionReceipt } from "../../apps/web/src/domains/tasks/persistence/task-deletion-receipt"
import { calendarToday, shiftCalendarDay } from "../../apps/web/src/lib/date"
let ha: Awaited<ReturnType<typeof startHAWebSocketFixture>>
const previousHA = {
  base: process.env.HA_BASE_URL,
  token: process.env.HA_TOKEN,
  supervisor: process.env.SUPERVISOR_TOKEN
}
let directory: string
const previous = process.env.MEITHEAL_DB_URL
const parent = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "parent" },
    { expiresAt: Date.now() + 60000, administrator: true }
  )
const child = () =>
  registerVerifiedPrincipal(
    { kind: "ha_user", id: "child" },
    { expiresAt: Date.now() + 60000, administrator: false }
  )
async function scope(principal: VerifiedPrincipal, id: string): Promise<BoardScope> {
  const result = await new BoardAccessService(getPersistenceClient()).resolve(principal, id, {
    resource: "task",
    action: "read"
  })
  if (!result.ok) throw new Error(result.errorCode)
  return result.scope
}
async function board(principal: VerifiedPrincipal, name: string) {
  const result = await new NamedBoardRepository(getPersistenceClient()).create(principal, name)
  if (result.status !== "committed") throw new Error("Board fixture failed")
  return result.result.id
}
async function task(work: BoardScope, title: string) {
  const repository = new TaskRepository(getPersistenceClient(), work)
  const parsed = await prepareTaskCreation(
    repository,
    { title, area_id: null },
    { useDefaultAssignee: false }
  )
  if (!parsed.ok) throw new Error(parsed.error)
  const result = await repository.createWorkCommand(parsed.task)
  if (!result.ok) throw new Error(result.errorCode)
  return result.task
}
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ordinary-planning-"))
  process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
  await ensureSchema()
  ha = await startHAWebSocketFixture()
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = ha.url
  process.env.HA_TOKEN = "ordinary-calendar-source-fixture"
  expect(await getHAConnection()).not.toBeNull()
})
test.afterEach(async () => {
  stopCalendarSync()
  stopCalDAVSync()
  stopEntitySubscription()
  closeHAConnection()
  await ha.close()
  for (const [key, value] of [
    ["HA_BASE_URL", previousHA.base],
    ["HA_TOKEN", previousHA.token],
    ["SUPERVISOR_TOKEN", previousHA.supervisor]
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetPersistenceForTests()
  if (previous === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = previous
  await rm(directory, { recursive: true, force: true })
})

const operations = (["read", "create", "edit", "complete", "reopen", "delete"] as const).map(
  (action) => ({ resource: "task" as const, action })
)
async function bind(
  boardId: string,
  areaId?: string,
  projectId?: string,
  allowedOperations = operations,
  integration: "calendar" | "caldav" = "calendar"
) {
  const db = getPersistenceClient(),
    id = randomUUID()
  const binding = {
    id,
    generation: 1,
    integration,
    sourceId: integration === "caldav" ? "configured-caldav" : "calendar.fixture",
    enabled: true,
    destination: { boardId, ...(areaId ? { areaId } : {}), ...(projectId ? { projectId } : {}) },
    allowedOperations,
    purpose: "calendar.sync"
  }
  await changeBoardGrants(db, async (tx) => {
    const {
      rows: [setting]
    } = await tx.execute("SELECT value FROM settings WHERE key='work-destinations'")
    const config = JSON.parse(String(setting!.value))
    config.bindings.push(binding)
    config.revision = randomUUID()
    await tx.execute({
      sql: "UPDATE settings SET value=? WHERE key='work-destinations'",
      args: [JSON.stringify(config)]
    })
    await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,authority_limits) VALUES (?,'service',?,'service',?)",
      args: [
        boardId,
        id,
        JSON.stringify({ operations: allowedOperations, purpose: "calendar.sync" })
      ]
    })
    return { next: true }
  })
  return binding
}
for (const encoding of ["legacy", "scoped"] as const) {
  test(`${encoding}: Calendar recurrence, placement, merge and binding revocation use common work`, async () => {
    const owner = parent(),
      db = getPersistenceClient(),
      id = encoding === "legacy" ? "household" : await board(owner, "Work")
    let work = await scope(owner, id)
    const hierarchy = new HierarchyRepository(db, work),
      areaId = randomUUID(),
      projectId = randomUUID()
    await hierarchy.createArea({ id: areaId, name: "Garden" })
    await hierarchy.createProject({ id: projectId, title: "Maintenance", area_id: areaId })
    const binding = await bind(id, areaId, projectId)
    work = await scope(owner, id)
    const today = calendarToday("Europe/Dublin"),
      next = shiftCalendarDay(today, 7)
    ha.setCalendarEvents([
      {
        uid: "weekly",
        summary: "Weekly fixture",
        start: `${today}T10:00:00Z`,
        end: `${today}T11:00:00Z`
      },
      {
        uid: "weekly",
        summary: "Weekly fixture",
        start: `${next}T10:00:00Z`,
        end: `${next}T11:00:00Z`
      }
    ])
    await startMultiCalendarSync([
      {
        bindingId: binding.id,
        generation: 1,
        entityId: binding.sourceId,
        syncEnabled: true,
        syncMode: "bidirectional",
        writeBack: true,
        syncIntervalMs: 0
      }
    ])
    const repository = new TaskRepository(db, work)
    let page = await repository.findAll({ limit: 500 })
    expect(page.tasks).toHaveLength(1)
    expect((await getCalendarSyncStatus()).lastSyncEventCount).toBe(null)
    expect((await getCalendarSyncStatus(work)).lastSyncEventCount).toBe(1)
    const item = page.tasks[0]!
    expect(item).toMatchObject({
      area_id: areaId,
      project_id: projectId,
      task_kind: "calendar_event",
      title: "Weekly fixture"
    })
    expect(await syncFromHA(binding.id)).toMatchObject({ created: 0 })
    expect((await repository.findAll({ limit: 500 })).tasks).toHaveLength(1)
    expect(await repository.updateTask(item.id, { title: "Local name" })).toMatchObject({
      ok: true
    })
    ha.setCalendarEvents([
      {
        uid: "weekly",
        summary: "Provider changed",
        start: `${today}T10:00:00Z`,
        end: `${today}T11:00:00Z`
      }
    ])
    await syncFromHA(binding.id)
    expect((await repository.findById(item.id))?.title).toBe("Local name")
    expect(await repository.deleteTask(item.id)).toBe(true)
    expect(await syncFromHA(binding.id)).toMatchObject({ created: 0 })
    expect((await repository.findAll({ limit: 500 })).tasks).toHaveLength(0)
    ha.setCalendarEvents([
      {
        uid: "weekly",
        summary: "Next occurrence",
        start: `${next}T10:00:00Z`,
        end: `${next}T11:00:00Z`
      }
    ])
    expect(await syncFromHA(binding.id)).toMatchObject({ created: 1 })
    expect((await repository.findAll({ limit: 500 })).tasks).toHaveLength(1)
    if (encoding === "scoped") expect(ha.firedEvents).toEqual([])
    const before = ha.serviceCalls.filter((call) => call.service === "get_events").length
    await changeBoardGrants(db, async (tx) => {
      const {
        rows: [setting]
      } = await tx.execute("SELECT value FROM settings WHERE key='work-destinations'")
      const config = JSON.parse(String(setting!.value))
      config.bindings.find((entry: { id: string }) => entry.id === binding.id).enabled = false
      config.revision = randomUUID()
      await tx.execute({
        sql: "UPDATE settings SET value=? WHERE key='work-destinations'",
        args: [JSON.stringify(config)]
      })
      return { next: true }
    })
    await expect(syncFromHA(binding.id)).rejects.toThrow("Calendar binding is unavailable")
    expect(ha.serviceCalls.filter((call) => call.service === "get_events")).toHaveLength(before)
  })
}

test("outbound read-only Calendar publishes authoritative task fields and requires deletion evidence", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Private Work"),
    binding = await bind(id, undefined, undefined, [{ resource: "task", action: "read" }])
  const work = await scope(owner, id),
    repo = new TaskRepository(db, work),
    item = await task(work, "Authoritative task"),
    today = calendarToday("Europe/Dublin")
  expect(await repo.updateTask(item.id, { due_date: today })).toMatchObject({ ok: true })
  await startMultiCalendarSync([
    {
      bindingId: binding.id,
      generation: 1,
      entityId: binding.sourceId,
      syncEnabled: true,
      syncMode: "export",
      writeBack: true,
      syncIntervalMs: 0
    }
  ])
  const resolved = await resolveIntegrationScope(
    db,
    binding.id,
    1,
    { resource: "task", action: "read" },
    work,
    { resource: "task", action: "edit" }
  )
  if (!resolved.ok) throw new Error(resolved.errorCode)
  expect(
    await pushTaskToCalendar(resolved.value, item.id, "Forged title", "2099-01-01", "Forged body", {
      status: "complete"
    })
  ).toBe(true)
  const sent = ha.serviceCalls.find((call) => call.service === "create_event")!
  expect(sent.service_data).toMatchObject({ summary: "Authoritative task", start_date: today })
  expect(String(sent.service_data.description)).not.toContain("Forged")
  expect(ha.firedEvents).toEqual([])
  expect(await pushTaskToCalendar(resolved.value, item.id, "Ignored", today)).toBe(true)
  expect(ha.serviceCalls.filter((call) => call.service === "update_event")).toHaveLength(1)
  const otherId = await board(owner, "Other private Board"),
    other = await scope(owner, otherId),
    secret = await task(other, "Never disclose")
  // The previous context is stale after a Board grant transition, so refresh the exact binding.
  const freshWork = await scope(owner, id),
    fresh = await resolveIntegrationScope(
      db,
      binding.id,
      1,
      { resource: "task", action: "read" },
      freshWork,
      { resource: "task", action: "edit" }
    )
  if (!fresh.ok) throw new Error(fresh.errorCode)
  const sends = ha.serviceCalls.length
  expect(await pushTaskToCalendar(fresh.value, secret.id, "Never disclose", today)).toBe(false)
  expect(ha.serviceCalls).toHaveLength(sends)
  expect(await new TaskRepository(db, freshWork).deleteTask(item.id)).toBe(true)
  const {
    rows: [event]
  } = await db.execute({
    sql: "SELECT event_id FROM domain_events WHERE task_id=? AND event_type='task.deleted' ORDER BY created_at DESC LIMIT 1",
    args: [item.id]
  })
  const receipt = await readTaskDeletionReceipt(db, freshWork, String(event!.event_id), item.id)
  expect(receipt).not.toBeNull()
  const deletion = await resolveIntegrationScope(
    db,
    binding.id,
    1,
    { resource: "task", action: "read" },
    freshWork,
    { resource: "task", action: "delete" }
  )
  if (!deletion.ok || !receipt) throw new Error("Deletion proof unavailable")
  expect(
    await removeTaskCalendarEvent(deletion.value, { ...receipt, eventId: "forged-event" })
  ).toBe(false)
  expect(await removeTaskCalendarEvent(deletion.value, receipt)).toBe(true)
  expect(ha.serviceCalls.filter((call) => call.service === "delete_event")).toHaveLength(1)
  expect(
    (
      await db.execute({
        sql: "SELECT 1 FROM calendar_confirmations WHERE task_id=? AND binding_id=?",
        args: [item.id, binding.id]
      })
    ).rows
  ).toEqual([])
})

test("CalDAV preserves collection-specific shared UIDs within an explicit Board destination", async () => {
  const owner = parent(),
    db = getPersistenceClient()
  const { POST: saveCredentials } = await import(
    "../../apps/web/src/pages/api/integrations/calendar/caldav-credentials"
  )
  const origin = "http://calendar-profile.example.test",
    originalFetch = globalThis.fetch,
    today = calendarToday("Europe/Dublin").replaceAll("-", "")
  const { runWithIngressTransport } = await import("../../apps/web/scripts/ingress-transport.mjs")
  const { boardSessionProof } = await import("../../apps/web/src/lib/named-board-request")
  const {
    rows: [operator]
  } = await db.execute("SELECT value FROM app_settings WHERE key='local_operator_identity'")
  const saved = await runWithIngressTransport(
    {
      peer: "127.0.0.1",
      fromSupervisor: false,
      identityHeadersSafe: true,
      configuredPath: undefined
    },
    () =>
      saveCredentials({
        locals: {},
        request: new Request("http://localhost/api/integrations/calendar/caldav-credentials", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-meitheal-board-session": boardSessionProof(String(operator!.value))
          },
          body: JSON.stringify({
            action: "save",
            url: origin,
            username: "fixture",
            password: "fixture-password"
          })
        })
      } as Parameters<typeof saveCredentials>[0])
  )
  expect(saved.status).toBe(200)
  const id = await board(owner, "Calendar Work"),
    binding = await bind(id, undefined, undefined, operations, "caldav"),
    work = await scope(owner, id),
    repo = new TaskRepository(db, work)
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== origin) throw new Error("Unexpected fixture destination")
    const response = (href: string, title: string, content: string) =>
      `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${title}</d:displayname>${content}</d:prop></d:propstat></d:response>`
    const wrap = (content: string) =>
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${content}</d:multistatus>`
    if (init?.method === "PROPFIND")
      return new Response(
        wrap(
          response("/team/", "Team", "<d:resourcetype><c:calendar/></d:resourcetype>") +
            response("/personal/", "Personal", "<d:resourcetype><c:calendar/></d:resourcetype>")
        ),
        { status: 207 }
      )
    const title = url.pathname.startsWith("/team") ? "Team event" : "Personal event"
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:same-provider-uid",
      `SUMMARY:${title}`,
      `DTSTART;VALUE=DATE:${today}`,
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n")
    return new Response(
      wrap(
        response(url.pathname + "event.ics", title, `<c:calendar-data>${ics}</c:calendar-data>`)
      ),
      { status: 207 }
    )
  }) as typeof fetch
  try {
    await startCalDAVSync(origin, 0, { bindingId: binding.id, generation: 1 })
    await expect
      .poll(
        async () =>
          (await getCalendarSyncStatus()).entities.find((state) => state.bindingId === binding.id)
            ?.lastSyncAt
      )
      .not.toBeNull()
    expect((await repo.findAll({ limit: 500 })).tasks.map((item) => item.title).sort()).toEqual([
      "Personal event",
      "Team event"
    ])
    expect(await syncCalDAVEvents(binding.id)).toMatchObject({ created: 0, total: 2 })
    expect((await repo.findAll({ limit: 500 })).tasks).toHaveLength(2)
    expect(
      (
        await db.execute({
          sql: "SELECT json_extract(payload,'$.calendar_href') AS href FROM calendar_confirmations WHERE binding_id=? ORDER BY href",
          args: [binding.id]
        })
      ).rows
    ).toEqual([{ href: "/personal" }, { href: "/team" }])
  } finally {
    stopCalDAVSync()
    globalThis.fetch = originalFetch
  }
})

test("CalDAV checks current authority before a redirect can resend credentials", async () => {
  const { discoverCalendars } = await import("../../apps/web/src/domains/calendar/caldav-client")
  const originalFetch = globalThis.fetch
  let allowed = true,
    sends = 0
  globalThis.fetch = (async () => {
    sends++
    allowed = false
    return new Response(null, { status: 302, headers: { location: "/redirected" } })
  }) as typeof fetch
  try {
    await expect(
      discoverCalendars(
        { url: "http://calendar-redirect.example.test", username: "fixture", password: "fixture" },
        { operationAllowed: async () => allowed }
      )
    ).rejects.toThrow()
    expect(sends).toBe(1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("manual Calendar reconciliation cannot complete work through a child's service grant", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Child projects"),
    binding = await bind(id)
  const today = calendarToday("Europe/Dublin")
  ha.setCalendarEvents([
    { uid: "removed", summary: "Pending event", start: today, end: shiftCalendarDay(today, 1) }
  ])
  await startMultiCalendarSync([
    {
      bindingId: binding.id,
      generation: 1,
      entityId: binding.sourceId,
      syncEnabled: true,
      syncMode: "bidirectional",
      writeBack: true,
      syncIntervalMs: 0
    }
  ])
  const ownerWork = await scope(owner, id),
    item = (await new TaskRepository(db, ownerWork).findAll({ limit: 500 })).tasks[0]!
  await changeBoardGrants(db, async (tx) => {
    await tx.execute({
      sql: "INSERT INTO board_access_grants(board_id,principal_type,principal_id,role,deny_completion) VALUES (?,'ha_user','child','member',1)",
      args: [id]
    })
    return { next: true }
  })
  const childWork = await scope(child(), id)
  ha.setCalendarEvents([
    { uid: "remaining", summary: "Other event", start: today, end: shiftCalendarDay(today, 1) }
  ])
  const result = await syncFromHA(binding.id, childWork, { resource: "task", action: "edit" })
  expect(result.failed).toBeTruthy()
  expect((await new TaskRepository(db, await scope(owner, id)).findById(item.id))?.status).toBe(
    "pending"
  )
})

test("Calendar cannot relay an originating service into another Area ceiling", async () => {
  const owner = parent(),
    db = getPersistenceClient(),
    id = await board(owner, "Provider boundaries"),
    work = await scope(owner, id),
    hierarchy = new HierarchyRepository(db, work),
    areaA = randomUUID(),
    areaB = randomUUID()
  await hierarchy.createArea({ id: areaA, name: "Source Area" })
  await hierarchy.createArea({ id: areaB, name: "Other Area" })
  const source = await bind(id, areaA),
    receiver = await bind(id, areaB)
  const origin = await resolveIntegrationScope(db, source.id, 1, {
    resource: "task",
    action: "create"
  })
  if (!origin.ok) throw new Error(origin.errorCode)
  ha.setCalendarEvents([])
  await startMultiCalendarSync([
    {
      bindingId: receiver.id,
      generation: 1,
      entityId: receiver.sourceId,
      syncEnabled: true,
      syncMode: "import",
      writeBack: false,
      syncIntervalMs: 0
    }
  ])
  ha.setCalendarEvents([
    { uid: "blocked", summary: "Never cross Area", start: calendarToday("Europe/Dublin") }
  ])
  const before = ha.serviceCalls.length
  expect(
    (
      await resolveIntegrationScope(
        db,
        receiver.id,
        1,
        { resource: "task", action: "read" },
        origin.value.scope,
        { resource: "task", action: "create" }
      )
    ).ok
  ).toBe(false)
  await expect(
    syncFromHA(receiver.id, origin.value.scope, { resource: "task", action: "create" })
  ).rejects.toThrow("Calendar binding is unavailable")
  expect(ha.serviceCalls).toHaveLength(before)
  expect(
    (await new TaskRepository(db, await scope(owner, id)).findAll({ limit: 500 })).tasks
  ).toHaveLength(0)
})
