import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"

const { WebSocketServer } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("ws")

const workDir = mkdtempSync(path.join(tmpdir(), "meitheal-ha-todo-unit-"))
const dbFile = path.join(workDir, "ha-todo.db")
const dbUrl = `file:${dbFile}`

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test("HA connection, services, users, todo-bridge, and ha-startup work against local HA WS/REST fixture", async () => {
  process.env.MEITHEAL_DB_URL = dbUrl
  const webDir = path.resolve(process.cwd(), "../apps/web")
  execFileSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: webDir,
    env: { ...process.env, MEITHEAL_DB_URL: dbUrl },
  })

  const todoItems = [
    {
      uid: "ha-todo-1",
      summary: "Descaled kettle",
      status: "needs_action",
      description: "Use citric acid",
      due: "2026-11-22",
    },
    {
      uid: "ha-todo-2",
      summary: "MTH-12: Replace filter",
      status: "completed",
      description: "Added from Meitheal",
    },
  ]

  const calEvents = [
    {
      uid: "ev-1",
      summary: "Boiler service",
      start: "2026-11-20T09:00:00Z",
      end: "2026-11-20T10:00:00Z",
      description: "Annual check",
      location: "Utility",
    },
  ]

  const recordedCommands: string[] = []
  const sockets = new Set<{ send(v: string): void }>()

  const httpServer = createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/"
    if (req.method === "GET" && urlPath === "/api/states/calendar.family") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        entity_id: "calendar.family",
        state: "off",
        attributes: { supported_features: 7, friendly_name: "Family" },
        last_changed: "2026-11-14T12:00:00Z",
        last_updated: "2026-11-14T12:00:00Z",
      }))
      return
    }
    if (req.method === "GET" && urlPath === "/api/states/todo.household") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        entity_id: "todo.household",
        state: "2",
        attributes: { friendly_name: "Household" },
        last_changed: "2026-11-14T12:00:00Z",
        last_updated: "2026-11-14T12:00:00Z",
      }))
      return
    }
    if (urlPath === "/api/config") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        external_url: "https://ha.example.com",
        internal_url: "http://ha.local:8123",
        version: "2026.11.1",
      }))
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({ server: httpServer })
  wss.on("connection", (socket: { send(v: string): void; on(e: string, cb: (raw: Buffer) => void): void }) => {
    sockets.add(socket)
    const send = (payload: unknown) => socket.send(JSON.stringify(payload))
    send({ type: "auth_required", ha_version: "2026.11.1" })

    socket.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as {
        id?: number
        type: string
        domain?: string
        service?: string
        target?: { entity_id?: string }
        entity_id?: string
      }
      if (msg.type === "auth") {
        send({ type: "auth_ok", ha_version: "2026.11.1" })
        return
      }
      if (msg.type === "ping") {
        send({ id: msg.id, type: "pong" })
        return
      }

      recordedCommands.push(msg.type === "call_service" ? `call_service:${msg.domain}.${msg.service}` : msg.type)

      if (msg.type === "get_config") {
        send({
          id: msg.id,
          type: "result",
          success: true,
          result: { external_url: "https://ha.example.com", internal_url: "http://ha.local:8123", version: "2026.11.1" },
        })
        return
      }

      if (msg.type === "config/auth/list") {
        send({
          id: msg.id,
          type: "result",
          success: true,
          result: [
            { id: "ha-user-1", name: "Ryan", is_owner: true, is_active: true },
            { id: "ha-user-2", name: "System", is_owner: false, is_active: false },
          ],
        })
        return
      }

      if (msg.type === "conversation/agent/list") {
        send({
          id: msg.id,
          type: "result",
          success: true,
          result: { agents: [{ id: "conversation.home_assistant", name: "Home Assistant", supported_languages: ["en"] }] },
        })
        return
      }

      if (msg.type === "conversation/process") {
        send({
          id: msg.id,
          type: "result",
          success: true,
          result: {
            conversation_id: "conv-1",
            response: { response_type: "action_done", speech: { plain: { speech: "Added filter task" } } },
          },
        })
        return
      }

      if (msg.type === "get_states") {
        send({
          id: msg.id,
          type: "result",
          success: true,
          result: [
            { entity_id: "calendar.family", state: "off", attributes: { supported_features: 7 } },
            { entity_id: "todo.household", state: "2", attributes: { friendly_name: "Household" } },
          ],
        })
        return
      }

      if (msg.type === "call_service" && msg.domain === "calendar" && msg.service === "get_events") {
        const entityId = msg.target?.entity_id ?? "calendar.family"
        send({ id: msg.id, type: "result", success: true, result: { response: { [entityId]: { events: calEvents } } } })
        return
      }

      if (msg.type === "call_service" && msg.domain === "todo" && msg.service === "get_items") {
        const entityId = msg.target?.entity_id ?? "todo.household"
        send({ id: msg.id, type: "result", success: true, result: { response: { [entityId]: { items: todoItems } } } })
        return
      }

      if (msg.type === "subscribe_entities") {
        send({ id: msg.id, type: "result", success: true, result: null })
        send({
          id: msg.id,
          type: "event",
          event: {
            a: {
              "calendar.family": { s: "off", a: { supported_features: 7, friendly_name: "Family" }, lc: 1, lu: 1 },
              "todo.household": { s: "2", a: { friendly_name: "Household" }, lc: 1, lu: 1 },
            },
          },
        })
        return
      }

      if (msg.type === "todo/item/subscribe") {
        send({ id: msg.id, type: "result", success: true, result: null })
        send({ id: msg.id, type: "event", event: { items: todoItems } })
        return
      }

      send({ id: msg.id, type: "result", success: true, result: null })
    })
  })

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()))
  const { port } = httpServer.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${port}`

  const prevSup = process.env.SUPERVISOR_TOKEN
  const prevUrl = process.env.HA_BASE_URL
  const prevToken = process.env.HA_TOKEN
  delete process.env.SUPERVISOR_TOKEN
  process.env.HA_BASE_URL = baseUrl
  process.env.HA_TOKEN = "unit-ha-long-lived-token"

  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  await store.ensureSchema()
  const client = store.getPersistenceClient()
  const haConn = await import("../../apps/web/src/domains/ha/ha-connection")
  const haServices = await import("../../apps/web/src/domains/ha/ha-services")
  const haUsers = await import("../../apps/web/src/domains/ha/ha-users")
  const todoBridge = await import("../../apps/web/src/domains/todo/todo-bridge")
  const calendarBridge = await import("../../apps/web/src/domains/calendar/calendar-bridge")
  const haStartup = await import("../../apps/web/src/domains/ha/ha-startup")

  try {
    // 1. HA connection + REST fetch + status emitter
    const eventsSeen: string[] = []
    const unsubStatus = haConn.onHAConnectionStatus((state) => eventsSeen.push(state))
    const cfg = await haConn.getHAConfiguration()
    expect(cfg?.source).toBe("environment")
    const conn = await haConn.getHAConnection()
    expect(conn?.connected).toBe(true)
    expect(haConn.getHAConnectionStatus().connected).toBe(true)
    expect(await haConn.getHABaseUrl()).toBe("https://ha.example.com")
    const restRes = await haConn.haRestFetch("/api/config")
    expect(restRes?.status).toBe(200)
    expect(await haConn.haRestFetch("/api/../secrets")).toBeNull()
    unsubStatus()

    // 2. HA services (calendar, todo, notify, assist, callHAService)
    const features = await haServices.getCalendarEntityFeatures("calendar.family")
    expect(features).toBe(7)
    const events = await haServices.listCalendarEvents("calendar.family", "2026-11-01T00:00:00Z", "2026-11-30T23:59:59Z")
    expect(events.length).toBe(1)
    expect(await haServices.createCalendarEvent("calendar.family", {
      summary: "Sweep chimney",
      start: "2026-11-24",
      end: "2026-11-25",
      description: "Autumn prep",
    })).toBe(true)
    expect(await haServices.updateCalendarEvent("calendar.family", {
      uid: "ev-1",
      summary: "Boiler service updated",
      start: "2026-11-20T09:00:00Z",
      end: "2026-11-20T10:30:00Z",
    })).toBe(true)
    expect(await haServices.deleteCalendarEvent("calendar.family", "ev-1")).toBe(true)

    const items = await haServices.getTodoItems("todo.household")
    expect(items.length).toBe(2)
    expect(await haServices.addTodoItem("todo.household", { summary: "Salt driveway", due: "2026-11-21" })).toBe(true)
    expect(await haServices.updateTodoItem("todo.household", "ha-todo-1", { summary: "Descaled kettle v2", status: "completed" })).toBe(true)
    expect(await haServices.moveTodoItem("todo.household", "ha-todo-2", "ha-todo-1")).toBe(true)
    expect(await haServices.removeTodoItem("todo.household", ["ha-todo-1"])).toBe(true)
    expect(await haServices.removeTodoCompletedItems("todo.household")).toBe(true)

    const pushedItems: unknown[] = []
    const unsubTodo = await haServices.subscribeTodoItems("todo.household", (it) => pushedItems.push(it))
    expect(Array.isArray(pushedItems)).toBe(true)
    unsubTodo()

    expect(await haServices.sendNotification("mobile_app_phone", "Meitheal", "Hello")).toBe(true)
    const assist = await haServices.askAssist("Add milk", { agentId: "conversation.home_assistant", conversationId: "conv-1" })
    expect(assist.responseType).toBe("action_done")
    const agents = await haServices.listConversationAgents()
    expect(agents?.length).toBe(1)
    await haServices.callHAService("persistent_notification", "create", { message: "Ping" })
    expect(recordedCommands).toContain("call_service:persistent_notification.create")

    // 3. HA users standalone paths
    haUsers.invalidateUserCache()
    const users = await haUsers.listHAUsers()
    expect(Array.isArray(users)).toBe(true)
    await haUsers.getHAUserById("ha-user-1")
    expect(await haUsers.isCurrentActiveHAUser("ha-user-1", { fresh: true })).toBe(false)
    expect(await haUsers.getCurrentHAUserRoster("ha-user-1")).toBeUndefined()

    // 4. Todo bridge start, inbound sync, outbound push/remove, stop
    await todoBridge.startTodoSync({
      entityId: "todo.household",
      syncEnabled: true,
      writeBack: true,
      syncDirection: "bidirectional",
    })
    expect(todoBridge.getActiveTodoSyncConfigs().length).toBeGreaterThanOrEqual(1)
    expect(todoBridge.getTodoSyncStatus("todo.household")).toBeTruthy()
    const syncRes = await todoBridge.syncTodoFromHA("todo.household")
    expect(syncRes.errors).toBe(0)

    const now = Date.now()
    await client.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, labels, task_type, area_id,
            ticket_number, framework_payload, calendar_sync_state, idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, ?, 'pending', 2, '[]', 'task', 'default', 99, '{}', 'pending', 'idem-todo-out', 'req-todo-out', ?, ?)`,
      args: ["todo-outbound-1", "Test loft hatch", "Check insulation", now, now],
    })
    expect(await todoBridge.pushTaskToTodoList(
      "todo-outbound-1",
      "Test loft hatch",
      "pending",
      "todo.household",
      "2026-11-24",
      "Check insulation",
      [],
    )).toBe(true)
    await todoBridge.removeTaskFromTodoList("todo-outbound-1")
    todoBridge.stopTodoSync()

    // 4b. Calendar bridge start, inbound sync, outbound push/remove, stop
    calendarBridge.startCalendarSync({
      entityId: "calendar.family",
      syncEnabled: true,
      syncMode: "bidirectional",
      writeBack: true,
      syncIntervalMs: 600_000,
    })
    expect(calendarBridge.getCalendarSyncConfigs().length).toBeGreaterThanOrEqual(1)
    expect(calendarBridge.getCalendarSyncConfig()?.entityId).toBe("calendar.family")
    expect(calendarBridge.getCalendarSyncStatus().entities.length).toBeGreaterThanOrEqual(1)
    await calendarBridge.syncFromHA("calendar.family")
    await calendarBridge.pushTaskToCalendar(
      "todo-outbound-1",
      "Test loft hatch",
      "2026-11-24",
      "Check insulation",
      "calendar.family",
      { status: "pending", priority: 2, ticketKey: "MTH-99" },
    )
    await calendarBridge.removeTaskCalendarEvent("todo-outbound-1")
    calendarBridge.stopCalendarSync()

    // 5. ha-startup initialization end-to-end with persisted settings
    for (const [k, v] of [
      ["todo_sync_enabled", JSON.stringify(true)],
      ["todo_entities", JSON.stringify(["todo.household"])],
      ["todo_sync_direction", JSON.stringify("bidirectional")],
    ] as const) {
      await client.execute({
        sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [k, v, now],
      })
    }
    await haStartup.initHAIntegrations()
    expect(recordedCommands.length).toBeGreaterThan(0)
  } finally {
    calendarBridge.stopCalendarSync()
    todoBridge.stopTodoSync()
    haConn.closeHAConnection()
    if (prevSup === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = prevSup
    if (prevUrl === undefined) delete process.env.HA_BASE_URL
    else process.env.HA_BASE_URL = prevUrl
    if (prevToken === undefined) delete process.env.HA_TOKEN
    else process.env.HA_TOKEN = prevToken
    await new Promise<void>((resolve) => wss.close(() => httpServer.close(() => resolve())))
  }
})
