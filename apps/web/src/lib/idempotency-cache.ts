/**
 * Idempotency Cache — Shared Infrastructure
 *
 * In-memory response cache for `Idempotency-Key` header support.
 * Prevents duplicate state mutations from retrying agents and workflows.
 *
 * @domain shared-infrastructure
 * @kcs Reusable by any domain — not tied to tasks or auth.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CachedResponse {
  status: number
  headers: Record<string, string>
  body: string
  processedAt: number
}

type InFlightEntry = { inFlight: true; startedAt: number }
type CompletedEntry = { inFlight: false; response: CachedResponse; expiresAt: number }
type CacheEntry = InFlightEntry | CompletedEntry

// ── Configuration ────────────────────────────────────────────────────────────

export interface IdempotencyCacheOptions {
  /** Maximum cached entries before LRU eviction (default: 10,000) */
  maxEntries?: number
  /** Time-to-live in milliseconds (default: 24 hours) */
  ttlMs?: number
  /** In-flight timeout in milliseconds — auto-clear stuck entries (default: 30s) */
  inFlightTimeoutMs?: number
}

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours
const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 30_000  // 30 seconds

// ── Cache Implementation ─────────────────────────────────────────────────────

export class IdempotencyCache {
  private cache = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly ttlMs: number
  private readonly inFlightTimeoutMs: number

  constructor(options: IdempotencyCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.inFlightTimeoutMs = options.inFlightTimeoutMs ?? DEFAULT_IN_FLIGHT_TIMEOUT_MS
  }

  /**
   * Get a cached response for the given idempotency key.
   * Returns null if key not found or expired.
   */
  get(key: string): CachedResponse | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    if (entry.inFlight) return null  // Use isInFlight() to check this case

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key)
      return null
    }

    return entry.response
  }

  /**
   * Check if a request with this key is currently being processed.
   * Auto-clears stuck in-flight entries past timeout.
   */
  isInFlight(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry || !entry.inFlight) return false

    // Auto-clear stuck in-flight entries
    if (Date.now() - entry.startedAt > this.inFlightTimeoutMs) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  /**
   * Mark a key as in-flight (being processed).
   * Call before processing the request.
   */
  markInFlight(key: string): boolean {
    if (!this.evictIfNeeded()) return false
    this.cache.set(key, { inFlight: true, startedAt: Date.now() })
    return true
  }

  /**
   * Store the completed response for a key.
   * Call after the request is processed.
   */
  set(key: string, response: CachedResponse): void {
    this.cache.set(key, {
      inFlight: false,
      response,
      expiresAt: Date.now() + this.ttlMs,
    })
  }

  /**
   * Remove a key from the cache.
   * Used when processing fails and we don't want to cache the error.
   */
  remove(key: string): void {
    this.cache.delete(key)
  }

  /** Current number of entries (for monitoring) */
  get size(): number {
    return this.cache.size
  }

  /** Evict oldest entries when at capacity (LRU by insertion order) */
  private evictIfNeeded(): boolean {
    if (this.cache.size < this.maxEntries) return true
    this.purgeExpired()
    if (this.cache.size < this.maxEntries) return true

    for (const [key, entry] of this.cache) {
      if (!entry.inFlight) {
        this.cache.delete(key)
        return true
      }
    }
    return false
  }

  /** Purge all expired entries (maintenance) */
  purgeExpired(): number {
    const now = Date.now()
    let purged = 0
    for (const [key, entry] of this.cache) {
      if (entry.inFlight && now - entry.startedAt > this.inFlightTimeoutMs) {
        this.cache.delete(key)
        purged++
      } else if (!entry.inFlight && now > entry.expiresAt) {
        this.cache.delete(key)
        purged++
      }
    }
    return purged
  }

  /** Clear entire cache */
  clear(): void {
    this.cache.clear()
  }
}

// ── Singleton Instance ───────────────────────────────────────────────────────

/** Shared idempotency cache instance for middleware use */
export const idempotencyCache = new IdempotencyCache({
  maxEntries: 256,
  inFlightTimeoutMs: Number.POSITIVE_INFINITY,
})
