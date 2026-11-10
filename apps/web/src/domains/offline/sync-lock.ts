/**
 * Sync Lock — Web Locks API for sync queue safety
 *
 * Ensures only one browser tab processes the sync queue at a time.
 * Uses the Web Locks API where available, with a fallback to
 * localStorage-based tab coordination.
 *
 * Bounded context: offline (sync safety)
 */

const LOCK_NAME = "meitheal-sync-lock"
const LS_LOCK_KEY = "meitheal_sync_lock"
const LOCK_TTL_MS = 30_000 // 30s max lock hold

/**
 * Acquire the sync lock. Returns a release function.
 * Uses Web Locks API when available, localStorage fallback otherwise.
 */
export async function acquireSyncLock(): Promise<(() => void) | null> {
  if (typeof navigator !== "undefined" && "locks" in navigator) {
    return acquireWebLock()
  }
  return acquireLocalStorageLock()
}

async function acquireWebLock(): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    const controller = new AbortController()

    navigator.locks.request(
      LOCK_NAME,
      { signal: controller.signal },
      () => {
        // Lock acquired — return release function
        resolve(() => controller.abort())
        // Hold lock until aborted
        return new Promise<void>((holdResolve) => {
          controller.signal.addEventListener("abort", () => holdResolve())
        })
      }
    ).catch(() => {
      resolve(null) // Lock acquisition failed
    })
  })
}

function acquireLocalStorageLock(): (() => void) | null {
  const now = Date.now()
  const existing = localStorage.getItem(LS_LOCK_KEY)

  if (existing) {
    const lockTime = parseInt(existing, 10)
    if (now - lockTime < LOCK_TTL_MS) {
      return null // Another tab holds the lock
    }
  }

  // Acquire
  localStorage.setItem(LS_LOCK_KEY, String(now))

  return () => {
    localStorage.removeItem(LS_LOCK_KEY)
  }
}

/**
 * Execute a callback while holding the sync lock.
 * If lock can't be acquired, returns null without executing.
 */
export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const release = await acquireSyncLock()
  if (!release) return null

  try {
    return await fn()
  } finally {
    release()
  }
}
