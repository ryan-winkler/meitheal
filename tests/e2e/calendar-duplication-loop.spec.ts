import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base } from "@playwright/test"
import { startHAWebSocketFixture } from "../scripts/ha-websocket-fixture"
import {
  ensureSchema,
  getPersistenceClient,
  resetPersistenceForTests,
} from "../helpers/persistence-fixture"
import {
  calendarFixtureConfig,
  integrationFixture,
  integrationRoute,
} from "../helpers/ordinary-integration-fixture"
import { currentBoardScope } from "../helpers/current-board-scope"
import { readWorkDestinations } from "../../apps/web/src/domains/tasks/integration-destinations"
import { saveWorkBinding } from "../../apps/web/src/domains/tasks/work-binding-manager"
import { closeHAConnection, getHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
import { stopEntitySubscription } from "../../apps/web/src/domains/ha/ha-entities"
import {
  buildCalendarDescription,
  isMeithealOriginatedEvent,
  normalizeCalendarDescription,
  pushTaskToCalendar,
  startCalDAVSync,
  startCalendarSync,
  stopCalDAVSync,
  stopCalendarSync,
  syncCalDAVEvents,
  syncFromHA,
} from "../../apps/web/src/domains/calendar"
import {
  checkDueDates,
  resetDueDateRemindersForTests,
} from "../../apps/web/src/domains/notifications/due-date-reminders"
import { sanitizeTodoTitle } from "../../apps/web/src/lib/cleanup-corrupt-titles"
import { TaskRepository, resolveIntegrationScope } from "../../apps/web/src/domains/tasks"
import { POST as saveCredentials } from "../../apps/web/src/pages/api/integrations/calendar/caldav-credentials"

type Database = ReturnType<typeof getPersistenceClient>
type HAFixture = Awaited<ReturnType<typeof startHAWebSocketFixture>>

const ENTITY = "calendar.google_family"

const test = base.extend<{ env: { db: Database; ha: HAFixture } }>({
  env: async ({}, use) => {
    const previous = Object.fromEntries(
      ["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"].map((k) => [k, process.env[k]]),
    )
    const directory = await mkdtemp(join(tmpdir(), "meitheal-cal-dup-"))
    const ha = await startHAWebSocketFixture()
    delete process.env.SUPERVISOR_TOKEN
    process.env.HA_BASE_URL = ha.url
    process.env.HA_TOKEN = "calendar-dup-fixture"
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "tasks.db")}`
    resetPersistenceForTests()
    resetDueDateRemindersForTests()
    let db: Database | undefined
    try {
      await ensureSchema()
      db = getPersistenceClient()
      expect(await getHAConnection()).not.toBeNull()
      await use({ db, ha })
    } finally {
      stopCalendarSync()
      stopCalDAVSync()
      stopEntitySubscription()
      resetDueDateRemindersForTests()
      closeHAConnection()
      await ha.close()
      db?.close()
      resetPersistenceForTests()
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await rm(directory, { recursive: true, force: true })
    }
  },
})

async function addCalendarReminderBinding(db: Database, entityId: string, boardId = "household") {
  const owner = await currentBoardScope(db, boardId)
  const configuration = await readWorkDestinations(db)
  if (!configuration) throw new Error("Missing work destinations")
  const admitted = await saveWorkBinding(db, owner.principal, configuration.revision, {
    id: crypto.randomUUID(),
    generation: 1,
    enabled: true,
    integration: "calendar_reminder",
    sourceId: entityId,
    purpose: "calendar.reminder",
    destination: { boardId },
    allowedOperations: [{ resource: "task", action: "read" }],
  })
  if (!admitted.ok) throw new Error(`Reminder binding approval failed: ${admitted.message}`)
  return admitted.binding
}

test("repro: one Google Calendar invite stays 1 task across due-date reminders and repeated syncs", async ({ env: { db, ha } }) => {
  const now = Date.now()
  const dueIso = new Date(now + 45 * 60 * 1000).toISOString()
  const endIso = new Date(now + 105 * 60 * 1000).toISOString()

  const calFixture = await integrationFixture({
    integration: "calendar",
    sourceId: ENTITY,
    purpose: "calendar.sync",
  })
  await addCalendarReminderBinding(db, ENTITY)

  // Google Calendar via HA often omits `uid`
  ha.setCalendarEvents([{
    summary: "Veterinário Fiona",
    start: dueIso,
    end: endIso,
    description: "Annual checkup",
  }])

  await startCalendarSync({
    ...calendarFixtureConfig(calFixture.binding, 0),
    syncMode: "bidirectional",
    writeBack: true,
    writeTicketDetails: true,
  })
  await expect.poll(async () => Number((await db.execute("SELECT COUNT(*) AS c FROM tasks")).rows[0]?.c)).toBe(1)

  // Run due-date reminder checks (55 min / 50 min ticks)
  await checkDueDates(now)
  await checkDueDates(now + 5 * 60 * 1000)

  // Task already came from this calendar — NO duplicate reminder calendar event created
  const createEventCalls = ha.serviceCalls.filter((c) => c.domain === "calendar" && c.service === "create_event")
  expect(createEventCalls).toHaveLength(0)

  // Re-sync from HA — still 1 task
  const freshScope1 = await currentBoardScope(db, "household")
  const second = await syncFromHA(calFixture.binding.id, freshScope1, { resource: "task", action: "write" })
  expect(second.created).toBe(0)
  expect((await db.execute("SELECT title FROM tasks")).rows).toEqual([
    expect.objectContaining({ title: "Veterinário Fiona" }),
  ])
})

test("native task due-date reminder & outbound write-back include line break, ticket key, attribution, and in-ticket confirmation, and HTML echoes are skipped", async ({ env: { db, ha } }) => {
  const now = Date.now()
  const dueIso = new Date(now + 30 * 60 * 1000).toISOString()

  const calFixture = await integrationFixture({
    integration: "calendar",
    sourceId: ENTITY,
    purpose: "calendar.sync",
  })
  await addCalendarReminderBinding(db, ENTITY)
  const freshScope = await currentBoardScope(db, "household")

  const repo = new TaskRepository(db, freshScope)
  const taskId = crypto.randomUUID()
  const ticketNumber = await repo.createTask({
    id: taskId,
    title: "Pay electricity bill",
    description: "Online portal",
    status: "pending",
    priority: 2,
    due_date: dueIso,
    labels: "[]",
    framework_payload: "{}",
    calendar_sync_state: "pending",
    area_id: "default",
    custom_fields: "{}",
    task_type: "task",
    progress: 0,
    is_favorite: 0,
    position: 0,
    idempotency_key: `native-${taskId}`,
    request_id: `req-${taskId}`,
  })
  const createdTask = {
    id: taskId,
    title: "Pay electricity bill",
    description: "Online portal",
    ticket_key: `MTH-${ticketNumber}`,
  }

  await startCalendarSync({
    ...calendarFixtureConfig(calFixture.binding, 0),
    syncMode: "bidirectional",
    writeBack: true,
    writeTicketDetails: true,
  })
  await expect.poll(async () => (await syncFromHA(calFixture.binding.id, freshScope, { resource: "task", action: "write" })).skipped ?? null).toBeNull()

  await checkDueDates(now)

  const createdCalls = ha.serviceCalls.filter((c) => c.domain === "calendar" && c.service === "create_event")
  expect(createdCalls).toHaveLength(1)
  const sentData = createdCalls[0]!.service_data
  expect(sentData.summary).toBe(`📋 ${createdTask.ticket_key}: Pay electricity bill — DUE`)
  expect(String(sentData.description)).toContain(`\n\n📋 ${createdTask.ticket_key}`)
  expect(String(sentData.description)).toContain("Added from Meitheal")

  // In-ticket confirmation recorded in task_activity_log
  const reminderAct = await db.execute({
    sql: "SELECT event_type, actor_type, summary FROM task_activity_log WHERE task_id = ? AND event_type = 'calendar_sync'",
    args: [createdTask.id],
  })
  expect(reminderAct.rows).toHaveLength(1)
  expect(String(reminderAct.rows[0]?.summary)).toContain(ENTITY)

  // Echo the created reminder back from Google Calendar wrapped in HTML and without uid
  ha.setCalendarEvents([{
    summary: String(sentData.summary),
    start: String(sentData.start_date_time),
    end: String(sentData.end_date_time),
    description: `<p>Task ${createdTask.ticket_key} is due.</p><br><p>📋 ${createdTask.ticket_key}<br>Added from Meitheal</p>`,
  }])

  const echoSync = await syncFromHA(calFixture.binding.id, freshScope, { resource: "task", action: "write" })
  expect(echoSync.created).toBe(0)
  expect(Number((await db.execute("SELECT COUNT(*) AS c FROM tasks")).rows[0]?.c)).toBe(1)

  // Verify buildCalendarDescription respects writeTicketDetails toggle (default on)
  const richDesc = buildCalendarDescription("User notes", {
    ticketKey: "HOME-42",
    ticketUrl: "https://ha.local/meitheal_canary?meitheal=%2Fboards%2F1%3Fopen%3D42",
    status: "pending",
  })
  expect(richDesc).toContain("User notes\n\n📋 HOME-42")
  expect(richDesc).toContain("Open HOME-42 in Meitheal: https://ha.local/meitheal_canary?meitheal=%2Fboards%2F1%3Fopen%3D42")
  expect(richDesc).toContain("Added from Meitheal")

  const minimalDesc = buildCalendarDescription("User notes", {
    ticketKey: "HOME-42",
    ticketUrl: "https://ha.local/meitheal_canary?meitheal=%2Fboards%2F1%3Fopen%3D42",
    status: "pending",
  }, { writeTicketDetails: false })
  expect(minimalDesc).toBe("User notes\n\nAdded from Meitheal")
  expect(minimalDesc).not.toContain("HOME-42")

  // Verify outbound pushTaskToCalendar records in-ticket confirmation
  const freshCalCtx = await resolveIntegrationScope(
    db,
    calFixture.binding.id,
    calFixture.binding.generation,
    { resource: "task", action: "read" },
  )
  expect(freshCalCtx.ok).toBe(true)
  const pushed = await pushTaskToCalendar(
    freshCalCtx.ok ? freshCalCtx.value : calFixture.context,
    createdTask.id,
    createdTask.title,
    dueIso,
    createdTask.description ?? undefined,
  )
  expect(pushed).toBe(true)
  const pushAct = await db.execute({
    sql: "SELECT summary FROM task_activity_log WHERE task_id = ? AND event_type = 'calendar_sync'",
    args: [createdTask.id],
  })
  expect(pushAct.rows.length).toBeGreaterThanOrEqual(2)

  // Verify import-only calendar receives 0 reminder create_event calls
  resetDueDateRemindersForTests()
  const callsBefore = ha.serviceCalls.filter((c) => c.domain === "calendar" && c.service === "create_event").length
  const task2Id = crypto.randomUUID()
  await repo.createTask({
    id: task2Id,
    title: "Renew passport",
    description: "",
    status: "pending",
    priority: 3,
    due_date: dueIso,
    labels: "[]",
    framework_payload: "{}",
    calendar_sync_state: "pending",
    area_id: "default",
    custom_fields: "{}",
    task_type: "task",
    progress: 0,
    is_favorite: 0,
    position: 0,
    idempotency_key: `native-${task2Id}`,
    request_id: `req-${task2Id}`,
  })
  await startCalendarSync({
    ...calendarFixtureConfig(calFixture.binding, 0),
    syncMode: "import",
    writeBack: false,
  })
  await checkDueDates(now)
  const callsAfter = ha.serviceCalls.filter((c) => c.domain === "calendar" && c.service === "create_event").length
  expect(callsAfter).toBe(callsBefore)
})

test("WebDAV/CalDAV inbound sync skips Meitheal due-date reminders and custom-board-key loop artifacts while preserving normal events", async ({ env: { db } }) => {
  const origin = "http://caldav-loop.example"
  const originalFetch = globalThis.fetch

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const caldavXml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/normal.ics</d:href>
    <d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:normal-caldav@example.com
SUMMARY:Team Sync: 10:30 Q4
DTSTART:${today}T103000Z
DTEND:${today}T113000Z
DESCRIPTION:Agenda: budget and roadmap
END:VEVENT
END:VCALENDAR</c:calendar-data></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/reminder-echo.ics</d:href>
    <d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:reminder-echo@example.com
SUMMARY:📋 MTH-30: Veterinário Fiona — DUE
DTSTART:${today}T120000Z
DTEND:${today}T121500Z
DESCRIPTION:Task MTH-30 is due.
END:VEVENT
END:VCALENDAR</c:calendar-data></d:prop></d:propstat>
  </d:response>
  <d:response>
    <d:href>/custom-board-echo.ics</d:href>
    <d:propstat><d:prop><c:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:custom-board-echo@example.com
SUMMARY:📋 HOME-7: Water plants — DUE
DTSTART:${today}T140000Z
DTEND:${today}T141500Z
DESCRIPTION:Task HOME-7 is due.
END:VEVENT
END:VCALENDAR</c:calendar-data></d:prop></d:propstat>
  </d:response>
</d:multistatus>`

  const propfindXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:displayname>Personal</d:displayname><d:resourcetype><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`

  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader("content-type", "application/xml")
    if (req.method === "PROPFIND") res.writeHead(207).end(propfindXml)
    else if (req.method === "REPORT") res.writeHead(207).end(caldavXml)
    else res.writeHead(405).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("No TCP address")

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : input)
    if (target.origin !== origin) return originalFetch(input, init)
    target.hostname = "127.0.0.1"
    target.port = String(addr.port)
    return originalFetch(target, init)
  }) as typeof fetch

  try {
    const saved = await integrationRoute(
      saveCredentials,
      "/api/integrations/calendar/caldav-credentials",
      { action: "save", url: origin, username: "u", password: "p" },
    )
    expect(saved.status).toBe(200)
    const caldavFixture = await integrationFixture({
      integration: "caldav",
      sourceId: "configured-caldav",
      purpose: "calendar.sync",
    })

    await startCalDAVSync(origin, 0, {
      bindingId: caldavFixture.binding.id,
      generation: caldavFixture.binding.generation,
    })
    await expect.poll(async () => {
      const res = await syncCalDAVEvents(caldavFixture.binding.id, caldavFixture.scope, { resource: "task", action: "write" })
      return res.skipped ?? null
    }).toBeNull()

    const rows = await db.execute("SELECT title, description FROM tasks ORDER BY title ASC")
    expect(rows.rows.map((r) => String(r.title))).toEqual(["Team Sync: 10:30 Q4"])
    expect(String(rows.rows[0]?.description)).toBe("Agenda: budget and roadmap")
  } finally {
    stopCalDAVSync()
    globalThis.fetch = originalFetch
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("event identity helpers handle custom board keys, HTML descriptions, plain angle brackets, and title sanitization", () => {
  expect(isMeithealOriginatedEvent("📋 MTH-30: Veterinário Fiona — DUE", "")).toBe(true)
  expect(isMeithealOriginatedEvent("📋 HOME-12: Pay rent — DUE", "")).toBe(true)
  expect(isMeithealOriginatedEvent("📋 MTH-34: 📋 MTH-30: Veterinário Fiona", "")).toBe(true)
  expect(isMeithealOriginatedEvent("Dentist", "<p>Notes</p><br>Added from Meitheal")).toBe(true)
  expect(isMeithealOriginatedEvent("Dentist", "Task HOME-12 is due.")).toBe(true)
  expect(isMeithealOriginatedEvent("Dentist", "Regular appointment")).toBe(false)

  expect(normalizeCalendarDescription("Budget < 500 > 200")).toBe("Budget < 500 > 200")
  expect(normalizeCalendarDescription("<p>Line 1</p><br>Line 2 &amp; more")).toBe("Line 1\n\nLine 2 & more")

  expect(sanitizeTodoTitle("MTH-34: 📋 MTH-30: Veterinário Fiona — DUE — DUE")).toBe("Veterinário Fiona")
  expect(sanitizeTodoTitle("📋 HOME-9: Water plants — DUE")).toBe("Water plants")
})
