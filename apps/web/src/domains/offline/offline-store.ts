import { currentTaskApiContext } from "@lib/task-api"
/**
 * Offline Store — IndexedDB schema and CRUD operations
 *
 * Uses idb (lightweight promise-based wrapper) for type-safe IndexedDB access.
 * Schema version 1 — explicit upgrade handler for future migrations (FR-303).
 * All writes use explicit error handling (FR-304).
 *
 * Bounded context: offline domain
 */

import { createClientLogger } from "@lib/client-logger"
import { shouldEnableAttachmentIDB, shouldEnableIDB } from "@lib/companion-detect"

const log = createClientLogger("offline", "store")

// --- Types ---

export interface OfflineTask {
  id: string
  title: string
  description: string
  status: "backlog" | "pending" | "active" | "complete"
  priority: number
  dueDate: string | null
  updatedAt: string
  createdAt: string
  syncedAt: string | null
  areaId: string | null
  labels: string | null
  kind: string
  sortOrder: number
}

export interface PendingSyncOperation {
  id: string
  operation: "create" | "update" | "delete"
  table: string
  entityId: string
  payload: string
  createdAt: string
  retryCount: number
  partition: OfflinePartition
}

// --- IndexedDB Schema ---

const DB_NAME = "meitheal-offline"
const DB_VERSION = 3

const STORES = {
  tasks: "tasks",
  pendingSync: "pending_sync",
  taskAttachments: "task_attachments",
} as const

// --- Database Initialization ---

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Tasks store — mirrors server schema
      if (!db.objectStoreNames.contains(STORES.tasks)) {
        const taskStore = db.createObjectStore(STORES.tasks, { keyPath: "id" })
        taskStore.createIndex("status", "status", { unique: false })
        taskStore.createIndex("updatedAt", "updatedAt", { unique: false })
        taskStore.createIndex("priority", "priority", { unique: false })
        taskStore.createIndex("areaId", "areaId", { unique: false })
      } else {
        // V3 migration: add indexes to existing store
        const tx = (event.target as IDBOpenDBRequest).transaction!
        const taskStore = tx.objectStore(STORES.tasks)
        if (!taskStore.indexNames.contains("priority")) {
          taskStore.createIndex("priority", "priority", { unique: false })
        }
        if (!taskStore.indexNames.contains("areaId")) {
          taskStore.createIndex("areaId", "areaId", { unique: false })
        }
      }

      // Pending sync queue — FIFO operations
      if (!db.objectStoreNames.contains(STORES.pendingSync)) {
        const syncStore = db.createObjectStore(STORES.pendingSync, { keyPath: "id" })
        syncStore.createIndex("createdAt", "createdAt", { unique: false })
        syncStore.createIndex("table", "table", { unique: false })
      }

      // Offline Attachments (V2)
      if (!db.objectStoreNames.contains(STORES.taskAttachments)) {
        const attachStore = db.createObjectStore(STORES.taskAttachments, { keyPath: "id" })
        attachStore.createIndex("taskId", "taskId", { unique: false })
        attachStore.createIndex("createdAt", "createdAt", { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(`IndexedDB open failed: ${request.error?.message}`))
  })
}

// --- Singleton ---

export interface OfflinePartition { readonly actorKey: string, readonly boardId: string }
const databases = new Map<string, IDBDatabase>()
const partitionByDatabase = new WeakMap<IDBDatabase, OfflinePartition>()

export function currentOfflinePartition(): OfflinePartition | null {
  if (typeof document === "undefined") return null
  const context = currentTaskApiContext()
  return context?.actorKey && /^[a-f0-9]{64}$/.test(context.actorKey)
    ? Object.freeze({ actorKey: context.actorKey, boardId: context.boardId }) : null
}

export function offlinePartitionKey(partition: OfflinePartition): string {
  return `${partition.actorKey}:${encodeURIComponent(partition.boardId)}`
}

