import http from "node:http"
import { expect, test } from "@playwright/test"

import { choreToTask, shoppingListToTask, taskToTask } from "../../apps/web/src/domains/grocy/grocy-mapper"
import { parseTaskInput } from "../../apps/web/src/lib/nl-task-parser"
import { buildAgentCard } from "../../packages/integration-core/src/a2a-handler"
import { D1Adapter, type D1Database, type D1PreparedStatement } from "../../packages/integration-core/src/d1-adapter"
import { HomeAssistantCalendarAdapter } from "../../packages/integration-core/src/home-assistant-calendar"
import { createWebhookPlugin, emitWebhook } from "../../packages/integration-core/src/webhook-emitter"

test("grocy-mapper translates chores, categorized tasks, and consolidated shopping lists", () => {
  const overdueChore = choreToTask({
    choreId: 10,
    choreName: "Descale Kettle",
    lastTrackedTime: "2026-10-01 09:00:00",
    nextEstimatedExecutionTime: "2026-11-01 10:00:00",
    nextExecutionAssignedToUserId: 7,
    isOverdue: true,
    isReassigned: false,
    trackDateOnly: false,
    periodType: "Monthly Ops!",
    periodInterval: 2,
    nextExecutionAssignedUser: { id: 7, display_name: "Aoife" },
  })
  expect(overdueChore.status).toBe("active")
  expect(overdueChore.priority).toBe(1)
  expect(overdueChore.areaId).toBe("monthly-ops-chores")
  expect(overdueChore.labels).toContain("overdue")
  expect(overdueChore.description).toContain("Assigned to: Aoife")

  const upcomingChore = choreToTask({
    choreId: 11,
    choreName: "Vacuum Rug",
    lastTrackedTime: null,
    nextEstimatedExecutionTime: null,
    nextExecutionAssignedToUserId: null,
    isOverdue: false,
    isReassigned: false,
    trackDateOnly: false,
    periodType: null,
    periodInterval: 0,
    nextExecutionAssignedUser: null,
  })
  expect(upcomingChore.status).toBe("pending")
  expect(upcomingChore.priority).toBe(3)
  expect(upcomingChore.areaId).toBe("default")
  expect(upcomingChore.description).toBeNull()

  const categorizedTask = taskToTask(
    {
      taskId: 20,
      name: "Replace Filter",
      description: "HEPA H13",
      dueDate: "2026-11-20",
      done: true,
      doneTimestamp: "2026-11-20 12:00:00",
      categoryId: 4,
      categoryName: "House Chores",
      assignedToUserId: null,
    },
    "House Chores",
  )
  expect(categorizedTask.status).toBe("complete")
  expect(categorizedTask.areaId).toBe("house-chores")
  expect(categorizedTask.labels).toContain("category:house chores")

  const plainTask = taskToTask({
    taskId: 21,
    name: "Oil Hinges",
    description: null,
    dueDate: null,
    done: false,
    doneTimestamp: null,
    categoryId: null,
    categoryName: null,
    assignedToUserId: null,
  })
  expect(plainTask.status).toBe("pending")
  expect(plainTask.areaId).toBe("default")

  const manyItems = Array.from({ length: 22 }, (_, i) => ({
    productId: i + 1,
    amount: i === 0 ? 1 : 2,
    ...(i === 1 ? { note: "organic" } : {}),
  }))
  const shopping = shoppingListToTask(manyItems, new Map([[1, "Oat Milk"]]))
  expect(shopping.title).toBe("🛒 Go Shopping (22 items)")
  expect(shopping.description).toContain("• Oat Milk")
  expect(shopping.description).toContain("• Item #2 ×2 — organic")
  expect(shopping.description).toContain("… and 2 more items")

  const singleShopping = shoppingListToTask([{ productId: 9, amount: 1 }])
  expect(singleShopping.title).toBe("🛒 Go Shopping (1 item)")
})

