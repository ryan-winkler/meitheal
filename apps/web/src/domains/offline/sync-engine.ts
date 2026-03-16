/**
 * Sync Engine — Background sync for offline operations
 *
 * Processes pending_sync queue FIFO, one-at-a-time.
 * Conflict resolution: last-write-wins based on server updatedAt.
 * SyncManager registration for reliable background delivery.
 * Fallback: 30s periodic sync when SyncManager unavailable.
 *
 * Bounded context: offline domain
 */

import {
  getSyncQueue,
  removeSyncOp,
  incrementRetryCount,
  putTask,
  cleanupExpiredSyncOps,
  type PendingSyncOperation,
  type OfflineTask,
} from "./offline-store"
import { createClientLogger } from "@lib/client-logger"

const log = createClientLogger("offline", "sync-engine")

// --- Types ---

export type SyncState = "idle" | "syncing" | "error"

export interface SyncResult {
  processed: number
  succeeded: number
  failed: number
  conflicts: number
}

export interface SyncEventDetail {
  type: "sync-start" | "sync-complete" | "sync-error" | "conflict-resolved"
  result?: SyncResult | undefined
  conflict?: { entityId: string; localUpdatedAt: string; serverUpdatedAt: string } | undefined
  error?: string | undefined
}

// --- Configuration ---

const SYNC_TAG = "meitheal-background-sync"
const MAX_RETRIES = 3
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000]
const PERIODIC_SYNC_MS = 30_000
const FETCH_TIMEOUT_MS = 10_000

// --- Sync Engine ---

let syncState: SyncState = "idle"
let periodicTimer: ReturnType<typeof setInterval> | null = null

function emitSyncEvent(detail: SyncEventDetail): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("meitheal-sync", { detail }))
  }
}

export function getSyncState(): SyncState {
  return syncState
}

/**
 * Process the sync queue — call this from SW sync event or periodic timer.
 */
export async function processSyncQueue(
  baseUrl: string = ""
): Promise<SyncResult> {
  if (syncState === "syncing") {
    return { processed: 0, succeeded: 0, failed: 0, conflicts: 0 }
  }

  syncState = "syncing"
  emitSyncEvent({ type: "sync-start" })

  const queue = await getSyncQueue()
  const result: SyncResult = { processed: 0, succeeded: 0, failed: 0, conflicts: 0 }

  for (const op of queue) {
    result.processed++

    try {
      const response = await executeOperation(op, baseUrl)

      if (response.ok) {
        await removeSyncOp(op.id)
        result.succeeded++

        // Update local store with server response (authoritative timestamps)
        if (op.operation !== "delete") {
          const serverData = await response.json() as OfflineTask
          await putTask({ ...serverData, syncedAt: new Date().toISOString() })
        }
      } else if (response.status === 409) {
        // Conflict: last-write-wins
        result.conflicts++
        const serverVersion = await response.json() as OfflineTask

        emitSyncEvent({
          type: "conflict-resolved",
          conflict: {
            entityId: op.entityId,
            localUpdatedAt: (JSON.parse(op.payload) as Record<string, string>).updatedAt ?? "unknown",
            serverUpdatedAt: serverVersion.updatedAt,
          },
        })

        // Server wins — update local with server data
        await putTask({ ...serverVersion, syncedAt: new Date().toISOString() })
        await removeSyncOp(op.id)
        result.succeeded++
        // Wait using exponential backoff based on retry count
        const delay = RETRY_DELAYS_MS[op.retryCount] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
        log.warn(`op ${op.id} failed, retrying in ${delay}ms...`)
        emitSyncEvent({
          type: "sync-error",
          error: `Network unstable. Retrying in ${delay / 1000}s...`,
        })
        await new Promise((r) => setTimeout(r, delay))
        // Break out of the current queue processing so we don't hammer the offline network
        break;
      } else {
        // Max retries exceeded — dead letter
        log.error(`Max retries exceeded for ${op.id}, removing from queue`)
        await removeSyncOp(op.id)
        result.failed++
      }
    } catch (error) {
      result.failed++
      if (op.retryCount < MAX_RETRIES) {
        await incrementRetryCount(op.id)
        const delay = RETRY_DELAYS_MS[op.retryCount] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!
        log.warn(`op ${op.id} failed, retrying in ${delay}ms...`)
        emitSyncEvent({
          type: "sync-error",
          error: `Network unstable. Retrying in ${delay / 1000}s...`,
        })
        await new Promise((r) => setTimeout(r, delay))
        break; // Break queue if the network is completely down
      } else {
        await removeSyncOp(op.id)
        emitSyncEvent({
          type: "sync-error",
          error: `Sync failed permanently for operation ${op.id}.`,
        })
        log.error(`Operation ${op.id} failed:`, error)
      }
    }
  }

  syncState = result.failed > 0 ? "error" : "idle"
  emitSyncEvent({ type: "sync-complete", result })
  return result
}

/**
 * Execute a single sync operation against the server API.
 */
async function executeOperation(
  op: PendingSyncOperation,
  baseUrl: string
): Promise<Response> {
  const url = `${baseUrl}/api/v1/${op.table}`
  const payload = JSON.parse(op.payload) as Record<string, unknown>
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    switch (op.operation) {
      case "create":
        return await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
      case "update":
        return await fetch(`${url}/${op.entityId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
      case "delete":
        return await fetch(`${url}/${op.entityId}`, {
          method: "DELETE",
          signal: controller.signal,
        })
    }
  } finally {
    clearTimeout(timeout)
  }
}

// --- Background Sync Registration ---

export async function registerBackgroundSync(): Promise<void> {
  if (!("serviceWorker" in navigator)) return

  try {
    const registration = await navigator.serviceWorker.ready
    if ("sync" in registration) {
      await (registration as ServiceWorkerRegistration & { sync: { register: (tag: string) => Promise<void> } }).sync.register(SYNC_TAG)
    } else {
      // Fallback: periodic sync
      startPeriodicSync()
    }
  } catch {
    // SyncManager not available — use periodic fallback
    startPeriodicSync()
  }
}

/**
 * Start periodic sync as fallback when SyncManager unavailable.
 */
export function startPeriodicSync(intervalMs: number = PERIODIC_SYNC_MS): void {
  if (periodicTimer) return
  periodicTimer = setInterval(() => {
    if (navigator.onLine) {
      cleanupExpiredSyncOps().then(removed => {
        if (removed > 0) log.debug(`Cleaned up ${removed} expired sync operations`)
      }).catch(err => log.error("Cleanup failed", err))
      processSyncQueue().catch((err) => log.error("Periodic sync failed", err))
    }
  }, intervalMs)

  // Ensure cleanup on page unload to prevent orphan timers
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", () => stopPeriodicSync(), { once: true })
  }
}

export function stopPeriodicSync(): void {
  if (periodicTimer) {
    clearInterval(periodicTimer)
    periodicTimer = null
  }
}

export function getSyncTag(): string {
  return SYNC_TAG
}