export function assertOfflinePartition(partition: OfflinePartition): void {
  const current = currentOfflinePartition()
  if (!current || offlinePartitionKey(current) !== offlinePartitionKey(partition)) {
    throw new Error("Offline work belongs to another Board or account. Return to its original context.")
  }
}

function settleCurrent(db: IDBDatabase, complete: () => void, reject: (reason?: unknown) => void) {
  try {
    const partition = partitionByDatabase.get(db)
    if (!partition) throw new Error("Offline work has no verified context.")
    assertOfflinePartition(partition)
    complete()
  } catch (error) { reject(error) }
}

async function getDb(selected?: OfflinePartition, storage: "offline" | "attachments" = "offline"): Promise<IDBDatabase | null> {
  if (!(storage === "attachments" ? shouldEnableAttachmentIDB() : shouldEnableIDB())) return null
  const partition = selected ?? currentOfflinePartition()
  if (!partition) throw new Error("Open an authenticated Board before using offline work.")
  assertOfflinePartition(partition)
  const name = `${DB_NAME}-v4:${offlinePartitionKey(partition)}`
  let database = databases.get(name)
  if (!database) {
    database = await openDatabase(name)
    assertOfflinePartition(partition)
    partitionByDatabase.set(database, partition)
    databases.set(name, database)
  }
  return database
}

/** Old global data is retained without attributing or replaying it as the current user. */
export async function hasUnattributedOfflineData(): Promise<boolean> {
  if (typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function") return false
  return (await indexedDB.databases()).some(
    database => database.name === DB_NAME || database.name === "meitheal-offline-outbox",
  )
}

// --- Task CRUD ---

export async function putTask(task: OfflineTask, partition?: OfflinePartition): Promise<void> {
  const db = await getDb(partition)
  if (!db) return
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate()
      const usageMB = (usage || 0) / (1024 * 1024)
      const quotaMB = (quota || 0) / (1024 * 1024)
      const usagePct = quota ? ((usage || 0) / quota) * 100 : 0

      if (usagePct > 90) {
        log.error(`Storage critically full (${usagePct.toFixed(1)}% of ${quotaMB.toFixed(0)}MB) — rejecting write`)
        throw new Error("IndexedDB storage quota exceeded (>90%)")
      }
      if (usageMB > 50) {
        log.warn(`Storage usage high (${usageMB.toFixed(2)} MB) — consider cleanup`)
      }
    } catch (e) {
      // Only re-throw quota errors, ignore estimate() failures
      if (e instanceof Error && e.message.includes("quota")) throw e
    }
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readwrite")
    const store = tx.objectStore(STORES.tasks)
    const request = store.put(task)
    tx.onabort = () => reject(new Error("The offline write was not committed."))
    tx.oncomplete = () => settleCurrent(db, () => resolve(), reject)
    request.onerror = () => reject(new Error(`putTask failed: ${request.error?.message}`))
    tx.onerror = () => reject(new Error(`putTask tx failed: ${tx.error?.message}`))
  })
}

export async function getTask(id: string): Promise<OfflineTask | undefined> {
  const db = await getDb()
  if (!db) return undefined
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readonly")
    const store = tx.objectStore(STORES.tasks)
    const request = store.get(id)
    request.onsuccess = () => settleCurrent(db, () => resolve(request.result as OfflineTask | undefined), reject)
    request.onerror = () => reject(new Error(`getTask failed: ${request.error?.message}`))
  })
}

export async function getAllTasks(partition?: OfflinePartition): Promise<OfflineTask[]> {
  const db = await getDb(partition)
  if (!db) return []
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readonly")
    const store = tx.objectStore(STORES.tasks)
    const request = store.getAll()
    request.onsuccess = () => settleCurrent(db, () => resolve(request.result as OfflineTask[]), reject)
    request.onerror = () => reject(new Error(`getAllTasks failed: ${request.error?.message}`))
  })
}

