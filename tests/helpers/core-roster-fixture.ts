import { createRequire } from "node:module"
import { closeHAConnection } from "../../apps/web/src/domains/ha/ha-connection"
const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocket, WebSocketServer } = require("ws") as typeof import("../../apps/web/node_modules/@types/ws")

/** Actual bounded Core roster transport for synthetic assignment targets. */
export async function startCoreRosterFixture(ids: string[]) {
  const previousSocket = globalThis.WebSocket, previousToken = process.env.SUPERVISOR_TOKEN
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await new Promise<void>(resolve => server.once("listening", resolve))
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.1" }))
    socket.on("message", bytes => {
      const command = JSON.parse(bytes.toString())
      if (command.type === "auth") socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.1" }))
      else if (command.type === "config/auth/list") socket.send(JSON.stringify({ type: "result", id: command.id, success: true,
        result: ids.map(id => ({ id, name: id, is_active: true, system_generated: false, is_owner: id === "owner", group_ids: [] })) }))
      else if (command.type === "ping") socket.send(JSON.stringify({ type: "pong", id: command.id }))
      else socket.send(JSON.stringify({ type: "result", id: command.id, success: false,
        error: { code: "unknown_command", message: "Unsupported roster fixture command" } }))
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected Core fixture socket")
  const corePort = address.port
  globalThis.WebSocket = class extends WebSocket {
    constructor(url: string | URL, options?: import("../../apps/web/node_modules/@types/ws").ClientOptions) {
      if (String(url) !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected Core roster endpoint")
      super(`ws://127.0.0.1:${corePort}`, options)
    }
  } as unknown as typeof globalThis.WebSocket
  process.env.SUPERVISOR_TOKEN = "synthetic-core-roster"
  return async () => {
    globalThis.WebSocket = previousSocket
    if (previousToken === undefined) delete process.env.SUPERVISOR_TOKEN; else process.env.SUPERVISOR_TOKEN = previousToken
    closeHAConnection()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
