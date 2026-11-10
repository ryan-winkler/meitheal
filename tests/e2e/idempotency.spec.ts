import { expect, test } from "@playwright/test"
import { taskRetryKey } from "../../apps/web/src/lib/idempotent-task-request"
import {
  IdempotencyCache,
  type CachedResponse,
} from "../../apps/web/src/lib/idempotency-cache"

/**
 * Idempotency Cache E2E Tests — Phase 24 T11
 *
 * Tests cover the in-memory cache behavior: TTL, LRU eviction,
 * in-flight tracking, and concurrent request handling.
 *
 * @domain infrastructure
 * @bounded-context idempotency
 */

/** Helper to build a valid CachedResponse */
function resp(status: number, body = ""): CachedResponse {
  return { status, headers: {}, body, processedAt: Date.now() }
}

test.describe("Idempotency Cache", () => {
  test("stores and retrieves cached responses", () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 })

    const cached = resp(201, '{"id":"123"}')
    cache.set("key-1", cached)
    const result = cache.get("key-1")

    expect(result).not.toBeNull()
    expect(result?.status).toBe(201)
    expect(result?.body).toBe('{"id":"123"}')
  })

  test("returns null for unknown keys", () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 })
    expect(cache.get("nonexistent")).toBeNull()
  })

  test("respects TTL — expired entries return null", async () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 50 }) // 50ms TTL

    cache.set("short-lived", resp(200))

    // Immediate read should succeed
    expect(cache.get("short-lived")).not.toBeNull()

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 100))

    expect(cache.get("short-lived")).toBeNull()
  })

  test("LRU eviction when capacity exceeded", () => {
    const cache = new IdempotencyCache({ maxEntries: 3, ttlMs: 60_000 })

    cache.set("a", resp(200, "a"))
    cache.set("b", resp(200, "b"))
    cache.set("c", resp(200, "c"))

    // All three should be present
    expect(cache.get("a")).not.toBeNull()
    expect(cache.get("b")).not.toBeNull()
    expect(cache.get("c")).not.toBeNull()

    // markInFlight triggers eviction when at capacity
    cache.markInFlight("d-pending")

    // "a" should be evicted (oldest)
    expect(cache.get("a")).toBeNull()
  })

  test("in-flight tracking — markInFlight and isInFlight", () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 })

    expect(cache.isInFlight("req-1")).toBe(false)

    cache.markInFlight("req-1")
    expect(cache.isInFlight("req-1")).toBe(true)

    // get returns null for in-flight entries
    expect(cache.get("req-1")).toBeNull()

    // Completing the request via set() clears in-flight
    cache.set("req-1", resp(201))
    expect(cache.isInFlight("req-1")).toBe(false)
    expect(cache.get("req-1")?.status).toBe(201)
  })

  test("concurrent requests with same key — second sees in-flight", () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 })

    cache.markInFlight("dup-key")

    // Simulate second request checking
    expect(cache.isInFlight("dup-key")).toBe(true)
    expect(cache.get("dup-key")).toBeNull() // not yet cached

    // First completes
    cache.set("dup-key", resp(201, '{"ok":true}'))

    // Third request finds cached response
    expect(cache.isInFlight("dup-key")).toBe(false)
    expect(cache.get("dup-key")?.status).toBe(201)
  })

  test("set overwrites existing entry", () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 })

    cache.set("overwrite-me", resp(200, "v1"))
    cache.set("overwrite-me", resp(201, "v2"))

    const result = cache.get("overwrite-me")
    expect(result?.status).toBe(201)
    expect(result?.body).toBe("v2")
  })

  test("remove deletes a cached entry", () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 })

    cache.set("to-remove", resp(200))
    expect(cache.get("to-remove")).not.toBeNull()

    cache.remove("to-remove")
    expect(cache.get("to-remove")).toBeNull()
  })

  test("size reflects current entries", () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000 })

    expect(cache.size).toBe(0)

    cache.set("a", resp(200))
    cache.set("b", resp(200))
    expect(cache.size).toBe(2)

    cache.remove("a")
    expect(cache.size).toBe(1)
  })

  test("purgeExpired removes stale entries", async () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 50 })

    cache.set("fresh", resp(200))
    cache.set("also-fresh", resp(200))

    await new Promise(r => setTimeout(r, 100))

    const purged = cache.purgeExpired()
    expect(purged).toBe(2)
    expect(cache.size).toBe(0)
  })

  test("in-flight auto-clears after timeout", async () => {
    const cache = new IdempotencyCache({ maxEntries: 10, ttlMs: 60_000, inFlightTimeoutMs: 50 })

    cache.markInFlight("stuck-req")
    expect(cache.isInFlight("stuck-req")).toBe(true)

    await new Promise(r => setTimeout(r, 100))

    // After timeout, isInFlight auto-clears
    expect(cache.isInFlight("stuck-req")).toBe(false)
  })
})

test("task retry keys separate actors, request targets, and body bytes", async () => {
  const makeRequest = (url: string, body: string) => new Request(url, {
    method: "POST",
    headers: { "idempotency-key": "unique-work", "content-type": "application/json" },
    body,
  })
  const base = "http://meitheal.local/api/tasks"
  const identity = async (principal: string | undefined, url = base, body = '{"title":"test"}') =>
    taskRetryKey(makeRequest(url, body), new URL(url), principal)
  const first = await identity("agent:one")

  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(await identity("agent:one")).toBe(first)
  expect(await identity("agent:two")).not.toBe(first)
  expect(await identity("agent:one", base + "/create")).not.toBe(first)
  expect(await identity("agent:one", base + "?test=1")).not.toBe(first)
  expect(await identity("agent:one", base, '{"title":"other"}')).not.toBe(first)
  expect(await identity(undefined)).toBeUndefined()
  expect(await identity("ha:admin", "http://meitheal.local/api/agent-tokens")).toBeUndefined()
})

test("full retry cache does not evict active task requests", () => {
  const cache = new IdempotencyCache({ maxEntries: 1 })
  expect(cache.markInFlight("active")).toBe(true)
  expect(cache.markInFlight("second")).toBe(false)
  expect(cache.isInFlight("active")).toBe(true)
})