export async function deleteTask(id: string): Promise<void> {
  const db = await getDb()
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readwrite")
    const store = tx.objectStore(STORES.tasks)
    const request = store.delete(id)
    tx.onabort = () => reject(new Error("The offline write was not committed."))
    tx.oncomplete = () => settleCurrent(db, () => resolve(), reject)
    request.onerror = () => reject(new Error(`deleteTask failed: ${request.error?.message}`))
  })
}

// --- Sync Queue Operations ---

const MAX_QUEUE_DEPTH = 100

export async function enqueueSyncOp(
  op: Omit<PendingSyncOperation, "id" | "createdAt" | "retryCount" | "partition">,
  attempt?: { id: string; partition: OfflinePartition },
): Promise<string> {
  const db = await getDb(attempt?.partition)
  if (!db) return ""

  // Check queue depth warning
  const partition = partitionByDatabase.get(db)!
  const depth = await getSyncQueueDepth(partition)
  assertOfflinePartition(partition)
  if (depth >= MAX_QUEUE_DEPTH) {
    log.warn(`Sync queue at capacity (${depth}/${MAX_QUEUE_DEPTH})`)
  }

  const entry: PendingSyncOperation = {
    id: attempt?.id ?? crypto.randomUUID(),
    ...op,
    partition,
    createdAt: new Date().toISOString(),
    retryCount: 0,
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    const request = store.put(entry)
    if (op.operation === "update") {
      const older = store.index("table").openCursor(IDBKeyRange.only(op.table))
      older.onsuccess = () => {
        const cursor = older.result
        if (!cursor) return
        const prior = cursor.value as PendingSyncOperation
        if (prior.id !== entry.id && prior.entityId === op.entityId && prior.operation === "update") cursor.delete()
        cursor.continue()
      }
      older.onerror = () => reject(new Error("Could not combine this offline edit. It was not saved."))
    }
    tx.onabort = () => reject(new Error("The offline edit was not committed."))
    tx.oncomplete = () => settleCurrent(db, () => resolve(entry.id), reject)
    request.onerror = () => reject(new Error(`enqueueSyncOp failed: ${request.error?.message}`))
  })
}

export async function getSyncQueue(partition?: OfflinePartition): Promise<PendingSyncOperation[]> {
  const db = await getDb(partition)
  if (!db) return []
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readonly")
    const store = tx.objectStore(STORES.pendingSync)
    const index = store.index("createdAt")
    const request = index.getAll()
    request.onsuccess = () => settleCurrent(db, () => resolve(request.result as PendingSyncOperation[]), reject)
    request.onerror = () => reject(new Error(`getSyncQueue failed: ${request.error?.message}`))
  })
}

export async function removeSyncOp(id: string, partition?: OfflinePartition): Promise<void> {
  const db = await getDb(partition)
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    const request = store.delete(id)
    tx.onabort = () => reject(new Error("The offline write was not committed."))
    tx.oncomplete = () => settleCurrent(db, () => resolve(), reject)
    request.onerror = () => reject(new Error(`removeSyncOp failed: ${request.error?.message}`))
  })
}

export async function incrementRetryCount(id: string, partition?: OfflinePartition): Promise<void> {
  const db = await getDb(partition)
  if (!db) return
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    tx.onabort = () => reject(new Error("The offline write was not committed."))
    tx.oncomplete = () => settleCurrent(db, () => resolve(), reject)
    tx.onabort = () => reject(new Error("The retry state was not saved."))
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const entry = getReq.result as PendingSyncOperation | undefined
      if (entry) {
        entry.retryCount += 1
        const putReq = store.put(entry)
        putReq.onerror = () => reject(new Error(`incrementRetryCount put failed`))
      }
    }
    getReq.onerror = () => reject(new Error(`incrementRetryCount get failed`))
  })
}

export async function getSyncQueueDepth(partition?: OfflinePartition): Promise<number> {
  if (!partition && !currentOfflinePartition()) return 0
  const db = await getDb(partition)
  if (!db) return 0
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readonly")
    const store = tx.objectStore(STORES.pendingSync)
    const request = store.count()
    request.onsuccess = () => settleCurrent(db, () => resolve(request.result), reject)
    request.onerror = () => reject(new Error(`getSyncQueueDepth failed: ${request.error?.message}`))
  })
}

