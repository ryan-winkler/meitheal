import { once } from "node:events"
import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import { createRequire } from "node:module"
import { runWithIngressTransport, waitForDownloadDrain } from "../../apps/web/scripts/ingress-transport.mjs"

const pinFixture = process.env.MEITHEAL_PIN_FIXTURE === "1"
if (pinFixture) {
  const require = createRequire(new URL("../../apps/web/package.json", import.meta.url))
  const { WebSocketServer } = require("ws")
  const core = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  await once(core, "listening")
  const users = ["admin", "member", "member-two"].map(user => ({
    id: `fixture-${user}`, is_active: true, system_generated: false,
  }))
  let unavailable = false
  core.on("connection", socket => {
    socket.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.0" }))
    socket.on("message", raw => {
      const message = JSON.parse(raw.toString())
      if (message.type === "auth") socket.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.0" }))
      else if (message.type === "ping") socket.send(JSON.stringify({ id: message.id, type: "pong" }))
      else if (message.type === "config/auth/list" && unavailable) return
      else socket.send(JSON.stringify({
        id: message.id, type: "result", success: true,
        result: message.type === "config/auth/list" ? users : [],
      }))
    })
  })
  const realRequest = http.request
  http.request = function (options, ...rest) {
    if (options?.host === "supervisor" && options.path === "/core/api/websocket") {
      options = { ...options, host: "127.0.0.1", port: core.address().port }
    }
    return realRequest.call(this, options, ...rest)
  }
  process.env.SUPERVISOR_TOKEN = "synthetic-pin-fixture"
  process.on("message", message => {
    if (message?.type !== "fixture-core") return
    const user = users.find(user => user.id === `fixture-${message.user}`)
    if (user) user.is_active = message.active
    unavailable = message.unavailable === true
    process.send({ coreChanged: true })
  })
}

process.env.ASTRO_NODE_AUTOSTART = "disabled"
const { handler } = await import("../../apps/web/dist/server/entry.mjs")
const configuredPath = "/api/hassio_ingress/feedback-fixture"
let serveOldWorker = false
let holdPinReceipt = false
let releasePinReceipt
process.on("message", message => {
  if (pinFixture && message?.type === "hold-pin-receipt") {
    holdPinReceipt = true
    process.send({ holdingPinReceipt: true })
  }
  if (pinFixture && message?.type === "release-pin-receipt") {
    releasePinReceipt?.()
    releasePinReceipt = undefined
  }
  if (message?.type !== "fixture-worker") return
  serveOldWorker = message.old === true
  process.send({ oldWorker: serveOldWorker })
})

const oldWorker = `
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (event.request.method !== "GET") return
  if (!url.pathname.endsWith("/deferred")) {
    event.respondWith(fetch(event.request))
    return
  }
  event.respondWith((async () => {
    const cache = await caches.open("meitheal-nav-v0.0.1")
    try {
      const response = await fetch(event.request)
      if (response.ok) await cache.put(event.request, response.clone())
      return response
    } catch {
      return await cache.match(event.request) ?? Response.error()
    }
  })())
})
`
const pinnedLegacyWorker = pinFixture && process.env.MEITHEAL_PIN_LEGACY_WORKER
  ? readFileSync(process.env.MEITHEAL_PIN_LEGACY_WORKER, "utf8") : oldWorker

const handle = (request, response) => {
  const fromSupervisor = request.url?.startsWith(`${configuredPath}/`) ?? false
  if (pinFixture && request.url === configuredPath + "/fixture") {
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" })
    response.end("<!doctype html><title>Pin API fixture</title>")
    return
  }
  if (fromSupervisor && serveOldWorker && request.method === "GET" &&
      request.url.split("?")[0] === `${configuredPath}/sw.js`) {
    response.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" })
    response.end(pinnedLegacyWorker)
    return
  }
  const user = /(?:^|;\s*)feedback-fixture=(admin|member|member-two|old)(?:;|$)/.exec(request.headers.cookie ?? "")?.[1]
  if (fromSupervisor) {
    request.url = request.url.slice(configuredPath.length)
    delete request.headers["x-remote-user-id"]
    delete request.headers["x-remote-user-groups"]
    if (user) request.headers["x-remote-user-id"] = `fixture-${user}`
    if (user === "admin" || user === "old") request.headers["x-remote-user-groups"] = "system-admin"
  }

  const waitForDrain = signal => waitForDownloadDrain(response, signal)
  const databaseDownload = request.method === "POST" && request.url === "/api/export/database.sqlite"
  if (databaseDownload) {
    response.setHeader("cache-control", "no-store")
    if (fromSupervisor && request.headers["sec-fetch-site"] === undefined) delete request.headers.origin
  }

  if (fromSupervisor && holdPinReceipt && request.method === "PUT" && request.url === "/api/task-pins") {
    holdPinReceipt = false
    const end = response.end.bind(response)
    response.end = (...args) => {
      releasePinReceipt = () => end(...args)
      process.send({ pinReceiptStatus: response.statusCode })
      return response
    }
  }
  runWithIngressTransport({
    peer: fromSupervisor ? "172.30.32.2" : "172.30.33.7",
    fromSupervisor,
    identityHeadersSafe: user !== "old",
    configuredPath,
    waitForDatabaseDownloadDrain: databaseDownload ? waitForDrain : undefined,
    waitForHtmlDrain: fromSupervisor ? waitForDrain : undefined,
  }, () => handler(request, response))
}
const server = pinFixture && process.env.MEITHEAL_PIN_FIXTURE_HTTP !== "1" ? https.createServer({
  key: readFileSync(process.env.MEITHEAL_PIN_FIXTURE_TLS_KEY),
  cert: readFileSync(process.env.MEITHEAL_PIN_FIXTURE_TLS_CERT),
}, handle) : http.createServer(handle)

