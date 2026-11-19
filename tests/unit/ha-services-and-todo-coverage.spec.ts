import { integrationFixture, integrationRoute } from "../helpers/ordinary-integration-fixture"
import { ordinaryTask } from "../helpers/ordinary-sync-fixture"
import { TaskRepository, readTaskDeletionReceipt, resolveIntegrationScope } from "../../apps/web/src/domains/tasks"
import { execFileSync } from "../helpers/isolated-process"
import dns from "node:dns"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"

const { WebSocketServer } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("ws")

const prevDbUrl = process.env.MEITHEAL_DB_URL
const workDir = mkdtempSync(path.join(tmpdir(), "meitheal-ha-todo-unit-"))
const dbFile = path.join(workDir, "ha-todo.db")
const dbUrl = `file:${dbFile}`

test.afterAll(() => {
  if (prevDbUrl === undefined) delete process.env.MEITHEAL_DB_URL
  else process.env.MEITHEAL_DB_URL = prevDbUrl
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
    if (urlPath === "/api/system/info") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        grocy_version: { Version: "4.2.0", ReleaseDate: "2026-01-01" },
      }))
      return
    }
    if (urlPath === "/api/chores" || urlPath === "/api/tasks" || urlPath === "/api/objects/shopping_list" || urlPath === "/api/objects/products") {
      res.writeHead(200, { "content-type": "application/json" }).end("[]")
      return
    }
    if (req.method === "HEAD" && urlPath === "/webhook-head") {
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end()
  })

  let acceptConnections = true
  const coreUsers = [
    { id: "ha-user-1", name: "Ryan", is_owner: true, is_active: true, system_generated: false },
    { id: "ha-user-2", name: "System", is_owner: false, is_active: false, system_generated: true },
  ]
  let rosterResult: unknown = coreUsers
  let waitForRoster = false
  const wss = new WebSocketServer({ server: httpServer, verifyClient: () => acceptConnections })
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
        service_data?: Record<string, unknown>
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
        if (waitForRoster) return
        send({
          id: msg.id,
          type: "result",
          success: true,
          result: rosterResult,
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

      if (msg.type === "call_service" && msg.domain === "todo" && msg.service === "add_item") {
        const data = msg.service_data ?? {}
        todoItems.push({ uid: `fixture-added-${todoItems.length}`, summary: String(data.item), status: "needs_action", description: String(data.description ?? ""), due: String(data.due_date ?? "") })
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

  const store = await import("../helpers/persistence-fixture")
  await store.ensureSchema()
  const client = store.getPersistenceClient()
  const haConn = await import("../../apps/web/src/domains/ha/ha-connection")
  const haServices = await import("../../apps/web/src/domains/ha/ha-services")
  const haUsers = await import("../../apps/web/src/domains/ha/ha-users")
  const todoBridge = await import("../../apps/web/src/domains/todo/todo-bridge")
  const calendarBridge = await import("../../apps/web/src/domains/calendar/calendar-bridge")
  const grocyBridge = await import("../../apps/web/src/domains/grocy")
  const haStartup = await import("../../apps/web/src/domains/ha/ha-startup")
  const originalLookup = dns.lookup
  dns.lookup = ((
    hostname: string,
    options: unknown,
    callback?: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
  ) => {
    const cb = typeof options === "function" ? (options as typeof callback) : callback
    const opts = typeof options === "object" && options !== null ? (options as { all?: boolean }) : {}
    if (hostname === "grocy.local") {
      if (opts.all) {
        queueMicrotask(() => cb?.(null, [{ address: "127.0.0.1", family: 4 }]))
      } else {
        queueMicrotask(() => cb?.(null, "127.0.0.1", 4))
      }
      return
    }
    return (originalLookup as (...args: unknown[]) => unknown)(hostname, options, callback)
  }) as typeof dns.lookup

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

    // 3. Verify roster recovery before the previous success TTL expires.
    haUsers.invalidateUserCache()
    const initialDirectory = await haUsers.listHAUserDirectory()
    expect(initialDirectory.verified).toBe(true)
    expect(initialDirectory.users.map(user => user.id)).toEqual(["ha-user-1"])
    expect(await haUsers.getHAUserById("ha-user-1")).toEqual(initialDirectory.users[0])
    expect(await haUsers.isCurrentActiveHAUser("ha-user-1", { fresh: true })).toBe(false)
    expect(await haUsers.getCurrentHAUserRoster("ha-user-1")).toBeUndefined()

    const nowBeforeStall = Date.now
    const { IdentityRepository } = await import("../../apps/web/src/domains/tasks/persistence/identity-repository")
    const { GET: getAssignees } = await import("../../apps/web/src/pages/api/users/index")
    await new IdentityRepository(client).createCustomUser("custom-roster-test", "Local assignee", "#6366f1")
    waitForRoster = true
    try {
      Date.now = () => nowBeforeStall() + 61_000
      const start = performance.now()
      const [directory, response] = await Promise.all([
        haUsers.listHAUserDirectory(),
        integrationRoute(getAssignees, "/api/users?board_id=household", undefined, "GET"),
      ])
      expect(directory).toEqual({ users: initialDirectory.users, verified: false })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        ha_roster_verified: false,
        users: [
          expect.objectContaining({ id: "ha_ha-user-1", source: "home_assistant" }),
          expect.objectContaining({ id: "custom-roster-test", source: "custom" }),
        ],
      })
      expect(performance.now() - start).toBeLessThan(5_000)
      expect(haConn.getHAConnectionStatus().connected).toBe(true)
    } finally {
      Date.now = nowBeforeStall
      waitForRoster = false
    }
    expect(await haUsers.listHAUserDirectory()).toEqual(initialDirectory)

    haConn.closeHAConnection()
    rosterResult = [{ id: "ha-user-1", name: "Ryan", system_generated: false }]
    expect(await haUsers.listHAUserDirectory()).toEqual({ users: initialDirectory.users, verified: false })
    rosterResult = []
    expect(await haUsers.listHAUserDirectory()).toEqual({ users: [], verified: true })
    haConn.closeHAConnection()
    rosterResult = coreUsers
    expect(await haUsers.listHAUserDirectory()).toEqual(initialDirectory)

    const savedToken = process.env.HA_TOKEN
    haConn.closeHAConnection()
    delete process.env.HA_TOKEN
    expect(await haUsers.listHAUserDirectory()).toEqual({ users: [], verified: false })
    process.env.HA_TOKEN = savedToken
    expect(await haUsers.listHAUserDirectory()).toEqual(initialDirectory)

    haConn.closeHAConnection()
    acceptConnections = false
    expect(await haUsers.listHAUserDirectory()).toEqual({ users: initialDirectory.users, verified: false })
    expect(haConn.getHAConnectionStatus().connected).toBe(false)
    acceptConnections = true
    expect(await haUsers.listHAUserDirectory()).toEqual(initialDirectory)
    expect((await haConn.getHAConnection())?.connected).toBe(true)

    // A new credential cannot fall back to the disconnected source's names.
    process.env.HA_TOKEN = "unit-ha-rotated-token"
    acceptConnections = false
    expect(await haUsers.listHAUserDirectory()).toEqual({ users: [], verified: false })
    acceptConnections = true
    expect(await haUsers.listHAUserDirectory()).toEqual(initialDirectory)

    // 4. Todo bridge start, inbound sync, outbound push/remove, stop
    const todo = await integrationFixture({ integration: "todo", sourceId: "todo.household", purpose: "todo.sync" })
    await todoBridge.startTodoSync({
      bindingId: todo.binding.id, generation: todo.binding.generation,
      entityId: "todo.household",
      syncEnabled: true,
      writeBack: true,
      syncDirection: "bidirectional",
    })
    expect(todoBridge.getActiveTodoSyncConfigs().length).toBeGreaterThanOrEqual(1)
    expect(todoBridge.getTodoSyncStatus(todo.binding.id)).toBeTruthy()
    const syncRes = await todoBridge.syncTodoFromHA(todo.binding.id)
    expect(syncRes.errors).toBe(0)

    const now = Date.now()
    const outbound = await ordinaryTask(todo.scope, "Test loft hatch", "idem-todo-out")
    const taskId = outbound.task.id
    const repository = new TaskRepository(client, todo.scope)
    expect(await repository.updateTask(taskId, { description: "Check insulation", due_date: "2026-11-24" })).toMatchObject({ ok: true })
    expect(await todoBridge.pushTaskToTodoList(
      taskId,
      "Test loft hatch",
      "pending",
      "todo.household",
      "2026-11-24",
      "Check insulation",
      [],
      todo.context,
    )).toBe(true)
    const todoDeleteContext = await resolveIntegrationScope(client, todo.binding.id, todo.binding.generation, { resource: "task", action: "read" }, todo.scope, { resource: "task", action: "delete" })
    if (!todoDeleteContext.ok) throw new Error("Current approved Todo deletion required")
    const deletion = await repository.deleteWorkCommand(taskId)
    if (!deletion.ok) throw new Error("Actual committed deletion required")
    const receipt = await readTaskDeletionReceipt(client, todo.scope, deletion.eventId, taskId)
    if (!receipt) throw new Error("Current owned deletion receipt required")
    expect(await todoBridge.removeTaskFromTodoList(taskId, todoDeleteContext.value, receipt)).toBe(1)
    todoBridge.stopTodoSync()

    // 4b. Calendar bridge start, inbound sync, outbound push/remove, stop
    const calendar = await integrationFixture({ integration: "calendar", sourceId: "calendar.family", purpose: "calendar.sync" })
    await calendarBridge.startCalendarSync({
      bindingId: calendar.binding.id, generation: calendar.binding.generation,
      entityId: "calendar.family",
      syncEnabled: true,
      syncMode: "bidirectional",
      writeBack: true,
      syncIntervalMs: 600_000,
    })
    expect(calendarBridge.getCalendarSyncConfigs().length).toBeGreaterThanOrEqual(1)
    expect(calendarBridge.getCalendarSyncConfig()?.entityId).toBe("calendar.family")
    expect((await calendarBridge.getCalendarSyncStatus(calendar.scope)).entities.length).toBeGreaterThanOrEqual(1)
    await calendarBridge.syncFromHA(calendar.binding.id)
    const calendarTask = await ordinaryTask(calendar.scope, "Test loft hatch", "idem-calendar-out")
    const calendarRepo = new TaskRepository(client, calendar.scope)
    expect(await calendarRepo.updateTask(calendarTask.task.id, { due_date: "2026-11-24", description: "Check insulation" })).toMatchObject({ ok: true })
    await calendarBridge.pushTaskToCalendar(calendar.context, calendarTask.task.id, "Test loft hatch", "2026-11-24", "Check insulation", { status: "pending", priority: 2, ticketKey: calendarTask.task.ticket_key ?? undefined })
    const calendarDeleteContext = await resolveIntegrationScope(client, calendar.binding.id, calendar.binding.generation, { resource: "task", action: "read" }, calendar.scope, { resource: "task", action: "delete" })
    if (!calendarDeleteContext.ok) throw new Error("Current approved Calendar deletion required")
    const calendarDeleted = await calendarRepo.deleteWorkCommand(calendarTask.task.id)
    if (!calendarDeleted.ok) throw new Error("Actual committed Calendar task deletion required")
    const calendarReceipt = await readTaskDeletionReceipt(client, calendar.scope, calendarDeleted.eventId, calendarTask.task.id)
    if (!calendarReceipt) throw new Error("Owned Calendar deletion receipt required")
    await calendarBridge.removeTaskCalendarEvent(calendarDeleteContext.value, calendarReceipt)
    calendarBridge.stopCalendarSync()

    // 5. ha-startup initialization end-to-end with persisted settings (Todo, Grocy, Webhooks)
    for (const [k, v] of [
      ["todo_sync_enabled", JSON.stringify(true)],
      ["todo_entities", JSON.stringify(["todo.household"])],
      ["todo_sync_direction", JSON.stringify("bidirectional")],
      ["grocy_sync_enabled", JSON.stringify(true)],
      ["grocy_url", JSON.stringify(`http://grocy.local:${port}`)],
      ["grocy_api_key", "12345"],
      ["grocy_sync_mode", JSON.stringify("import")],
      ["grocy_sync_interval", JSON.stringify(0)],
      ["webhook_endpoint", JSON.stringify(`http://grocy.local:${port}/webhook-head`)],
      ["n8n_webhook_url", "http://169.254.169.254/latest/meta-data/"],
    ] as const) {
      await client.execute({
        sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [k, v, now],
      })
    }
    const grocy = await integrationFixture({ integration: "grocy", sourceId: "configured-grocy", purpose: "grocy.sync" })
    await haStartup.initHAIntegrations()
    await grocyBridge.syncFromGrocy(grocy.binding.id)
    expect((await grocyBridge.getGrocySyncStatus(grocy.scope)).active).toBe(true)
    expect(grocyBridge.getActiveGrocySyncConfig(grocy.binding.id)?.intervalMs).toBe(0)
    expect(recordedCommands.length).toBeGreaterThan(0)

    // Bounded startup retry when a legacy Supervisor ingress URL is temporarily unresolvable on boot,
    // and disabling Grocy sync cancels any pending retry so sync stays off even if URL becomes valid.
    grocyBridge.stopGrocySync()
    await client.execute({
      sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
      args: [JSON.stringify("http://supervisor/api/hassio_ingress/tok_retry"), now],
    })
    await haStartup.autoStartGrocySync(0, 20)
    expect((await grocyBridge.getGrocySyncStatus(grocy.scope)).active).toBe(false)
    await client.execute({
      sql: "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'grocy_url'",
      args: [JSON.stringify(`http://grocy.local:${port}`), now],
    })
    const { POST: postGrocySync } = await import("../../apps/web/src/pages/api/grocy/sync")
    const disableRes = await integrationRoute(postGrocySync, "/api/grocy/sync?board_id=household", { action: "disable", bindingId: grocy.binding.id, generation: grocy.binding.generation })
    expect(disableRes.status).toBe(200)
    await new Promise<void>((resolve) => setTimeout(resolve, 45))
    expect((await grocyBridge.getGrocySyncStatus(grocy.scope)).active).toBe(false)
    haStartup.clearGrocyStartupRetry()

    // A temporary lookup failure also has a recovery path when sync stays enabled.
    await client.batch([
      {
        sql: "UPDATE settings SET value = 'true' WHERE key = 'grocy_sync_enabled'",
        args: [],
      },
      {
        sql: "UPDATE settings SET value = ? WHERE key = 'grocy_url'",
        args: [JSON.stringify("http://supervisor/api/hassio_ingress/tok_retry")],
      },
    ])
    await haStartup.autoStartGrocySync(0, 50)
    expect((await grocyBridge.getGrocySyncStatus(grocy.scope)).active).toBe(false)
    await client.execute({
      sql: "UPDATE settings SET value = ? WHERE key = 'grocy_url'",
      args: [JSON.stringify(`http://grocy.local:${port}`)],
    })
    await expect.poll(async () => (await grocyBridge.getGrocySyncStatus(grocy.scope)).active).toBe(true)
  } finally {
    haStartup.clearGrocyStartupRetry()
    grocyBridge.stopGrocySync()
    calendarBridge.stopCalendarSync()
    todoBridge.stopTodoSync()
    haConn.closeHAConnection()
    dns.lookup = originalLookup
    if (prevSup === undefined) delete process.env.SUPERVISOR_TOKEN
    else process.env.SUPERVISOR_TOKEN = prevSup
    if (prevUrl === undefined) delete process.env.HA_BASE_URL
    else process.env.HA_BASE_URL = prevUrl
    if (prevToken === undefined) delete process.env.HA_TOKEN
    else process.env.HA_TOKEN = prevToken
    await new Promise<void>((resolve) => wss.close(() => httpServer.close(() => resolve())))
  }
})