// --- TTL Cleanup (T-514: 7-day expiry) ---

/** Unconfirmed edits never expire into an implicit success or deletion. */
export async function cleanupExpiredSyncOps(partition?: OfflinePartition): Promise<number> {
  const selected = partition ?? currentOfflinePartition()
  if (selected) assertOfflinePartition(selected)
  return 0
}

// --- Metadata ---

export function getDbName(): string {
  const partition = currentOfflinePartition()
  return partition ? `${DB_NAME}-v4:${offlinePartitionKey(partition)}` : ""
}

export function getDbVersion(): number {
  return DB_VERSION
}

// --- Attachments (Phase 23) ---

export interface TaskAttachment {
  id: string; // crypto.randomUUID()
  taskId: string;
  filename: string;
  mimeType: string;
  base64Data: string;
  createdAt: string;
}

export async function saveAttachment(attachment: TaskAttachment): Promise<void> {
  const db = await getDb(undefined, "attachments")
  if (!db) throw new Error("Browser storage is unavailable for attachments.")
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.taskAttachments, "readwrite")
    const store = tx.objectStore(STORES.taskAttachments)
    const request = store.put(attachment)
    tx.onabort = () => reject(new Error("The offline write was not committed."))
    tx.oncomplete = () => settleCurrent(db, () => resolve(), reject)
    request.onerror = () => reject(new Error(`saveAttachment failed: ${request.error?.message}`))
    tx.onerror = () => reject(new Error(`saveAttachment tx failed: ${tx.error?.message}`))
  })
}

export async function getAttachmentsByTaskId(taskId: string, partition?: OfflinePartition): Promise<TaskAttachment[]> {
  const db = await getDb(partition, "attachments")
  if (!db) return []
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.taskAttachments, "readonly")
    const store = tx.objectStore(STORES.taskAttachments)
    const index = store.index("taskId")
    const request = index.getAll(IDBKeyRange.only(taskId))
    request.onsuccess = () => settleCurrent(db, () => resolve((request.result || []) as TaskAttachment[]), reject)
    request.onerror = () => reject(new Error(`getAttachmentsByTaskId failed: ${request.error?.message}`))
  })
}

export async function deleteAttachment(id: string): Promise<void> {
  const db = await getDb(undefined, "attachments")
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.taskAttachments, "readwrite")
    const store = tx.objectStore(STORES.taskAttachments)
    const request = store.delete(id)
    tx.onabort = () => reject(new Error("The offline write was not committed."))
    tx.oncomplete = () => settleCurrent(db, () => resolve(), reject)
    request.onerror = () => reject(new Error(`deleteAttachment failed: ${request.error?.message}`))
  })
}

/** Clear only the current verified cache; unconfirmed edits and their context stay intact. */
export async function clearCurrentOfflineCache(): Promise<void> {
  const partition = currentOfflinePartition()
  if (!partition) throw new Error("Open an authenticated Board before clearing its cache.")
  const db = await getDb(partition)
  if (!db) return
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORES.tasks, STORES.pendingSync], "readwrite")
    const count = tx.objectStore(STORES.pendingSync).count()
    let pending = false
    count.onsuccess = () => {
      try { assertOfflinePartition(partition) } catch (error) { tx.abort(); reject(error); return }
      if (count.result) { pending = true; tx.abort(); return }
      tx.objectStore(STORES.tasks).clear()
    }
    tx.oncomplete = () => settleCurrent(db, resolve, reject)
    tx.onabort = () => reject(new Error(pending ? "Unconfirmed offline edits are kept. Reconnect to resolve them before clearing this Board’s cache." : "The cache was not cleared."))
    tx.onerror = () => reject(new Error("The cache was not cleared."))
  })
}