test("nl-task-parser handles priorities, labels, email-safe @assignee, relative/month/ISO dates, and fallback", () => {
  const ref = new Date(2026, 10, 10, 9, 0, 0) // Tuesday 2026-11-10

  expect(parseTaskInput("Fix leak !! #home @patrick today", ref)).toMatchObject({
    title: "Fix leak",
    priority: 1,
    labels: ["home"],
    assignee: "patrick",
    dueDate: "2026-11-10",
    hasExtractions: true,
  })
  expect(parseTaskInput("Call vet ! tomorrow", ref)).toMatchObject({
    title: "Call vet",
    priority: 2,
    dueDate: "2026-11-11",
  })
  expect(parseTaskInput("Email support+@example.com next monday p4", ref)).toMatchObject({
    title: "Email support+@example.com",
    priority: 4,
    assignee: null,
  })
  expect(parseTaskInput("Review budget this friday", ref).dueDate).toBe("2026-11-13")
  expect(parseTaskInput("Clean gutters sunday", ref).dueDate).toBe("2026-11-15")
  expect(parseTaskInput("Order filters in 3 days", ref).dueDate).toBe("2026-11-13")
  expect(parseTaskInput("Plan trip in 2 weeks", ref).dueDate).toBe("2026-11-24")
  expect(parseTaskInput("Pay tax Nov 25", ref).dueDate).toBe("2026-11-25")
  expect(parseTaskInput("Renewal Jan 05", ref).dueDate).toBe("2027-01-05")
  expect(parseTaskInput("Annual check 2027-03-14", ref).dueDate).toBe("2027-03-14")
  expect(parseTaskInput("#urgent", ref).title).toBe("#urgent")
})

test("D1Adapter and buildAgentCard execute success and failure paths", async () => {
  const createStatement = (mode: "ok" | "throw"): D1PreparedStatement => ({
    bind: () => createStatement(mode),
    all: async <T,>() => {
      if (mode === "throw") throw new Error("d1 all failed")
      return { results: [{ id: 1 }] as T[], success: true, meta: { duration: 1, rows_read: 1, rows_written: 0 } }
    },
    run: async () => {
      if (mode === "throw") throw "string error"
      return { results: [], success: true, meta: { duration: 2, rows_read: 0, rows_written: 1 } }
    },
    first: async <T,>() => {
      if (mode === "throw") throw new Error("first failed")
      return { id: 1 } as T
    },
    raw: async <T = unknown[],>() => [] as T[],
  })

  const okDb: D1Database = {
    prepare: () => createStatement("ok"),
    batch: async () => [{ results: [], success: true, meta: { duration: 3, rows_read: 0, rows_written: 2 } }],
    exec: async () => ({ count: 1, duration: 1 }),
  }
  const failDb: D1Database = {
    prepare: () => createStatement("throw"),
    batch: async () => { throw new Error("batch boom") },
    exec: async () => ({ count: 0, duration: 0 }),
  }

  const okAdapter = new D1Adapter(okDb)
  const failAdapter = new D1Adapter(failDb)

  expect((await okAdapter.query("SELECT 1")).ok).toBe(true)
  expect((await okAdapter.execute("DELETE FROM t")).ok).toBe(true)
  expect((await okAdapter.batch([{ sql: "INSERT INTO t VALUES (?)", params: [1] }])).ok).toBe(true)
  expect(await okAdapter.first("SELECT 1")).toEqual({ id: 1 })

  expect((await failAdapter.query("SELECT 1")).ok).toBe(false)
  expect((await failAdapter.execute("DELETE FROM t")).ok).toBe(false)
  expect((await failAdapter.batch([{ sql: "INSERT INTO t VALUES (1)" }])).ok).toBe(false)
  expect(await failAdapter.first("SELECT 1")).toBeNull()

  const card = buildAgentCard({ origin: "https://tasks.example", basePath: "/api/hassio_ingress/abc", version: "0.0.1" })
  expect(card.supportedInterfaces[0]?.url).toBe("https://tasks.example/api/hassio_ingress/abc/api/a2a/message")
})

