/**
 * Agent comment and task notifications reach Home Assistant.
 *
 * Runs the real delivery code against a loopback Home Assistant WebSocket, so
 * the service calls asserted here are the ones Home Assistant would receive.
 *
 * @domain notifications
 */
import { expect, test } from "@playwright/test"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const appRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocketServer } = appRequire("ws")

type ServiceCall = { domain: string; service: string; service_data: Record<string, any> }
type Socket = { send(data: string): void; on(event: string, callback: (data: Buffer) => void): void; terminate(): void }

test("agent comments and task notifications are delivered through Home Assistant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-agent-notify-"))
  const keys = ["MEITHEAL_DB_URL", "SUPERVISOR_TOKEN", "HA_BASE_URL", "HA_TOKEN"] as const
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const calls: ServiceCall[] = []
  const failing = new Set<string>()
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>(resolve => server.once("listening", resolve))
  server.on("connection", (socket: Socket) => {
    const send = (value: unknown) => socket.send(JSON.stringify(value))
    send({ type: "auth_required", ha_version: "2026.11.1" })
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString())
      if (message.type === "auth") return send({ type: "auth_ok", ha_version: "2026.11.1" })
      if (message.type === "ping") return send({ id: message.id, type: "pong" })
      if (message.type === "call_service") {
        calls.push({ domain: message.domain, service: message.service, service_data: message.service_data })
        if (failing.has(`${message.domain}.${message.service}`)) {
          return send({ id: message.id, type: "result", success: false, error: { code: "service_not_found", message: "Fixture service is missing" } })
        }
      }
      send({ id: message.id, type: "result", success: true, result: message.type === "get_states" ? [] : null })
    })
  })

  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  const ha = await import("../../apps/web/src/domains/ha/ha-connection")
  const entities = await import("../../apps/web/src/domains/ha/ha-entities")
  try {
    delete process.env.SUPERVISOR_TOKEN
    delete process.env.HA_BASE_URL
    delete process.env.HA_TOKEN
    process.env.MEITHEAL_DB_URL = `file:${join(directory, "test.db")}`
    store.resetPersistenceForTests()
    await store.ensureSchema()
    const client = store.getPersistenceClient()
    const { SettingsRepository } = await import("../../apps/web/src/domains/tasks/persistence/settings-repository")
    const settings = new SettingsRepository(client)
    await settings.ensureSettingsTable()
    await settings.upsert("ha_url", JSON.stringify(`http://127.0.0.1:${server.address().port}`))
    await settings.upsert("ha_token", JSON.stringify("fixture-token"))
    expect(await ha.getHAConnection()).not.toBeNull()

    const { TaskRepository } = await import("../../apps/web/src/domains/tasks/persistence/task-repository")
    const repo = new TaskRepository(client)
    const now = Date.now()
    await client.execute({
      sql: "INSERT INTO tasks (id, title, status, idempotency_key, request_id, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)",
      args: ["task-notify-1", "Order the oil", "notify-fixture-1", "notify-fixture-1", now, now],
    })

    const { notifyAgentComment } = await import("../../apps/web/src/domains/notifications/agent-comment")
    const { sendTaskNotification } = await import("../../apps/web/src/domains/notifications/task-notifications")

    // Default preferences: the sidebar hears about the comment, as plain text.
    await notifyAgentComment("task-notify-1", "Automation: Claude", `<p>Ordered <b>500 litres</b>.</p><script>alert(1)</script> ${"Delivery on Friday. ".repeat(30)}`)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ domain: "persistent_notification", service: "create" })
    const sidebar = calls[0]!.service_data
    expect(sidebar.title).toBe("💬 Claude commented: Order the oil")
    expect(sidebar.notification_id).toBe("meitheal_agent_comment_task-notify-1")
    expect(sidebar.message).toMatch(/^Ordered 500 litres\. /)
    expect(sidebar.message).not.toMatch(/<|alert\(1\)/)
    expect(sidebar.message.endsWith("…")).toBe(true)
    expect(sidebar.message.length).toBeLessThanOrEqual(280)

    // A short comment is passed through whole, and a newer comment reuses the notification.
    calls.length = 0
    await notifyAgentComment("task-notify-1", "Codex", "Done.")
    expect(calls[0]!.service_data).toMatchObject({
      title: "💬 Codex commented: Order the oil",
      message: "Done.",
      notification_id: "meitheal_agent_comment_task-notify-1",
    })

    // An unknown task sends nothing and does not throw.
    calls.length = 0
    await notifyAgentComment("task-missing", "Claude", "Hello")
    expect(calls).toEqual([])

    // Push only: the sidebar is skipped, malformed targets are ignored, the rest get plain text.
    await settings.upsert("notification_preferences", JSON.stringify({
      enabled: true,
      channels: { sidebar: false, mobile_push: true },
      mobile_targets: ["notify.mobile_app_phone", "broken", "notify.mobile_app_tablet"],
    }))
    await notifyAgentComment("task-notify-1", "Claude", "Booked for <i>Friday</i>.")
    expect(calls.map(call => `${call.domain}.${call.service}`)).toEqual(["notify.mobile_app_phone", "notify.mobile_app_tablet"])
    expect(calls[0]!.service_data).toMatchObject({
      title: "💬 Claude commented: Order the oil",
      message: "Booked for Friday.",
      data: {
        tag: "meitheal_agent_comment_task-notify-1",
        group: "meitheal",
        channel: "meitheal_tasks",
        push: { "interruption-level": "active" },
        actions: [],
      },
    })
    expect(calls[0]!.service_data.data).not.toHaveProperty("importance")
    expect(calls[0]!.service_data.data).not.toHaveProperty("url")

    // Notifications switched off: nothing is sent.
    calls.length = 0
    await settings.upsert("notification_preferences", JSON.stringify({ enabled: false }))
    await notifyAgentComment("task-notify-1", "Claude", "Quiet")
    expect(calls).toEqual([])

    // An urgent task notification inside the Home Assistant App carries links, actions and a badge.
    const prefs = {
      enabled: true,
      disabledUsers: new Set<string>(),
      channels: { sidebar: true, mobile_push: true },
      mobileTargets: ["notify.mobile_app_phone"],
    }
    await sendTaskNotification(prefs, {
      title: "↩️ Handed back by Claude: Order the oil",
      message: "Claude handed MTH-1 back.\n\n[Open MTH-1 in Meitheal →](/api/hassio_ingress/abc/kanban)",
      notificationId: "meitheal_assigned_task-notify-1",
      ingress: "/api/hassio_ingress/abc",
      taskId: "task-notify-1",
      isUrgent: true,
      badgeCount: 3,
    })
    const sidebarCall = calls.find(call => call.domain === "persistent_notification")!
    const pushCall = calls.find(call => call.domain === "notify")!
    expect(calls).toHaveLength(2)
    expect(sidebarCall.service_data.message).toContain("[Open MTH-1 in Meitheal →](/api/hassio_ingress/abc/kanban)")
    expect(pushCall.service_data.message).toBe("Claude handed MTH-1 back.\n\nOpen MTH-1 in Meitheal →")
    expect(pushCall.service_data.data).toEqual({
      clickAction: "/api/hassio_ingress/abc/kanban",
      url: "/api/hassio_ingress/abc/kanban",
      tag: "meitheal_assigned_task-notify-1",
      group: "meitheal",
      channel: "meitheal_urgent",
      color: "#6366F1",
      importance: "high",
      push: { "interruption-level": "time-sensitive", badge: 3 },
      actions: [
        { action: "URI", title: "Open Task", uri: "/api/hassio_ingress/abc/kanban" },
        { action: "MEITHEAL_TASK_DONE_task-notify-1", title: "✅ Mark Done" },
      ],
    })

    // A push target Home Assistant rejects does not stop the sidebar, and nothing throws.
    calls.length = 0
    failing.add("notify.mobile_app_phone")
    await expect(sendTaskNotification(prefs, {
      title: "📋 Task assigned: Order the oil",
      message: "MTH-1 has been assigned to Niamh.",
      notificationId: "meitheal_assigned_task-notify-1",
      ingress: null,
    })).resolves.toBeUndefined()
    expect(calls.map(call => call.domain).sort()).toEqual(["notify", "persistent_notification"])

    // Push enabled with no targets sends the sidebar notification only.
    calls.length = 0
    await sendTaskNotification({ ...prefs, mobileTargets: [] }, {
      title: "📋 Task assigned: Order the oil",
      message: "MTH-1 has been assigned to Niamh.",
      notificationId: "meitheal_assigned_task-notify-1",
      ingress: null,
    })
    expect(calls.map(call => call.domain)).toEqual(["persistent_notification"])
    expect(await repo.findById("task-notify-1")).toBeTruthy()
  } finally {
    entities.stopEntitySubscription()
    ha.closeHAConnection()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(resolve))
    store.resetPersistenceForTests()
    for (const key of keys) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
