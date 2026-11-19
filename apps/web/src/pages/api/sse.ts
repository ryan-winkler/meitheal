import { readHouseholdBoardState } from "../../domains/tasks/persistence/named-board-repository"
import { getPersistenceClient } from "../../domains/tasks/persistence/store"
/**
 * Server-sent events for Meitheal events and Home Assistant entity changes.
 * EventSource uses the same Home Assistant ingress session as the rest of the app.
 *
 * @domain ha
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { getIngressTransport } from "../../../scripts/ingress-transport.mjs"
import {
  recordSseBackpressureDrop,
  recordSseClientConnected,
  recordSseClientDisconnected,
} from "../../../scripts/runtime-counters.mjs"
import { getCalendarEntities, getTodoEntities, onEntityChange } from "../../domains/ha"

const BUFFER_BYTES = 64 * 1024
const HEARTBEAT_MS = 30_000
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "connection": "keep-alive",
  "x-accel-buffering": "no",
}
const encoder = new TextEncoder()
const clients = new Set<(frame: Uint8Array) => void>()
const entitySubscriptions = new Map<string, () => void>()
let heartbeat: ReturnType<typeof setInterval> | undefined
const MAX_PENDING_FRAMES = 256
const AUTHORITY_TIMEOUT_MS = 1_000
interface PendingFrame { frame: Uint8Array | null; finish: () => void; generation: number }
const pendingFrames: PendingFrame[] = []
const overloadDisconnects = new Map<(frame: Uint8Array) => void, () => void>()
let activeFrame: PendingFrame | undefined
let pendingBytes = 0
let deliveryGeneration = 0
let draining = false

function releaseFrame(entry: PendingFrame) {
  if (entry.frame) pendingBytes -= entry.frame.byteLength
  entry.frame = null
  entry.finish()
}

function clearPendingFrames() {
  deliveryGeneration++
  for (const entry of pendingFrames.splice(0)) releaseFrame(entry)
  if (activeFrame) releaseFrame(activeFrame)
}

function disconnectOverloadedClients() {
  for (const disconnect of [...overloadDisconnects.values()]) disconnect()
  clearPendingFrames()
}

async function deliveryAuthorityAvailable(): Promise<"current" | "locked" | "failed"> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      readHouseholdBoardState(getPersistenceClient()).then(state => state === "locked" ? "locked" as const : "current" as const),
      new Promise<"failed">(resolve => { timer = setTimeout(() => resolve("failed"), AUTHORITY_TIMEOUT_MS); timer.unref?.() }),
    ])
  } catch {
    return "failed"
  } finally {
    clearTimeout(timer)
  }
}

async function drainFrames() {
  if (draining) return
  draining = true
  try {
    while (pendingFrames.length) {
      const entry = pendingFrames.shift()!
      activeFrame = entry
      try {
        const allowed = await deliveryAuthorityAvailable()
        if (entry.generation !== deliveryGeneration || !entry.frame) continue
        if (allowed === "failed") { disconnectOverloadedClients(); continue }
        if (allowed === "locked") { clearPendingFrames(); continue }
        broadcast(entry.frame)
      } finally {
        releaseFrame(entry)
        activeFrame = undefined
      }
    }
  } finally {
    draining = false
  }
}

function encodeEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(frame: Uint8Array): void {
  for (const send of clients) send(frame)
}

export function emitSSE(event: string, data: unknown): Promise<void> {
  if (clients.size === 0) return Promise.resolve()
  // Bound both encoded payload retention and the FIFO itself while authority is
  // checked. Overflow closes streams so EventSource reconnects and resynchronizes.
  const frame = encodeEvent(event, data)
  const count = pendingFrames.length + (activeFrame?.frame ? 1 : 0)
  if (frame.byteLength + pendingBytes > BUFFER_BYTES || count >= MAX_PENDING_FRAMES) {
    disconnectOverloadedClients()
    return Promise.resolve()
  }
  const completion = new Promise<void>(finish => {
    pendingFrames.push({ frame, finish, generation: deliveryGeneration })
    pendingBytes += frame.byteLength
  })
  void drainFrames().catch(() => { disconnectOverloadedClients() })
  return completion
}

function refreshEntitySubscriptions(): void {
  const entityIds = new Set(
    [...getCalendarEntities(), ...getTodoEntities()].map(entity => entity.entity_id),
  )
  for (const [id, unsubscribe] of entitySubscriptions) {
    if (entityIds.has(id)) continue
    unsubscribe()
    entitySubscriptions.delete(id)
  }
  for (const id of entityIds) {
    if (entitySubscriptions.has(id)) continue
    entitySubscriptions.set(id, onEntityChange(id, entity => {
      emitSSE("ha:entity_changed", {
        entity_id: entity.entity_id,
        state: entity.state,
        attributes: entity.attributes,
        last_updated: entity.last_updated,
      })
    }))
  }
}

function continuityLockedResponse() {
  return new Response(JSON.stringify({ error: "Installation continuity is locked." }), {
    status: 503, headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  })
}

export const HEAD: APIRoute = async () => await readHouseholdBoardState(getPersistenceClient()) === "locked"
  ? continuityLockedResponse() : new Response(null, { headers: SSE_HEADERS })

export const GET: APIRoute = async ({ request }) => {
  const transport = getIngressTransport()
  const socket = transport?.sseSocket
  // Encoded aliases that Astro resolves to this route lack the wrapper's socket guard.
  if (transport && !socket) return new Response(null, { status: 404 })

  if (await readHouseholdBoardState(getPersistenceClient()) === "locked") return continuityLockedResponse()

  const lifetime = new AbortController()
  let cleanup = () => {}

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (request.signal.aborted) {
        controller.close()
        return
      }

      const disconnect = () => {
        cleanup()
        controller.close()
      }
      const send = (frame: Uint8Array) => {
        // Bound queued bytes and let EventSource reconnect when the client falls behind.
        if (frame.byteLength + (socket?.writableLength ?? 0) > (controller.desiredSize ?? 0)) {
          recordSseBackpressureDrop()
          disconnect()
          socket?.destroy()
          return
        }
        controller.enqueue(frame)
      }

      cleanup = () => {
        lifetime.abort()
        if (!clients.delete(send)) return
        overloadDisconnects.delete(send)
        recordSseClientDisconnected()
        if (clients.size > 0) return
        clearPendingFrames()
        clearInterval(heartbeat)
        heartbeat = undefined
        for (const unsubscribe of entitySubscriptions.values()) unsubscribe()
        entitySubscriptions.clear()
      }

      clients.add(send)
      overloadDisconnects.set(send, () => {
        recordSseBackpressureDrop()
        disconnect()
        socket?.destroy()
      })
      recordSseClientConnected()
      request.signal.addEventListener("abort", disconnect, { signal: lifetime.signal, once: true })
      send(encodeEvent("connected", { ts: new Date().toISOString(), clients: clients.size }))

      refreshEntitySubscriptions()
      heartbeat ??= setInterval(async () => {
        if (await readHouseholdBoardState(getPersistenceClient()) === "locked") return
        refreshEntitySubscriptions()
        broadcast(encoder.encode(`: heartbeat ${Date.now()}\n\n`))
      }, HEARTBEAT_MS)
      heartbeat.unref()
    },
    cancel() {
      cleanup()
    },
  }, {
    highWaterMark: BUFFER_BYTES,
    size: frame => frame.byteLength,
  })

  return new Response(stream, { headers: SSE_HEADERS })
}
