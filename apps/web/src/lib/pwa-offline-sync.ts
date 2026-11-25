/**
 * Offline Mutation Outbox & Background Sync for Meitheal PWA.
 *
 * Queues same-origin task creation/update requests in IndexedDB when offline
 * and replays them automatically on reconnect or Service Worker Background Sync.
 *
 * Security invariants:
 * - Strictly restricts queued URLs to same-origin `/api/tasks` paths.
 * - Never persists bearer tokens, cookies, or session credentials in IndexedDB.
 */

export const OFFLINE_SYNC_TAG = "meitheal-background-sync"
export const OFFLINE_QUEUE_EVENT = "meitheal:offline-queue-changed"

const DB_NAME = "meitheal-offline-outbox"
const DB_VERSION = 1
const STORE_NAME = "mutations"
const SAFE_TASK_MUTATION_URL = /^\/api\/tasks(?:\/[A-Za-z0-9_-]+)?(?:\?[^#\s]*)?$/
const SAFE_BOARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MAX_OFFLINE_BODY_BYTES = 65_536

export type OfflineMutationMethod = "POST" | "PATCH" | "PUT"

export interface OfflineMutationRecord {
  id: string
  url: string
  method: OfflineMutationMethod
  boardId?: string
  body: string
  createdAt: number
}

export interface OfflineReplayResult {
  synced: number
  remaining: number
  dropped: number
}

export function isSafeOfflineMutationUrl(url: string): boolean {
  if (typeof url !== "string") return false
  const trimmed = url.trim()
  if (!trimmed.startsWith("/api/tasks")) return false
  if (trimmed.includes("..") || trimmed.includes("\\") || trimmed.startsWith("//")) return false
  return SAFE_TASK_MUTATION_URL.test(trimmed)
}

export function sanitizeOfflineBoardId(boardId?: string): string | undefined {
  if (typeof boardId !== "string") return undefined
  const trimmed = boardId.trim()
  return SAFE_BOARD_ID_RE.test(trimmed) ? trimmed : undefined
}

export function buildOfflineSyncSummary(queued: number, synced: number): string {
  if (synced > 0) {
    const noun = synced === 1 ? "change" : "changes"
    return `Synced ${synced} offline ${noun}`
  }
  if (queued > 0) {
    const noun = queued === 1 ? "change" : "changes"
    return `Offline mode — ${queued} pending ${noun} will sync automatically when back online.`
  }
  return "Offline mode — showing cached app shell. Changes sync when back online."
}

function openOutboxDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function notifyQueueChanged(count: number): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_EVENT, { detail: { count } }))
}

async function registerBackgroundSync(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  try {
    const reg = await navigator.serviceWorker.ready
    const syncManager = (reg as ServiceWorkerRegistration & {
      sync?: { register: (tag: string) => Promise<void> }
    }).sync
    if (syncManager && typeof syncManager.register === "function") {
      await syncManager.register(OFFLINE_SYNC_TAG)
    }
  } catch {
    // Background Sync API is optional (Safari/Firefox fall back to online event replay)
  }
}

export async function enqueueOfflineMutation(input: {
  url: string
  method: OfflineMutationMethod
  boardId?: string
  body: string
}): Promise<OfflineMutationRecord | null> {
  if (!isSafeOfflineMutationUrl(input.url)) {
    throw new Error("Unsupported offline mutation endpoint")
  }
  if (typeof input.body !== "string" || input.body.length > MAX_OFFLINE_BODY_BYTES) {
    throw new Error("Offline payload exceeds maximum size")
  }
  const db = await openOutboxDb()
  if (!db) return null

  const record: OfflineMutationRecord = {
    id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    url: input.url.trim(),
    method: input.method,
    boardId: sanitizeOfflineBoardId(input.boardId),
    body: input.body,
    createdAt: Date.now(),
  }

  const saved = await new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite")
      tx.objectStore(STORE_NAME).put(record)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    } catch {
      resolve(false)
    }
  })
  db.close()
  if (!saved) return null

  const count = await countOfflineMutations()
  notifyQueueChanged(count)
  void registerBackgroundSync()
  return record
}

export async function listOfflineMutations(): Promise<OfflineMutationRecord[]> {
  const db = await openOutboxDb()
  if (!db) return []
  const items = await new Promise<OfflineMutationRecord[]>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : [])
      req.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
  db.close()
  return items.sort((a, b) => a.createdAt - b.createdAt)
}

export async function countOfflineMutations(): Promise<number> {
  const db = await openOutboxDb()
  if (!db) return 0
  const count = await new Promise<number>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly")
      const req = tx.objectStore(STORE_NAME).count()
      req.onsuccess = () => resolve(typeof req.result === "number" ? req.result : 0)
      req.onerror = () => resolve(0)
    } catch {
      resolve(0)
    }
  })
  db.close()
  return count
}

async function deleteOfflineMutation(id: string): Promise<void> {
  const db = await openOutboxDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite")
      tx.objectStore(STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  db.close()
}

export async function clearOfflineMutations(): Promise<void> {
  const db = await openOutboxDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite")
      tx.objectStore(STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  db.close()
  notifyQueueChanged(0)
}

let replayInFlight: Promise<OfflineReplayResult> | null = null

export function replayOfflineMutations(): Promise<OfflineReplayResult> {
  if (replayInFlight) return replayInFlight
  replayInFlight = runReplay().finally(() => {
    replayInFlight = null
  })
  return replayInFlight
}

async function runReplay(): Promise<OfflineReplayResult> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { synced: 0, remaining: await countOfflineMutations(), dropped: 0 }
  }
  const items = await listOfflineMutations()
  if (!items.length) return { synced: 0, remaining: 0, dropped: 0 }

  let synced = 0
  let dropped = 0

  for (const item of items) {
    if (!isSafeOfflineMutationUrl(item.url) || typeof item.body !== "string" || item.body.length > MAX_OFFLINE_BODY_BYTES) {
      await deleteOfflineMutation(item.id)
      dropped++
      continue
    }
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" }
      const safeBoardId = sanitizeOfflineBoardId(item.boardId)
      if (safeBoardId) headers["X-Meitheal-Board-Id"] = safeBoardId
      const res = await fetch(item.url, {
        method: item.method,
        headers,
        body: item.body,
      })
      if (res.ok) {
        await deleteOfflineMutation(item.id)
        synced++
      } else if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 && res.status !== 401 && res.status !== 403) {
        // Permanent validation error: remove from outbox so it does not block subsequent writes
        await deleteOfflineMutation(item.id)
        dropped++
      } else {
        // Transient auth/server error: stop replay and retry later
        break
      }
    } catch {
      // Network unavailable again: preserve remaining items
      break
    }
  }

  const remaining = await countOfflineMutations()
  notifyQueueChanged(remaining)
  return { synced, remaining, dropped }
}
