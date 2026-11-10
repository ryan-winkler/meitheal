import { expect, test } from "@playwright/test"
import { GrocyAdapter } from "../../packages/integration-core/src/grocy-adapter"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

// --- Mock Grocy API server ---

function createMockGrocyServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({
        port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

test.describe("Grocy Adapter", () => {
  test("checkStock returns matching items", async () => {
    const mock = await createMockGrocyServer((req, res) => {
      if (req.url === "/api/stock") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify([
            { product_id: 1, product: { name: "Milk" }, amount: 2, best_before_date: "2026-03-15" },
            { product_id: 2, product: { name: "Bread" }, amount: 1, best_before_date: null },
            { product_id: 3, product: { name: "Butter" }, amount: 0, best_before_date: null },
          ])
        )
      }
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.checkStock(["milk", "butter"])
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(2)
        expect(result.data[0]!.name).toBe("Milk")
        expect(result.data[1]!.name).toBe("Butter")
      }
    } finally {
      await mock.close()
    }
  })

  test("addToShoppingList sends correct API calls", async () => {
    const calls: string[] = []
    const mock = await createMockGrocyServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        calls.push(`${req.method} ${req.url} ${body}`)
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.addToShoppingList([
        { productId: 1, amount: 2, note: "Low on milk" },
      ])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.added).toBe(1)
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("POST /api/stock/shoppinglist/add-product")
    } finally {
      await mock.close()
    }
  })

  test("handles HTTP error gracefully", async () => {
    const mock = await createMockGrocyServer((_req, res) => {
      res.writeHead(401)
      res.end("Unauthorized")
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "bad-key",
      })

      const result = await adapter.checkStock(["milk"])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errorCode).toBe("unauthorized")
        expect(result.retryable).toBe(false)
      }
    } finally {
      await mock.close()
    }
  })

  test("handles timeout", async () => {
    const mock = await createMockGrocyServer((_req, _res) => {
      // Never respond — causes timeout
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
        timeoutMs: 500,
      })

      const result = await adapter.checkStock(["milk"])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errorCode).toBe("timeout")
        expect(result.retryable).toBe(true)
      }
    } finally {
      await mock.close()
    }
  })

  test("handles 5xx as retryable", async () => {
    const mock = await createMockGrocyServer((_req, res) => {
      res.writeHead(503)
      res.end("Service Unavailable")
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.checkStock(["bread"])
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.errorCode).toBe("service_unavailable")
        expect(result.retryable).toBe(true)
      }
    } finally {
      await mock.close()
    }
  })

  test("getProducts returns product name map", async () => {
    const mock = await createMockGrocyServer((req, res) => {
      if (req.url === "/api/objects/products") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify([
            { id: 1, name: "Milk" },
            { id: 2, name: "Bread" },
            { id: 3, name: "Eggs" },
          ])
        )
      }
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.getProducts()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.get(1)).toBe("Milk")
        expect(result.data.get(2)).toBe("Bread")
        expect(result.data.get(3)).toBe("Eggs")
        expect(result.data.size).toBe(3)
      }
    } finally {
      await mock.close()
    }
  })

  test("getCategories returns category name map", async () => {
    const mock = await createMockGrocyServer((req, res) => {
      if (req.url === "/api/objects/task_categories") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify([
            { id: 1, name: "Household" },
            { id: 2, name: "Work" },
          ])
        )
      }
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.getCategories()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.get(1)).toBe("Household")
        expect(result.data.get(2)).toBe("Work")
      }
    } finally {
      await mock.close()
    }
  })

  test("clearShoppingList sends POST to correct endpoint", async () => {
    const calls: string[] = []
    const mock = await createMockGrocyServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        calls.push(`${req.method} ${req.url} ${body}`)
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.clearShoppingList()
      expect(result.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("POST /api/stock/shoppinglist/clear")
      expect(calls[0]).toContain('"list_id":1')
    } finally {
      await mock.close()
    }
  })

  test("createTask sends correct payload and returns taskId", async () => {
    const calls: string[] = []
    const mock = await createMockGrocyServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        calls.push(`${req.method} ${req.url} ${body}`)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ created_object_id: 42 }))
      })
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.createTask("Buy groceries", {
        description: "Weekly shopping",
        dueDate: "2026-03-10",
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.taskId).toBe(42)
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("POST /api/objects/tasks")
      expect(calls[0]).toContain('"name":"Buy groceries"')
      expect(calls[0]).toContain('"description":"Weekly shopping"')
    } finally {
      await mock.close()
    }
  })

  // ═══════ NEW TESTS: Full adapter surface coverage ═══════

  test("getSystemInfo returns version and system details", async () => {
    const mock = await createMockGrocyServer((req, res) => {
      if (req.url === "/api/system/info") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({
          grocy_version_info: { Version: "4.4.1", ReleaseDate: "2025-01-31" },
          php_version: "8.2.0",
          sqlite_version: "3.40.0",
          os: "Linux",
          client: "Grocy",
        }))
      }
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.getSystemInfo()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.grocyVersionInfo.Version).toBe("4.4.1")
        expect(result.data.grocyVersionInfo.ReleaseDate).toBe("2025-01-31")
        expect(result.data.phpVersion).toBe("8.2.0")
        expect(result.data.os).toBe("Linux")
      }
    } finally {
      await mock.close()
    }
  })

  test("getChores returns all chores with status fields", async () => {
    const mock = await createMockGrocyServer((req, res) => {
      if (req.url === "/api/chores") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify([
          {
            chore_id: 1,
            chore_name: "Vacuum Living Room",
            last_tracked_time: "2026-03-10 14:00:00",
            next_estimated_execution_time: "2026-03-17 14:00:00",
            next_execution_assigned_to_user_id: 1,
            next_execution_assigned_user: { id: 1, display_name: "Admin" },
            is_overdue: false,
            is_reassigned: false,
            track_date_only: false,
            period_type: "weekly",
            period_interval: 1,
          },
          {
            chore_id: 2,
            chore_name: "Take Out Trash",
            last_tracked_time: null,
            next_estimated_execution_time: "2026-03-14 00:00:00",
            is_overdue: true,
            period_type: "daily",
          },
        ]))
      }
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.getChores()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(2)
        expect(result.data[0]!.choreId).toBe(1)
        expect(result.data[0]!.choreName).toBe("Vacuum Living Room")
        expect(result.data[0]!.isOverdue).toBe(false)
        expect(result.data[0]!.periodType).toBe("weekly")
        expect(result.data[1]!.choreId).toBe(2)
        expect(result.data[1]!.isOverdue).toBe(true)
      }
    } finally {
      await mock.close()
    }
  })

  test("getTasks filters incomplete tasks when includeCompleted=false", async () => {
    const mock = await createMockGrocyServer((req, res) => {
      // The adapter should send ?query%5B%5D=done%3D0 for incomplete-only
      if (req.url?.startsWith("/api/tasks")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify([
          { id: 1, name: "Write report", done: 0, due_date: "2026-03-20", category_id: 1 },
          { id: 2, name: "Fix bug", done: 1, due_date: null, done_timestamp: "2026-03-15 10:00:00" },
        ]))
      }
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      // Test with includeCompleted=false (default)
      const result = await adapter.getTasks(false)
      expect(result.ok).toBe(true)
      if (result.ok) {
        // Client-side filter should exclude done=1 items
        expect(result.data).toHaveLength(1)
        expect(result.data[0]!.name).toBe("Write report")
        expect(result.data[0]!.done).toBe(false)
      }

      // Test with includeCompleted=true
      const resultAll = await adapter.getTasks(true)
      expect(resultAll.ok).toBe(true)
      if (resultAll.ok) {
        expect(resultAll.data).toHaveLength(2)
      }
    } finally {
      await mock.close()
    }
  })

  test("markTaskCompleted sends POST to correct endpoint", async () => {
    const calls: string[] = []
    const mock = await createMockGrocyServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        calls.push(`${req.method} ${req.url} ${body}`)
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.markTaskCompleted(42)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.taskId).toBe(42)
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("POST /api/tasks/42/complete")
    } finally {
      await mock.close()
    }
  })

  test("trackChoreExecution sends POST with tracked_time", async () => {
    const calls: string[] = []
    const mock = await createMockGrocyServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        calls.push(`${req.method} ${req.url} ${body}`)
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: 99 }))
      })
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.trackChoreExecution(5)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.choreId).toBe(5)
        expect(result.data.executionId).toBe(99)
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("POST /api/chores/5/execute")
      expect(calls[0]).toContain("tracked_time")
    } finally {
      await mock.close()
    }
  })

  test("getShoppingList returns items with product IDs", async () => {
    const mock = await createMockGrocyServer((req, res) => {
      if (req.url === "/api/objects/shopping_list") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify([
          { id: 1, product_id: 10, amount: 2, note: "Low fat", shopping_list_id: 1 },
          { id: 2, product_id: 20, amount: 1, note: "", shopping_list_id: 1 },
        ]))
      }
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.getShoppingList()
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data).toHaveLength(2)
        expect(result.data[0]!.productId).toBe(10)
        expect(result.data[0]!.amount).toBe(2)
        expect(result.data[0]!.note).toBe("Low fat")
        expect(result.data[1]!.productId).toBe(20)
      }
    } finally {
      await mock.close()
    }
  })

  test("undoTask sends POST to undo endpoint", async () => {
    const calls: string[] = []
    const mock = await createMockGrocyServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        calls.push(`${req.method} ${req.url}`)
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.undoTask(7)
      expect(result.ok).toBe(true)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("POST /api/tasks/7/undo")
    } finally {
      await mock.close()
    }
  })

  test("consumeItems sends consume requests for each item", async () => {
    const calls: string[] = []
    const mock = await createMockGrocyServer((req, res) => {
      let body = ""
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on("end", () => {
        calls.push(`${req.method} ${req.url} ${body}`)
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
      })
    })

    try {
      const adapter = new GrocyAdapter({
        baseUrl: `http://127.0.0.1:${mock.port}`,
        apiKey: "test-key",
      })

      const result = await adapter.consumeItems([
        { productId: 1, amount: 1 },
        { productId: 2, amount: 3, transactionType: "spoiled" },
      ])

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.data.consumed).toBe(2)
      }
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain("POST /api/stock/products/1/consume")
      expect(calls[1]).toContain("POST /api/stock/products/2/consume")
      expect(calls[1]).toContain('"transaction_type":"spoiled"')
    } finally {
      await mock.close()
    }
  })
})
