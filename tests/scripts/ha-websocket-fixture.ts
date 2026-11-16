import { createServer } from "node:http"
import { createRequire } from "node:module"

const { WebSocketServer } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("ws")
type Socket = { send(value: string): void; on(name: string, callback: (raw: Buffer) => void): void; terminate(): void; pause(): void; resume(): void }

export interface FixtureRegistryEntry {
  entity_id: string
  disabled_by: string | null
}

export interface FixtureStateEntry {
  entity_id: string
  state: string
  attributes: Record<string, unknown>
  last_changed: string
  last_updated: string
}

/** Actual loopback HA protocol (WebSocket + `/api/states/<id>` REST), with optional held auth and mutable registry/states. */
export async function startHAWebSocketFixture(options: {
  holdTokens?: string[]
  entities?: Record<string, Record<string, unknown>>
  holdPings?: string[]
  pauseAfterPing?: string[]
  entityRegistry?: FixtureRegistryEntry[] | null
  states?: FixtureStateEntry[]
  restStates?: Record<string, FixtureStateEntry>
  filterSubscribeEntities?: boolean
} = {}) {
  const tokens: string[] = []
  const firedEvents: Array<{ event_type: string; event_data: Record<string, unknown> }> = []
  const subscribeEntitiesCalls: Array<{ token: string; id: number; entity_ids?: string[] | undefined }> = []
  const eventTypesSubscribed: string[] = []
  let getStatesCount = 0
  let restStateRequests: string[] = []
  const held = new Map<string, () => void>()
  const heldPongs = new Map<string, Array<() => void>>()
  const sockets = new Map<string, Socket>()
  const eventSubIds = new Map<string, Map<string, number>>()
  const entitySubIds = new Map<string, number>()
  const pings: Array<{ token: string; id: number }> = []
  let events: unknown[] = []
  let registryEntries: FixtureRegistryEntry[] | null = options.entityRegistry ?? null
  let customStates: FixtureStateEntry[] | undefined = options.states
  const restStateMap: Record<string, FixtureStateEntry> = { ...(options.restStates ?? {}) }

  const httpServer = createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/"
    const prefix = "/api/states/"
    if (req.method === "GET" && urlPath.startsWith(prefix)) {
      const entityId = decodeURIComponent(urlPath.slice(prefix.length))
      restStateRequests.push(entityId)
      const fromRest = restStateMap[entityId]
      const fromStates = customStates?.find(s => s.entity_id === entityId)
      const hit = fromRest ?? fromStates
      if (!hit) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Entity not found." }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(hit))
      return
    }
    res.writeHead(404).end()
  })

  const server = new WebSocketServer({ server: httpServer })
  await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", () => resolve()))

  server.on("connection", (socket: Socket) => {
    let token = ""
    const send = (value: unknown) => socket.send(JSON.stringify(value))
    send({ type: "auth_required", ha_version: "2026.11.1" })
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString())
      if (message.type === "auth") {
        token = message.access_token
        sockets.set(token, socket)
        tokens.push(token)
        const accepted = () => send(token.startsWith("invalid-")
          ? { type: "auth_invalid", message: "Fixture credential rejected" }
          : { type: "auth_ok", ha_version: "2026.11.1" })
        if (options.holdTokens?.includes(token)) held.set(token, accepted)
        else accepted()
      } else if (message.type === "ping") {
        pings.push({ token, id: message.id })
        const pong = () => send({ id: message.id, type: "pong" })
        if (options.holdPings?.includes(token)) {
          const pending = heldPongs.get(token) ?? []
          pending.push(pong)
          heldPongs.set(token, pending)
        } else pong()
        // Stop reading the actual TCP socket so a later close frame remains
        // unanswered. The real ws client's normal closing timeout stays active.
        if (options.pauseAfterPing?.includes(token)) socket.pause()
      } else {
        if (message.type === "fire_event") firedEvents.push({ event_type: message.event_type, event_data: message.event_data })
        if (message.type === "subscribe_events" && typeof message.event_type === "string") {
          eventTypesSubscribed.push(message.event_type)
          let map = eventSubIds.get(token)
          if (!map) {
            map = new Map()
            eventSubIds.set(token, map)
          }
          map.set(message.event_type, message.id)
        }
        if (message.type === "subscribe_entities") {
          subscribeEntitiesCalls.push({
            token,
            id: message.id,
            entity_ids: Array.isArray(message.entity_ids) ? [...message.entity_ids] : undefined,
          })
          entitySubIds.set(token, message.id)
        }
        if (message.type === "get_states") getStatesCount++

        const result = message.type === "get_states"
          ? (customStates ?? [])
          : message.type === "config/entity_registry/list"
            ? registryEntries
            : message.type === "config/entity_registry/get"
              ? (registryEntries?.find(e => e.entity_id === message.entity_id) ?? null)
              : message.type === "call_service" && message.domain === "calendar" && message.service === "get_events"
                ? { response: { [message.target.entity_id]: { events } } }
                : null

        send({ id: message.id, type: "result", success: true, result })
        if (message.type === "subscribe_entities") {
          const allInitial: Record<string, unknown> = {}
          if (customStates) {
            for (const st of customStates) {
              allInitial[st.entity_id] = {
                s: st.state,
                a: st.attributes,
                lc: Math.floor(Date.parse(st.last_changed) / 1000),
                lu: Math.floor(Date.parse(st.last_updated) / 1000),
              }
            }
          } else if (options.entities?.[token]) {
            Object.assign(allInitial, options.entities[token])
          }
          let aPayload = allInitial
          if (options.filterSubscribeEntities && Array.isArray(message.entity_ids)) {
            const allowed = new Set<string>(message.entity_ids)
            aPayload = Object.fromEntries(Object.entries(allInitial).filter(([k]) => allowed.has(k)))
          }
          send({ id: message.id, type: "event", event: { a: aPayload } })
        }
      }
    })
  })

  const addr = httpServer.address()
  if (!addr || typeof addr === "string") throw new Error("Expected TCP address")

  return {
    url: `http://127.0.0.1:${addr.port}`,
    tokens,
    firedEvents,
    pings,
    subscribeEntitiesCalls,
    eventTypesSubscribed,
    get getStatesCount() { return getStatesCount },
    get restStateRequests() { return [...restStateRequests] },
    setRestState(entityId: string, entry: FixtureStateEntry) {
      restStateMap[entityId] = entry
    },
    setEntityRegistry(entries: FixtureRegistryEntry[] | null) {
      registryEntries = entries
    },
    setStates(entries: FixtureStateEntry[] | undefined) {
      customStates = entries
    },
    emitEvent(token: string, eventType: string, data: Record<string, unknown>) {
      const socket = sockets.get(token)
      const subId = eventSubIds.get(token)?.get(eventType)
      if (!socket || subId === undefined) return false
      socket.send(JSON.stringify({ id: subId, type: "event", event: { event_type: eventType, data } }))
      return true
    },
    emitEntities(token: string, payload: Record<string, unknown>) {
      const socket = sockets.get(token)
      const subId = entitySubIds.get(token)
      if (!socket || subId === undefined) return false
      socket.send(JSON.stringify({ id: subId, type: "event", event: payload }))
      return true
    },
    disconnectClient(token: string) {
      const socket = sockets.get(token)
      if (socket) socket.terminate()
    },
    releasePong(token: string) {
      const pong = heldPongs.get(token)?.shift()
      if (!pong) throw new Error("No held fixture pong")
      pong()
    },
    resume(token: string) {
      const socket = sockets.get(token)
      if (!socket) throw new Error("No fixture socket for token")
      socket.resume()
    },
    release(token: string) {
      const release = held.get(token)
      if (!release) throw new Error("No held fixture authentication")
      held.delete(token)
      release()
    },
    setCalendarEvents(value: unknown[]) { events = value },
    async close() {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
      httpServer.closeAllConnections?.()
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    },
  }
}
