import { createRequire } from "node:module"

const { WebSocketServer } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("ws")
type Socket = { send(value: string): void; on(name: string, callback: (raw: Buffer) => void): void; terminate(): void; pause(): void; resume(): void }

/** Actual loopback HA protocol, with optional held authentication and mutable calendar data. */
export async function startHAWebSocketFixture(options: {
  holdTokens?: string[]
  entities?: Record<string, Record<string, unknown>>
  holdPings?: string[]
  pauseAfterPing?: string[]
} = {}) {
  const tokens: string[] = []
  const firedEvents: Array<{ event_type: string; event_data: Record<string, unknown> }> = []
  const held = new Map<string, () => void>()
  const heldPongs = new Map<string, Array<() => void>>()
  const sockets = new Map<string, Socket>()
  const pings: Array<{ token: string; id: number }> = []
  let events: unknown[] = []
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise<void>(resolve => server.once("listening", resolve))
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
        const result = message.type === "get_states" ? []
          : message.type === "call_service" && message.domain === "calendar" && message.service === "get_events"
            ? { response: { [message.target.entity_id]: { events } } }
            : null
        send({ id: message.id, type: "result", success: true, result })
        if (message.type === "subscribe_entities") {
          send({ id: message.id, type: "event", event: { a: options.entities?.[token] ?? {} } })
        }
      }
    })
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    tokens,
    firedEvents,
    pings,
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
      await new Promise<void>(resolve => server.close(resolve))
    },
  }
}
