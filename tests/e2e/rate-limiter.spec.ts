import { expect, test } from "@playwright/test"
import { RateLimiter, rateLimitHeaders } from "../../packages/integration-core/src/rate-limiter"

test.describe("Rate Limiter", () => {
  test("allows requests within limit", () => {
    const limiter = new RateLimiter({ capacity: 5, windowMs: 60_000, maxBuckets: 100 })

    for (let i = 0; i < 5; i++) {
      const result = limiter.check("192.168.1.1")
      expect(result.allowed).toBe(true)
      expect(result.remaining).toBe(5 - i - 1)
    }

    limiter.destroy()
  })

  test("rejects requests over limit", () => {
    const limiter = new RateLimiter({ capacity: 3, windowMs: 60_000, maxBuckets: 100 })

    // Exhaust the bucket
    for (let i = 0; i < 3; i++) {
      limiter.check("10.0.0.1")
    }

    const result = limiter.check("10.0.0.1")
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)

    limiter.destroy()
  })

  test("different IPs have independent buckets", () => {
    const limiter = new RateLimiter({ capacity: 1, windowMs: 60_000, maxBuckets: 100 })

    const r1 = limiter.check("ip-a")
    const r2 = limiter.check("ip-b")

    expect(r1.allowed).toBe(true)
    expect(r2.allowed).toBe(true)

    limiter.destroy()
  })

  test("generates correct rate limit headers", () => {
    const result = { allowed: true, remaining: 42, resetMs: 30_000, limit: 100 }
    const headers = rateLimitHeaders(result)

    expect(headers["x-ratelimit-limit"]).toBe("100")
    expect(headers["x-ratelimit-remaining"]).toBe("42")
    expect(headers["x-ratelimit-reset"]).toBe("30")
  })

  test("extracts client IP from X-Forwarded-For", () => {
    const ip = RateLimiter.extractClientIp({
      "x-forwarded-for": "203.0.113.50, 70.41.3.18, 150.172.238.178",
    })
    expect(ip).toBe("203.0.113.50")
  })

  test("falls back to X-Real-IP", () => {
    const ip = RateLimiter.extractClientIp({
      "x-real-ip": "198.51.100.1",
    })
    expect(ip).toBe("198.51.100.1")
  })

  test("returns unknown when no headers", () => {
    const ip = RateLimiter.extractClientIp({})
    expect(ip).toBe("unknown")
  })
})
