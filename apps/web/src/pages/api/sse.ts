/**
 * Server-sent events for Meitheal events and Home Assistant entity changes.
 * EventSource uses the same Home Assistant ingress session as the rest of the app.
 *
 * @domain ha
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { getIngressTransport } from "../../../scripts/ingress-transport.mjs"
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

function encodeEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function broadcast(frame: Uint8Array): void {
  for (const send of clients) send(frame)
}

export function emitSSE(event: string, data: unknown): void {
  if (clients.size > 0) broadcast(encodeEvent(event, data))
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

export const HEAD: APIRoute = () => new Response(null, { headers: SSE_HEADERS })

export const GET: APIRoute = ({ request }) => {
  const transport = getIngressTransport()
  const socket = transport?.sseSocket
  // Encoded aliases that Astro resolves to this route lack the wrapper's socket guard.
  if (transport && !socket) return new Response(null, { status: 404 })

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
          disconnect()
          socket?.destroy()
          return
        }
        controller.enqueue(frame)
      }

      cleanup = () => {
        lifetime.abort()
        if (!clients.delete(send) || clients.size > 0) return
        clearInterval(heartbeat)
        heartbeat = undefined
        for (const unsubscribe of entitySubscriptions.values()) unsubscribe()
        entitySubscriptions.clear()
      }

      clients.add(send)
      request.signal.addEventListener("abort", disconnect, { signal: lifetime.signal, once: true })
      send(encodeEvent("connected", { ts: new Date().toISOString(), clients: clients.size }))

      refreshEntitySubscriptions()
      heartbeat ??= setInterval(() => {
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
