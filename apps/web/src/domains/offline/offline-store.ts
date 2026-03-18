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
  boardId: string | null
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

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      // Tasks store — mirrors server schema
      if (!db.objectStoreNames.contains(STORES.tasks)) {
        const taskStore = db.createObjectStore(STORES.tasks, { keyPath: "id" })
        taskStore.createIndex("status", "status", { unique: false })
        taskStore.createIndex("updatedAt", "updatedAt", { unique: false })
        taskStore.createIndex("priority", "priority", { unique: false })
        taskStore.createIndex("boardId", "boardId", { unique: false })
      } else {
        // V3 migration: add indexes to existing store
        const tx = (event.target as IDBOpenDBRequest).transaction!
        const taskStore = tx.objectStore(STORES.tasks)
        if (!taskStore.indexNames.contains("priority")) {
          taskStore.createIndex("priority", "priority", { unique: false })
        }
        if (!taskStore.indexNames.contains("boardId")) {
          taskStore.createIndex("boardId", "boardId", { unique: false })
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

let dbInstance: IDBDatabase | null = null

async function getDb(): Promise<IDBDatabase> {
  if (dbInstance) return dbInstance
  dbInstance = await openDatabase()
  return dbInstance
}

// --- Task CRUD ---

export async function putTask(task: OfflineTask): Promise<void> {
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
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readwrite")
    const store = tx.objectStore(STORES.tasks)
    const request = store.put(task)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(new Error(`putTask failed: ${request.error?.message}`))
    tx.onerror = () => reject(new Error(`putTask tx failed: ${tx.error?.message}`))
  })
}

export async function getTask(id: string): Promise<OfflineTask | undefined> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readonly")
    const store = tx.objectStore(STORES.tasks)
    const request = store.get(id)
    request.onsuccess = () => resolve(request.result as OfflineTask | undefined)
    request.onerror = () => reject(new Error(`getTask failed: ${request.error?.message}`))
  })
}

export async function getAllTasks(): Promise<OfflineTask[]> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readonly")
    const store = tx.objectStore(STORES.tasks)
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result as OfflineTask[])
    request.onerror = () => reject(new Error(`getAllTasks failed: ${request.error?.message}`))
  })
}

export async function deleteTask(id: string): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.tasks, "readwrite")
    const store = tx.objectStore(STORES.tasks)
    const request = store.delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(new Error(`deleteTask failed: ${request.error?.message}`))
  })
}

// --- Sync Queue Operations ---

const MAX_QUEUE_DEPTH = 100

export async function enqueueSyncOp(op: Omit<PendingSyncOperation, "id" | "createdAt" | "retryCount">): Promise<string> {
  const db = await getDb()

  // Check queue depth warning
  const depth = await getSyncQueueDepth()
  if (depth >= MAX_QUEUE_DEPTH) {
    log.warn(`Sync queue at capacity (${depth}/${MAX_QUEUE_DEPTH})`)
  }

  // Deduplication: collapse updates to same entity
  if (op.operation === "update") {
    await deduplicateUpdate(op.entityId, op.table)
  }

  const entry: PendingSyncOperation = {
    id: crypto.randomUUID(),
    ...op,
    createdAt: new Date().toISOString(),
    retryCount: 0,
  }

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    const request = store.put(entry)
    request.onsuccess = () => resolve(entry.id)
    request.onerror = () => reject(new Error(`enqueueSyncOp failed: ${request.error?.message}`))
  })
}

async function deduplicateUpdate(entityId: string, table: string): Promise<void> {
  const db = await getDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    const index = store.index("table")
    const request = index.openCursor(IDBKeyRange.only(table))

    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        const entry = cursor.value as PendingSyncOperation
        if (entry.entityId === entityId && entry.operation === "update") {
          cursor.delete()
        }
        cursor.continue()
      } else {
        resolve()
      }
    }
    request.onerror = () => reject(new Error(`deduplicateUpdate failed: ${request.error?.message}`))
  })
}

export async function getSyncQueue(): Promise<PendingSyncOperation[]> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readonly")
    const store = tx.objectStore(STORES.pendingSync)
    const index = store.index("createdAt")
    const request = index.getAll()
    request.onsuccess = () => resolve(request.result as PendingSyncOperation[])
    request.onerror = () => reject(new Error(`getSyncQueue failed: ${request.error?.message}`))
  })
}

export async function removeSyncOp(id: string): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    const request = store.delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(new Error(`removeSyncOp failed: ${request.error?.message}`))
  })
}

export async function incrementRetryCount(id: string): Promise<void> {
  const db = await getDb()
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    const getReq = store.get(id)
    getReq.onsuccess = () => {
      const entry = getReq.result as PendingSyncOperation | undefined
      if (entry) {
        entry.retryCount += 1
        const putReq = store.put(entry)
        putReq.onsuccess = () => resolve()
        putReq.onerror = () => reject(new Error(`incrementRetryCount put failed`))
      } else {
        resolve()
      }
    }
    getReq.onerror = () => reject(new Error(`incrementRetryCount get failed`))
  })
}

export async function getSyncQueueDepth(): Promise<number> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readonly")
    const store = tx.objectStore(STORES.pendingSync)
    const request = store.count()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error(`getSyncQueueDepth failed: ${request.error?.message}`))
  })
}

// --- TTL Cleanup (T-514: 7-day expiry) ---

const SYNC_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export async function cleanupExpiredSyncOps(): Promise<number> {
  const db = await getDb()
  const cutoff = new Date(Date.now() - SYNC_TTL_MS).toISOString()
  let removed = 0

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.pendingSync, "readwrite")
    const store = tx.objectStore(STORES.pendingSync)
    const index = store.index("createdAt")
    const range = IDBKeyRange.upperBound(cutoff)
    const request = index.openCursor(range)

    request.onsuccess = () => {
      const cursor = request.result
      if (cursor) {
        cursor.delete()
        removed++
        cursor.continue()
      } else {
        resolve(removed)
      }
    }
    request.onerror = () => reject(new Error(`cleanupExpiredSyncOps failed: ${request.error?.message}`))
  })
}

// --- Metadata ---

export function getDbName(): string {
  return DB_NAME
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
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.taskAttachments, "readwrite")
    const store = tx.objectStore(STORES.taskAttachments)
    const request = store.put(attachment)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(new Error(`saveAttachment failed: ${request.error?.message}`))
    tx.onerror = () => reject(new Error(`saveAttachment tx failed: ${tx.error?.message}`))
  })
}

export async function getAttachmentsByTaskId(taskId: string): Promise<TaskAttachment[]> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.taskAttachments, "readonly")
    const store = tx.objectStore(STORES.taskAttachments)
    const index = store.index("taskId")
    const request = index.getAll(IDBKeyRange.only(taskId))
    request.onsuccess = () => resolve((request.result || []) as TaskAttachment[])
    request.onerror = () => reject(new Error(`getAttachmentsByTaskId failed: ${request.error?.message}`))
  })
}

export async function deleteAttachment(id: string): Promise<void> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORES.taskAttachments, "readwrite")
    const store = tx.objectStore(STORES.taskAttachments)
    const request = store.delete(id)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(new Error(`deleteAttachment failed: ${request.error?.message}`))
  })
}
