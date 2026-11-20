import { currentBoardGrantRevision } from "../../domains/tasks/persistence/board-grant-fence"
import { resolveBoardRequestScope } from "../../lib/board-request-context"
import { boardScopeErrorResponse, boardScopeResponse } from "../../lib/board-http"
import { bindingAllows, readWorkDestinations } from "../../domains/tasks/integration-destinations"
import { validateIntegrationDestinationPlacement } from "../../domains/tasks/board-automation"
import { validateBoardScope } from "../../domains/tasks/board-scope"
import { validateBoardFeature } from "../../domains/tasks/board-access-service"
import { projectPublicTaskFields } from "../../domains/tasks/task-projection"
import { getPersistenceClient } from "../../domains/tasks/persistence/store"
/**
 * Server-sent events for Meitheal events and Home Assistant entity changes.
 * EventSource uses the same Home Assistant ingress session as the rest of the app.
 *
 * @domain ha
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { getIngressTransport, runWithIngressTransport } from "../../../scripts/ingress-transport.mjs"
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
const clientAuthorities = new Map<(frame: Uint8Array) => void, (event: string, data: unknown) => Promise<boolean>>()
const entitySubscriptions = new Map<string, () => void>()
let heartbeat: ReturnType<typeof setInterval> | undefined
const MAX_PENDING_FRAMES = 256
const AUTHORITY_TIMEOUT_MS = 1_000
interface PendingFrame { event: string; data: unknown; frame: Uint8Array | null; finish: () => void; generation: number }
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
      currentBoardGrantRevision(getPersistenceClient()).then(revision => revision ? "current" as const : "locked" as const),
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
        await broadcast(entry.frame, entry.event, entry.data)
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

async function broadcast(frame: Uint8Array, event = "heartbeat", data?: unknown): Promise<void> {
  await Promise.allSettled([...clients].map(async send => {
    const authorize = clientAuthorities.get(send)
    if (!authorize) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const allowed = await Promise.race([
        authorize(event, data),
        new Promise<false>(resolve => {
          timer = setTimeout(() => { overloadDisconnects.get(send)?.(); resolve(false) }, AUTHORITY_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      if (allowed && clients.has(send)) send(frame)
    } finally { clearTimeout(timer) }
  }))
}

export function emitSSE(event: string, data: unknown): Promise<void> {
  if (clients.size === 0) return Promise.resolve()
  if (event !== "ha:entity_changed") {
    if (!data || typeof data !== "object" || Array.isArray(data)) return Promise.resolve()
    const input = data as Record<string, unknown>
    data = { ...projectPublicTaskFields(input), ...(typeof input.task_id === "string" ? { task_id: input.task_id } : {}) }
  }
  // Bound both encoded payload retention and the FIFO itself while authority is
  // checked. Overflow closes streams so EventSource reconnects and resynchronizes.
  const frame = encodeEvent(event, data)
  const count = pendingFrames.length + (activeFrame?.frame ? 1 : 0)
  if (frame.byteLength + pendingBytes > BUFFER_BYTES || count >= MAX_PENDING_FRAMES) {
    disconnectOverloadedClients()
    return Promise.resolve()
  }
  const completion = new Promise<void>(finish => {
    pendingFrames.push({ event, data, frame, finish, generation: deliveryGeneration })
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
        last_updated: entity.last_updated,
      })
    }))
  }
}

async function openAuthority(context: Parameters<APIRoute>[0]) {
  try {
    const selected = await resolveBoardRequestScope(context, { operation: { resource: "task", action: "read" }, write: false })
    return selected.ok ? selected.scope : boardScopeResponse(selected.errorCode)
  } catch (error) {
    const failure = boardScopeErrorResponse(error)
    if (failure) return failure
    throw error
  }
}

export const HEAD: APIRoute = async context => {
  const authority = await openAuthority(context)
  return authority instanceof Response ? authority : new Response(null, { headers: SSE_HEADERS })
}

export const GET: APIRoute = async context => {
  const { request } = context
  const transport = getIngressTransport()
  const socket = transport?.sseSocket
  // Encoded aliases that Astro resolves to this route lack the wrapper's socket guard.
  if (transport && !socket) return new Response(null, { status: 404 })

  const authority = await openAuthority(context)
  if (authority instanceof Response) return authority
  const boardId = authority.boardId
  // Background emitters may be running outside the subscriber's request.
  const opener = {
    peer: transport?.peer ?? "",
    fromSupervisor: Boolean(transport?.fromSupervisor),
    identityHeadersSafe: Boolean(transport?.identityHeadersSafe),
    configuredPath: transport?.configuredPath,
  }

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
        clientAuthorities.delete(send)
        recordSseClientDisconnected()
        if (clients.size > 0) return
        clearPendingFrames()
        clearInterval(heartbeat)
        heartbeat = undefined
        for (const unsubscribe of entitySubscriptions.values()) unsubscribe()
        entitySubscriptions.clear()
      }

      clients.add(send)
      clientAuthorities.set(send, (event, data) => runWithIngressTransport(opener, async () => {
        // Reverify identity with a fresh request proof; the original stream may
        // outlive the short-lived roster/token proof held by its opening GET.
        const currentContext = { request: new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) }), locals: context.locals }
        const current = await resolveBoardRequestScope(currentContext, {
          operation: { resource: "task", action: "read" }, boardId, write: false,
        })
        if (!current.ok) { disconnect(); return false }
        if (event === "heartbeat") return true
        if (!data || typeof data !== "object" || Array.isArray(data)) return false
        const payload = data as Record<string, unknown>
        if (event === "ha:entity_changed") {
          const db = getPersistenceClient()
          const operation = { resource: "task", action: "read" } as const
          if (!await validateBoardFeature(current.scope, db, "home_assistant_area")) return false
          const destinations = await readWorkDestinations(db)
          for (const binding of destinations?.bindings ?? []) {
            if (binding.destination.boardId === boardId && binding.sourceId === payload.entity_id &&
                bindingAllows(binding, operation) && await validateIntegrationDestinationPlacement(db, current.scope, binding)) {
              return (await validateBoardScope(current.scope, db, operation)).ok
            }
          }
          return false
        }
        // Generic task events require actual record ownership; an arbitrary
        // payload Board field cannot authorize publication to a subscription.
        const id = payload.task_id ?? payload.id
        if (typeof id !== "string") return false
        const task = await resolveBoardRequestScope(currentContext, {
          operation: { resource: "task", action: "read" }, boardId,
          record: { resource: "task", id }, write: false,
        })
        return task.ok
      }))
      overloadDisconnects.set(send, () => {
        recordSseBackpressureDrop()
        disconnect()
        socket?.destroy()
      })
      recordSseClientConnected()
      request.signal.addEventListener("abort", disconnect, { signal: lifetime.signal, once: true })
      send(encodeEvent("connected", { ts: new Date().toISOString() }))

      refreshEntitySubscriptions()
      heartbeat ??= setInterval(async () => {
        if (!await currentBoardGrantRevision(getPersistenceClient())) return
        refreshEntitySubscriptions()
        await broadcast(encoder.encode(`: heartbeat ${Date.now()}\n\n`))
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