if (process.env.MEITHEAL_TEST_CORE_USER_LOOKUP === "1") {
  const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url))
  const { WebSocket, WebSocketServer } = requireWeb("ws")
  const token = "database-core-fixture-only"
  const core = new WebSocketServer({ server, path: "/core/websocket" })
  process.once("SIGTERM", () => {
    // End the fixture's persistent Core connection before Astro drains HTTP.
    for (const socket of core.clients) socket.terminate()
    process.exit(0)
  })
  let role = "allowed"
  let assistMode = "ok"
  const assistCalls = []
  process.env.SUPERVISOR_TOKEN = token
  const fetchNetwork = globalThis.fetch
  globalThis.fetch = (input, options) => {
    if (typeof input === "string" && new URL(input).hostname === "supervisor") {
      return Promise.resolve(Response.json({ data: { addons: [] } }))
    }
    return fetchNetwork(input, options)
  }
  class FixtureSocket extends WebSocket {
    constructor(address, ...options) {
      if (address !== "ws://supervisor/core/api/websocket") throw new Error("Unexpected fixture WebSocket target")
      super(`ws://127.0.0.1:${server.address().port}/core/websocket`, ...options)
    }
  }
  // The lazily loaded Astro connection module installs its own Node polyfill.
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    get: () => FixtureSocket,
    set: () => {},
  })
  process.on("message", message => {
    if (message?.type === "database-core-role") {
      role = message.role
      process.send({ type: "database-core-role", role })
    }
    if (message?.type === "assist-mode") {
      assistMode = message.mode
      process.send({ type: "assist-mode", mode: assistMode })
    }
    if (message?.type === "assist-calls") {
      process.send({ type: "assist-calls", calls: assistCalls })
    }
  })
  core.on("connection", socket => {
    let authenticated = false
    const send = message => socket.send(JSON.stringify(message))
    send({ type: "auth_required", ha_version: "2026.11.1" })
    socket.on("message", data => {
      const message = JSON.parse(data.toString())
      if (!authenticated) {
        if (message.type !== "auth" || message.access_token !== token) {
          send({ type: "auth_invalid" })
          return
        }
        authenticated = true
        send({ type: "auth_ok", ha_version: "2026.11.1" })
      } else if (message.type === "config/auth/list") {
        if (role === "stalled") return
        if (role === "disconnected") return socket.terminate()
        const admin = {
          id: "fixture-admin",
          name: "Fixture admin",
          is_active: role !== "inactive",
          system_generated: role === "system",
          is_owner: role === "owner",
          group_ids: role === "demoted" || role === "owner" ? ["system-users"] : ["system-admin"],
        }
        const result = role === "missing" ? []
          : role === "oversized" ? [{ ...admin, name: "x".repeat(256 * 1024) }]
          : role === "malformed" ? [{ ...admin, system_generated: undefined }]
          : [admin]
        send({ type: "result", id: message.id, success: true, result })
      } else if (message.type === "conversation/agent/list" || message.type === "conversation/process") {
        assistCalls.push(message)
        const result = message.type === "conversation/agent/list"
          ? { agents: [{ id: "conversation.fixture", name: "Fixture agent" }] }
          : { conversation_id: "fixture-thread", response: { response_type: "query_answer", speech: { plain: { speech: "Fixture answer" } } } }
        send(assistMode === "error"
          ? { type: "result", id: message.id, success: false, error: { code: "fixture_error", message: message.text ?? "No agents" } }
          : { type: "result", id: message.id, success: true, result: assistMode === "invalid" ? {} : result })
      } else if (message.type === "ping") {
        send({ type: "pong", id: message.id })
      } else {
        send({ type: "result", id: message.id, success: true, result: [] })
      }
    })
  })
}

server.listen(Number(process.env.MEITHEAL_INGRESS_FIXTURE_PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address()
  process.env.PORT = String(port)
  process.send({ port, configuredPath })
})
