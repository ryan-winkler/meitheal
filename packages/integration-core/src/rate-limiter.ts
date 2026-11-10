// Token bucket rate limiter for API routes
// Designed for /api/v1/* compat routes behind HA ingress proxy

export interface RateLimiterConfig {
  /** Max requests per window */
  capacity: number
  /** Window duration in milliseconds */
  windowMs: number
  /** Max buckets to track (LRU eviction) */
  maxBuckets: number
}

interface Bucket {
  tokens: number
  lastRefill: number
  lastAccess: number
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetMs: number
  limit: number
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  capacity: 100,
  windowMs: 60_000,
  maxBuckets: 10_000,
}

export class RateLimiter {
  private readonly config: RateLimiterConfig
  private readonly buckets = new Map<string, Bucket>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(config?: Partial<RateLimiterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    // Periodic cleanup every 5 minutes (OA-202: TTL eviction)
    this.cleanupTimer = setInterval(() => this.evictStale(), 5 * 60_000)
    if (this.cleanupTimer.unref) this.cleanupTimer.unref()
  }

  /**
   * Extract client IP from request headers.
   * FR-204: Use X-Forwarded-For behind HA ingress proxy.
   */
  static extractClientIp(headers: Record<string, string | undefined>): string {
    const forwarded = headers["x-forwarded-for"]
    if (forwarded) {
      // First IP in chain is the original client
      const firstIp = forwarded.split(",")[0]?.trim()
      if (firstIp) return firstIp
    }
    return headers["x-real-ip"] ?? "unknown"
  }

  check(key: string): RateLimitResult {
    const now = Date.now()
    let bucket = this.buckets.get(key)

    if (!bucket) {
      bucket = {
        tokens: this.config.capacity,
        lastRefill: now,
        lastAccess: now,
      }
      this.buckets.set(key, bucket)
      this.enforceMaxBuckets()
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill
    const refillAmount = (elapsed / this.config.windowMs) * this.config.capacity
    bucket.tokens = Math.min(this.config.capacity, bucket.tokens + refillAmount)
    bucket.lastRefill = now
    bucket.lastAccess = now

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetMs: this.config.windowMs,
        limit: this.config.capacity,
      }
    }

    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.ceil(((1 - bucket.tokens) / this.config.capacity) * this.config.windowMs),
      limit: this.config.capacity,
    }
  }

  /** OA-202: Evict buckets not accessed in 10 minutes */
  private evictStale(): void {
    const cutoff = Date.now() - 10 * 60_000
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastAccess < cutoff) {
        this.buckets.delete(key)
      }
    }
  }

  /** OA-202: LRU eviction when too many buckets */
  private enforceMaxBuckets(): void {
    if (this.buckets.size <= this.config.maxBuckets) return

    // Find and remove oldest-accessed bucket
    let oldestKey: string | null = null
    let oldestAccess = Infinity
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastAccess < oldestAccess) {
        oldestAccess = bucket.lastAccess
        oldestKey = key
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey)
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    this.buckets.clear()
  }
}

/** Rate limit response headers */
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "x-ratelimit-limit": String(result.limit),
    "x-ratelimit-remaining": String(result.remaining),
    "x-ratelimit-reset": String(Math.ceil(result.resetMs / 1000)),
  }
}
