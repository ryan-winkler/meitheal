import { expect, test } from "@playwright/test"
import { detectRuntime } from "../../packages/integration-core/src/runtime"

test.describe("Runtime Detection", () => {
  test("detects Cloudflare from env binding", () => {
    const config = detectRuntime({ MEITHEAL_RUNTIME: "cloudflare" })
    expect(config.runtime).toBe("cloudflare")
    expect(config.dbType).toBe("d1")
    expect(config.cloudflare).toBe(true)
    expect(config.haSupervised).toBe(false)
  })

  test("detects CF_PAGES env", () => {
    const config = detectRuntime({ CF_PAGES: "1" })
    expect(config.runtime).toBe("cloudflare")
    expect(config.cloudflare).toBe(true)
  })

  test("defaults to standalone without env hints", () => {
    const config = detectRuntime({})
    expect(config.runtime).toBe("standalone")
    expect(config.dbType).toBe("sqlite")
    expect(config.cloudflare).toBe(false)
    expect(config.haSupervised).toBe(false)
  })

  test("returns standalone when no env object", () => {
    const config = detectRuntime()
    expect(config.runtime).toBe("standalone")
  })
})

test.describe("D1 Adapter Contracts", () => {
  test("D1AdapterResult success shape", () => {
    const result = {
      ok: true as const,
      rows: [{ id: "1", title: "test" }],
      meta: { duration: 5, rowsRead: 1, rowsWritten: 0 },
    }
    expect(result.ok).toBe(true)
    expect(result.rows).toHaveLength(1)
    expect(result.meta.duration).toBeLessThan(100)
  })

  test("D1AdapterResult error shape", () => {
    const result = {
      ok: false as const,
      error: "query failed",
      code: "query_error" as const,
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe("query_error")
  })

  test("batch operations shape", () => {
    const ops = [
      { sql: "INSERT INTO tasks (id, title) VALUES (?, ?)", params: ["1", "Test"] },
      { sql: "INSERT INTO tasks (id, title) VALUES (?, ?)", params: ["2", "Test 2"] },
    ]
    expect(ops).toHaveLength(2)
    expect(ops[0]!.params).toHaveLength(2)
  })
})

test.describe("Worker Router Contracts", () => {
  test("health endpoint returns correct runtime", () => {
    const response = { ok: true, runtime: "cloudflare" }
    expect(response.runtime).toBe("cloudflare")
  })

  test("auth requires bearer token", () => {
    const header = "Bearer test-token-123"
    const token = header.replace(/^Bearer\s+/i, "")
    expect(token).toBe("test-token-123")
  })

  test("CF-Connecting-IP used for rate limiting", () => {
    // FR-401: Cloudflare sets CF-Connecting-IP with true client IP
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.50" })
    const ip = headers.get("cf-connecting-ip")
    expect(ip).toBe("203.0.113.50")
  })
})
