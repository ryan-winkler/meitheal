// Owned loopback App process for Core's native coordinator/device-trigger tests.
// Only transport and Core protocol are fixtures; the built middleware and task
// handlers, SQLite writes, dispatcher and fireHAEvent are production code.
import http from "node:http"
import { createRequire } from "node:module"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"

const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
const { WebSocket } = require("ws")
class CoreFixtureSocket extends WebSocket {
  constructor(address, ...options) {
    if (address !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected Core target")
    super(process.env.MEITHEAL_EVENT_CORE_WS, ...options)
  }
}
Object.defineProperty(globalThis, "WebSocket", {
  configurable: true, get: () => CoreFixtureSocket, set: () => {},
})
process.env.ASTRO_NODE_AUTOSTART = "disabled"
const { handler } = await import("../../apps/web/dist/server/entry.mjs")
const server = http.createServer((request, response) => {
  // Synthetic trusted ingress identity, confined to this loopback test process.
  request.headers["x-remote-user-id"] = "event-fixture-admin"
  request.headers["x-remote-user-groups"] = "system-admin"
  runWithIngressTransport({
    peer: "172.30.32.2", fromSupervisor: true, identityHeadersSafe: true,
    configuredPath: "/api/hassio_ingress/event-authority-fixture",
  }, () => handler(request, response))
})
server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ eventFixturePort: server.address().port }))
})
process.once("SIGTERM", () => {
  server.closeAllConnections()
  process.exit(0)
})
