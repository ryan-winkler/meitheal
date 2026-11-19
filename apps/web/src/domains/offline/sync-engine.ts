import { currentTaskApiContext, taskApiHeaders } from "@lib/task-api"
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
  currentOfflinePartition, assertOfflinePartition, offlinePartitionKey,
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
export async function processSyncQueue(baseUrl = ""): Promise<SyncResult> {
  const result: SyncResult = { processed: 0, succeeded: 0, failed: 0, conflicts: 0 }
  const partition = currentOfflinePartition()
  if (!partition || !navigator.onLine || syncState === "syncing") return result
  syncState = "syncing"
  emitSyncEvent({ type: "sync-start" })
  try {
    const queue = await getSyncQueue(partition)
    for (const op of queue) {
      assertOfflinePartition(partition)
      if (!op.partition || offlinePartitionKey(op.partition) !== offlinePartitionKey(partition)) {
        result.failed++
        emitSyncEvent({ type: "sync-error", error: "An offline edit has no matching original account and Board. It remains saved for review." })
        break
      }
      result.processed++
      try {
        const response = await executeOperation(op, baseUrl)
        assertOfflinePartition(partition)
        if (!response.ok) {
          result.failed++
          if (response.status === 409) {
            result.conflicts++
            emitSyncEvent({ type: "sync-error", error: "An offline edit conflicts with current work. Both versions are kept for review." })
          } else if ([401, 403, 404].includes(response.status)) {
            emitSyncEvent({ type: "sync-error", error: "The original Board or action is unavailable. Offline edits remain saved." })
          } else {
            await incrementRetryCount(op.id, partition)
            emitSyncEvent({ type: "sync-error", error: "The offline edit is unconfirmed and remains saved. Reconnect before checking it again." })
          }
          break
        }
        if (op.operation !== "delete") {
          const task = await response.json() as Record<string, unknown>
          assertOfflinePartition(partition)
          // A write-only acknowledgement is never a full offline task snapshot.
          if (typeof task.title === "string" && typeof task.id === "string") {
            const instant = (value: unknown) => typeof value === "number" ? new Date(value).toISOString() : String(value ?? "")
            await putTask({
              id: task.id, title: task.title, description: String(task.description ?? ""),
              status: String(task.status ?? "pending") as OfflineTask["status"], priority: Number(task.priority ?? 3),
              dueDate: typeof task.due_date === "string" ? task.due_date : null,
              updatedAt: instant(task.updated_at), createdAt: instant(task.created_at), syncedAt: new Date().toISOString(),
              areaId: typeof task.area_id === "string" ? task.area_id : null, labels: typeof task.labels === "string" ? task.labels : null,
              kind: String(task.task_kind ?? "standard_action"), sortOrder: Number(task.kanban_position ?? 0),
            }, partition)
          }
        }
        await removeSyncOp(op.id, partition)
        result.succeeded++
      } catch {
        result.failed++
        // An uncertain write is retained with the same operation ID. Never report
        // a conflict as a successful last-write-wins merge or drop an edit.
        assertOfflinePartition(partition)
        await incrementRetryCount(op.id, partition)
        emitSyncEvent({ type: "sync-error", error: "The offline edit is unconfirmed. Its original operation remains saved." })
        break
      }
    }
  } finally {
    syncState = result.failed ? "error" : "idle"
    emitSyncEvent({ type: "sync-complete", result })
  }
  return result
}

async function executeOperation(op: PendingSyncOperation, baseUrl: string): Promise<Response> {
  assertOfflinePartition(op.partition)
  const context = currentTaskApiContext()
  if (!context || context.actorKey !== op.partition.actorKey || context.boardId !== op.partition.boardId) {
    throw new Error("The original offline account and Board are unavailable.")
  }
  if (op.table !== "tasks") return new Response(null, { status: 404 })
  const origin = baseUrl ? new URL(baseUrl, location.href) : new URL(location.origin)
  if (origin.origin !== location.origin) throw new Error("Offline work cannot be sent to another origin.")
  const url = `${baseUrl}/api/tasks`
  const entityId = encodeURIComponent(op.entityId)
  const headers = taskApiHeaders(context, { "content-type": "application/json" })
  if (op.operation === "create") headers.set("Idempotency-Key", op.id)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(op.operation === "create" ? url : `${url}/${entityId}`, {
      method: op.operation === "create" ? "POST" : op.operation === "update" ? "PUT" : "DELETE",
      headers, ...(op.operation === "delete" ? {} : { body: op.payload }),
      signal: controller.signal, cache: "no-store", redirect: "error", mode: "same-origin",
    })
  } finally { clearTimeout(timeout) }
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
