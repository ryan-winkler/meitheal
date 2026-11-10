import { createRequire } from "node:module"

const { WebSocketServer } = createRequire(new URL("../../apps/web/package.json", import.meta.url))("ws")
type Socket = { send(value: string): void; on(name: string, callback: (raw: Buffer) => void): void; terminate(): void }

/** Actual loopback HA protocol, with optional held authentication and mutable calendar data. */
export async function startHAWebSocketFixture(options: {
  holdTokens?: string[]
  entities?: Record<string, Record<string, unknown>>
} = {}) {
  const tokens: string[] = []
  const held = new Map<string, () => void>()
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
        tokens.push(token)
        const accepted = () => send(token.startsWith("invalid-")
          ? { type: "auth_invalid", message: "Fixture credential rejected" }
          : { type: "auth_ok", ha_version: "2026.11.1" })
        if (options.holdTokens?.includes(token)) held.set(token, accepted)
        else accepted()
      } else if (message.type === "ping") send({ id: message.id, type: "pong" })
      else {
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
