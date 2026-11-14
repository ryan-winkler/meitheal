import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, test } from "@playwright/test"
import { GrocyAdapter } from "../../packages/integration-core/src/grocy-adapter"

const workDir = mkdtempSync(path.join(tmpdir(), "meitheal-grocy-bridge-"))
const dbFile = path.join(workDir, "bridge.db")
const dbUrl = `file:${dbFile}`

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

test("GrocyAdapter, GrocyBridge sync/push, webhook dispatcher, outbound sync, and due-date reminders work end-to-end", async () => {
  process.env.MEITHEAL_DB_URL = dbUrl
  const webDir = path.resolve(process.cwd(), "../apps/web")
  execFileSync(process.execPath, ["scripts/migrate.mjs"], {
    cwd: webDir,
    env: { ...process.env, MEITHEAL_DB_URL: dbUrl },
  })

  const store = await import("../../apps/web/src/domains/tasks/persistence/store")
  await store.ensureSchema()
  const client = store.getPersistenceClient()

  let round = 1
  const apiHits: string[] = []
  const webhookDeliveries: Array<{ path: string; body: string }> = []

  const server = createServer((req, res) => {
    const reqUrl = req.url ?? "/"
    const urlPath = reqUrl.split("?")[0] ?? "/"
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8")
      apiHits.push(`${req.method ?? "GET"} ${urlPath}`)

      if (urlPath === "/webhook" || urlPath === "/n8n-webhook") {
        webhookDeliveries.push({ path: urlPath, body: rawBody })
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
        return
      }

      if (urlPath === "/api/system/info") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
          grocy_version_info: { Version: "4.2.0", ReleaseDate: "2026-01-01" },
          php_version: "8.3",
          sqlite_version: "3.45",
          os: "Linux",
          client: "test",
        }))
        return
      }

      if (urlPath === "/api/objects/products") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
          { id: 1, name: "Milk" },
          { id: 2, name: "Bread" },
        ]))
        return
      }

      if (urlPath === "/api/objects/task_categories") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
          { id: 10, name: "Kitchen" },
        ]))
        return
      }

      if (urlPath === "/api/chores") {
        const chores = round === 1
          ? [
              {
                chore_id: 101,
                chore_name: "Clean coffee machine",
                next_estimated_execution_time: "2026-11-20 09:00:00",
                period_type: "weekly",
                period_interval: 1,
                is_overdue: true,
                track_date_only: true,
              },
              {
                chore_id: 102,
                chore_name: "Stale chore",
                period_type: "daily",
                period_interval: 1,
              },
            ]
          : [
              {
                chore_id: 101,
                chore_name: "Deep clean coffee machine",
                next_estimated_execution_time: "2026-11-21 09:00:00",
                period_type: "weekly",
                period_interval: 1,
                is_overdue: false,
                track_date_only: false,
              },
            ]
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(chores))
        return
      }

      if (urlPath === "/api/tasks") {
        const tasks = round === 1
          ? [
              {
                id: 201,
                name: "Buy coffee beans",
                description: "Medium roast",
                due_date: "2026-11-20",
                done: 0,
                category_id: 10,
              },
            ]
          : [
              {
                id: 201,
                name: "Buy coffee beans",
                description: "Whole bean espresso roast",
                due_date: "2026-11-22",
                done: 1,
                category_id: 10,
              },
            ]
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(tasks))
        return
      }

      if (urlPath === "/api/objects/shopping_list") {
        const list = round === 1
          ? [{ id: 1, product_id: 1, amount: 2, note: "Full fat", shopping_list_id: 1 }]
          : []
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(list))
        return
      }

      if (urlPath === "/api/stock") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([
          { product_id: 1, amount: 3, best_before_date: "2026-12-01", product: { name: "Milk" } },
        ]))
        return
      }

      if (urlPath === "/api/chores/101/execute") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 901 }))
        return
      }

      if (urlPath === "/api/tasks/201/complete" || urlPath === "/api/stock/shoppinglist/clear" || urlPath === "/api/stock/shoppinglist/add-product") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }))
        return
      }

      if (urlPath === "/api/objects/tasks") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ created_object_id: 301 }))
        return
      }

      res.writeHead(404).end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const { port } = server.address() as AddressInfo
  const serverUrl = `http://127.0.0.1:${port}`

  try {
    // 1. Direct GrocyAdapter calls
    const adapter = new GrocyAdapter({ baseUrl: serverUrl, apiKey: "test-grocy-key", timeoutMs: 2_000 })
    const sysInfo = await adapter.getSystemInfo()
    expect(sysInfo.ok).toBe(true)
    if (sysInfo.ok) expect(sysInfo.data.grocyVersionInfo.Version).toBe("4.2.0")

    const stock = await adapter.checkStock(["milk"])
    expect(stock.ok).toBe(true)
    const addedShopping = await adapter.addToShoppingList([{ productId: 1, amount: 1, shoppingListId: 1 }])
    expect(addedShopping.ok).toBe(true)
    const createdTask = await adapter.createTask("Direct Task", { description: "Adapter test", dueDate: "2026-11-30" })
    expect(createdTask.ok).toBe(true)

    // 2. GrocyBridge lifecycle + Round 1 sync
    const bridge = await import("../../apps/web/src/domains/grocy/grocy-bridge")
    bridge.startGrocySync({
      syncEnabled: true,
      syncMode: "bidirectional",
      intervalMs: 600_000,
    }, adapter)

    expect(bridge.getGrocySyncStatus().active).toBe(true)
    expect(bridge.getActiveGrocySyncConfig()?.syncMode).toBe("bidirectional")

    const round1Result = await bridge.syncFromGrocy()
    expect(round1Result.errors).toBe(0)
    expect(round1Result.chores).toBeGreaterThanOrEqual(2)
    expect(round1Result.tasks).toBeGreaterThanOrEqual(1)
    expect(round1Result.shopping).toBeGreaterThanOrEqual(1)

    // Look up synced tasks to exercise outbound completion push for chore, task, and shopping list
    const syncedRows = await client.execute({
      sql: "SELECT id, title, idempotency_key, custom_fields FROM tasks WHERE idempotency_key LIKE 'grocy-%'",
      args: [],
    })
    expect(syncedRows.rows.length).toBeGreaterThanOrEqual(3)

    let choreTaskId: string | undefined
    let grocyTaskId: string | undefined
    let shoppingTaskId: string | undefined
    for (const row of syncedRows.rows) {
      const r = row as Record<string, unknown>
      const title = String(r.title ?? "")
      const idem = String(r.idempotency_key ?? "")
      const cf = String(r.custom_fields ?? "{}")
      if (title.includes("Clean coffee machine") || idem.includes("chore-101") || cf.includes("101")) choreTaskId = String(r.id)
      if (title.includes("Buy coffee beans") || idem.includes("task-201") || cf.includes("201")) grocyTaskId = String(r.id)
      if (title.includes("Shopping") || idem.includes("shopping") || cf.includes("shopping")) shoppingTaskId = String(r.id)
    }

    expect(choreTaskId).toBeTruthy()
    expect(grocyTaskId).toBeTruthy()
    expect(shoppingTaskId).toBeTruthy()

    expect(await bridge.pushCompletionToGrocy(choreTaskId!)).toBe(true)
    expect(await bridge.pushCompletionToGrocy(grocyTaskId!)).toBe(true)
    expect(await bridge.pushCompletionToGrocy(shoppingTaskId!)).toBe(true)

    expect(apiHits).toContain("POST /api/chores/101/execute")
    expect(apiHits).toContain("POST /api/tasks/201/complete")
    expect(apiHits).toContain("POST /api/stock/shoppinglist/clear")

    // Exercise pushNewTaskToGrocy
    const now = Date.now()
    await client.execute({
      sql: `INSERT INTO tasks (id, title, status, priority, labels, task_type, area_id,
            framework_payload, calendar_sync_state, idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, 'pending', 2, '[]', 'task', 'default', '{}', 'pending', 'idem-local-new-1', 'req-local-new-1', ?, ?)`,
      args: ["local-new-1", "Order filters", now, now],
    })
    expect(await bridge.pushNewTaskToGrocy("local-new-1", "Order filters", { description: "HEPA", dueDate: "2026-11-25" })).toBe(true)

    // Round 2 sync (update existing + stale archival + completed task status override)
    round = 2
    const round2Result = await bridge.syncFromGrocy()
    expect(round2Result.errors).toBe(0)

    // 3. Outbound Sync + Webhook Dispatcher
    const dispatcher = await import("../../apps/web/src/lib/webhook-dispatcher")
    const outbound = await import("../../apps/web/src/lib/sync-outbound")

    const settingPairs: Array<[string, string]> = [
      ["webhook_endpoint", JSON.stringify(`${serverUrl}/webhook`)],
      ["webhook_secret", JSON.stringify("unit-webhook-secret")],
      ["n8n_webhook_url", JSON.stringify(`${serverUrl}/n8n-webhook`)],
      ["n8n_events", JSON.stringify(["task.created", "task.completed"])],
    ]
    for (const [k, v] of settingPairs) {
      await client.execute({
        sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [k, v, now],
      })
    }

    dispatcher.resetWebhookCacheForTests()
    const authHeaders = await dispatcher.taskEventAuthorityHeaders(["task.created", "task.completed"])
    expect(typeof authHeaders).toBe("object")

    await dispatcher.dispatchTaskEvent("task.created", {
      id: "local-new-1",
      title: "Webhook Task",
      status: "pending",
      labels: [],
    }, "req-wh-1")
    await expect.poll(() => webhookDeliveries.length, { timeout: 3_000 }).toBeGreaterThanOrEqual(2)
    await expect.poll(async () => {
      const deliveryRow = await client.execute({
        sql: "SELECT value FROM settings WHERE key = 'n8n_last_delivery'",
        args: [],
      })
      return deliveryRow.rows.length
    }, { timeout: 3_000 }).toBe(1)

    await outbound.pushToActiveSyncs("task.updated", { id: "skip-1", title: "Skip", status: "pending", labels: ["no-sync"] })
    await outbound.pushToActiveSyncs("task.deleted", { id: "del-1", title: "Del", status: "pending", labels: [] })
    await outbound.pushToActiveSyncs("task.created", { id: "local-new-1", title: "Outbound Create", status: "pending", labels: [] })
    await outbound.pushToActiveSyncs("task.completed", { id: "local-new-1", title: "Outbound Done", status: "complete", labels: [] })
    await new Promise((resolve) => setTimeout(resolve, 150))

    bridge.stopGrocySync()
    expect(bridge.getGrocySyncStatus().active).toBe(false)

    // 4. Due-date reminders
    const reminders = await import("../../apps/web/src/domains/notifications/due-date-reminders")
    await client.execute({
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [
        "notification_preferences",
        JSON.stringify({
          enabled: true,
          due_date_reminders: true,
          reminder_window_minutes: 60,
          channels: { sidebar: true, mobile_push: true },
          mobile_targets: ["notify.mobile_app_phone"],
        }),
        now,
      ],
    })
    await client.execute({
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: ["calendar_entity", JSON.stringify("calendar.family"), now],
    })
    await client.execute({
      sql: `INSERT INTO tasks (id, title, status, priority, due_date, labels, task_type, area_id,
            ticket_number, framework_payload, calendar_sync_state, idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, 'pending', 1, ?, '[]', 'task', 'default', 77, '{}', 'pending', 'idem-due-77', 'req-due-77', ?, ?)`,
      args: ["due-soon-77", "Check boiler pressure", new Date(now + 20 * 60_000).toISOString(), now, now],
    })
    reminders.invalidateSettingsCache()
    await reminders.checkDueDates(now)
    await reminders.checkDueDates(now)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