test("HomeAssistantCalendarAdapter covers event id extraction, error classification, and timeouts", async () => {
  let mode: "array_uid" | "obj_event_id" | "text" | "401" | "429" | "503" | "400" | "slow" = "array_uid"
  const server = http.createServer((_req, res) => {
    if (mode === "slow") {
      setTimeout(() => { res.statusCode = 200; res.end("[]") }, 200)
      return
    }
    if (mode === "array_uid") { res.statusCode = 200; res.end(JSON.stringify([{ uid: "uid-1" }])); return }
    if (mode === "obj_event_id") { res.statusCode = 200; res.end(JSON.stringify({ event_id: "evt-2" })); return }
    if (mode === "text") { res.statusCode = 200; res.end("created-plain"); return }
    res.statusCode = Number(mode)
    res.end(mode)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const address = server.address() as { port: number }
  const adapter = new HomeAssistantCalendarAdapter({ baseUrl: `http://127.0.0.1:${address.port}/`, token: "tok", timeoutMs: 60 })
  const baseInput = {
    requestId: "req-1",
    idempotencyKey: "idem-1",
    entityId: "calendar.home",
    summary: "Bin day",
    startDateTime: "2026-11-15T08:00:00Z",
    endDateTime: "2026-11-15T09:00:00Z",
  }

  try {
    expect(await adapter.createEvent(baseInput)).toMatchObject({ ok: true, confirmationId: "uid-1", providerEventId: "uid-1" })
    mode = "obj_event_id"
    expect(await adapter.createEvent(baseInput)).toMatchObject({ ok: true, confirmationId: "evt-2", providerEventId: "evt-2" })
    mode = "text"
    expect((await adapter.createEvent(baseInput)).ok).toBe(true)
    mode = "401"
    expect(await adapter.createEvent(baseInput)).toMatchObject({ ok: false, errorCode: "unauthorized", retryable: false })
    mode = "429"
    expect(await adapter.createEvent(baseInput)).toMatchObject({ ok: false, errorCode: "service_unavailable", retryable: true, retryAfterSeconds: 30 })
    mode = "503"
    expect(await adapter.createEvent(baseInput)).toMatchObject({ ok: false, errorCode: "service_unavailable", retryable: true })
    mode = "400"
    expect(await adapter.createEvent(baseInput)).toMatchObject({ ok: false, errorCode: "invalid_request", retryable: false })
    mode = "slow"
    expect(await adapter.createEvent(baseInput)).toMatchObject({ ok: false, errorCode: "timeout", retryable: true })

    const deadAdapter = new HomeAssistantCalendarAdapter({ baseUrl: "http://127.0.0.1:1", token: "tok", timeoutMs: 200 })
    expect(await deadAdapter.createEvent(baseInput)).toMatchObject({ ok: false, errorCode: "unknown", retryable: true })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test("emitWebhook and createWebhookPlugin deliver signed CloudEvents and record failures", async () => {
  let replyStatus = 200
  let capturedHeaders: Record<string, string | string[] | undefined> = {}
  const server = http.createServer((req, res) => {
    capturedHeaders = req.headers
    res.statusCode = replyStatus
    res.end("ok")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as { port: number }
  const deliveries: Array<{ ok: boolean; status: string }> = []
  try {
    const plugin = createWebhookPlugin({
      subscribers: [
        { id: "sub-1", url: `http://127.0.0.1:${port}/hook`, secret: "sec-1", events: ["task.created"], enabled: true, headers: { "x-custom": "1" } },
        { id: "sub-disabled", url: `http://127.0.0.1:${port}/skip`, secret: "sec-2", events: ["*"], enabled: false },
      ],
      onDeliveryResult: async (result, record) => {
        deliveries.push({ ok: result.ok, status: record.status })
      },
    })

    await plugin.handle({
      eventId: "evt-1",
      eventType: "task.created",
      occurredAt: "2026-11-14T12:00:00Z",
      requestId: "req-1",
      traceId: "0af7651916cd43dd8448eb211c80319c",
      payload: { id: "t-1", title: "Deliver" },
    })
    expect(deliveries).toEqual([{ ok: true, status: "delivered" }])
    expect(capturedHeaders["x-meitheal-event"]).toBe("task.created")
    expect(capturedHeaders["ce-subject"]).toBe("t-1")
    expect(capturedHeaders["x-custom"]).toBe("1")

    replyStatus = 400
    const bad = await emitWebhook(
      { eventId: "evt-2", eventType: "task.updated", occurredAt: "2026-11-14T12:00:00Z", requestId: "req-2", payload: {} },
      { id: "sub-1", url: `http://127.0.0.1:${port}/hook`, secret: "sec-1", events: ["*"], enabled: true },
    )
    expect(bad).toMatchObject({ ok: false, statusCode: 400, finalError: "HTTP 400" })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
