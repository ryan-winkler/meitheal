/** Normalize Supervisor ingress requests before passing them to Astro. */
import { setMaxListeners } from "node:events"
import { writeSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { finalizeStartupBoardGrant } from "./board-grant-journal.mjs"
import { boardRouteSelection } from "./board-route-selection.mjs"
import { isMemoryDatabase, openDatabaseForStartup, withStartupWriteTransaction } from "./database-client.mjs"
import { attachResponsePerformanceHooks } from "./http-performance.mjs"
import { runWithIngressTransport, waitForDownloadDrain } from "./ingress-transport.mjs"
import { DEFAULT_WEBSERVER_PORT, parsePortSpec } from "./port-spec.mjs"
import { recordIngressStreamAbort } from "./runtime-counters.mjs"
import { autoBackupDb } from "./startup-backup.mjs"
import { applyStartupBoardSchema, validateStartupTaskSchema } from "./task-schema-startup.mjs"

// Home Assistant's documented ingress transport peer. Forwarding headers and
// Astro's clientAddress can describe the client, so neither establishes this.
const SUPERVISOR_ADDRESS = "172.30.32.2"
const supervisorToken = process.env.SUPERVISOR_TOKEN
const configuredPath = process.env.INGRESS_PATH
const databaseExportPath = "/api/export/database.sqlite"
const onlineReadPaths = new Set(["/api/search", "/api/saved-filters", "/activity", "/api/comment-people", "/api/mention-inbox", "/mention-inbox"])
const taskHistoryPath = /^\/api\/tasks\/[^/]+\/(?:activity|timeline)$/
const taskCapturePath = "/api/tasks"
const boardCapturePath = /^\/api\/boards\/[^/]+\/tickets$/
const pinApiPath = "/api/task-pins"
const draftApiPath = "/api/task-drafts"
const inactivityApiPath = "/api/task-inactivity"
const labelCleanupPath = "/api/labels/cleanup"
const inactivityPagePath = "/inactivity"
const pinnedPagePath = "/pinned"

function writeJsonLine(fd, payload) {
  try {
    writeSync(fd, `${JSON.stringify(payload)}\n`)
  } catch {
    // Ignore closed or full stdio pipe during teardown.
  }
}

const servers = []
let hasListened = false
let shuttingDown = false
let inStartupDatabase = false
const shutdownController = new AbortController()
setMaxListeners(0, shutdownController.signal)

function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  process.exitCode = exitCode
  writeJsonLine(1, {
    level: "info",
    event: "web.stopping",
    signal,
    time: new Date().toISOString(),
  })
  if (servers.length === 0) {
    if (!inStartupDatabase) process.exit(exitCode)
    return
  }
  // Force exit after 3s, before run.sh stop_child sends SIGKILL at 5s.
  const forceTimer = setTimeout(() => {
    for (const srv of servers) srv.closeAllConnections?.()
    // Wait 50 ms so stream close cleanup hooks run before exit.
    setTimeout(() => process.exit(exitCode), 50).unref()
  }, 3_000)
  forceTimer.unref()
  let remaining = servers.length
  for (const srv of servers) {
    srv.close(() => {
      remaining -= 1
      if (remaining <= 0) {
        clearTimeout(forceTimer)
        process.exit(exitCode)
      }
    })
  }
  shutdownController.abort()
  for (const srv of servers) srv.closeIdleConnections?.()
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

async function prepareDatabase() {
  const url = process.env.MEITHEAL_DB_URL ?? "file:./.data/meitheal.db"
  // Astro initializes the process-owned in-memory database before serving its first request.
  if (isMemoryDatabase(url)) return
  const migrated = process.env.MEITHEAL_STARTUP_BACKUP_HANDLED === "1"
  if (!migrated && url.startsWith("file:")) {
    await mkdir(path.dirname(path.resolve(url.slice("file:".length))), { recursive: true })
  }
  const client = await openDatabaseForStartup(url, { readOnly: migrated, markerPath: process.env.MEITHEAL_BOARD_GRANT_PATH })
  try {
    if (!migrated) {
      await autoBackupDb(client)
      let initialRevision = null
      await withStartupWriteTransaction(client, async tx => {
        const result = await applyStartupBoardSchema(client, tx)
        initialRevision = result.revision
      })
      await finalizeStartupBoardGrant(client, initialRevision)
      process.env.MEITHEAL_STARTUP_BACKUP_HANDLED = "1"
      return
    }
    const tx = await client.transaction("read")
    try {
      await validateStartupTaskSchema(tx, { allowPending: true })
    } finally {
      tx.close()
    }
  } finally {
    client.close()
  }
}

// Astro can decode escapes and redirect trailing separators before middleware.
function privateRoutePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, "")
  if (!/[%\\]|\/\./.test(trimmed)) return trimmed

  let decoded = pathname
  for (let i = 0; i < 10 && decoded.includes("%"); i++) {
    try {
      const next = decodeURI(decoded).replace(/%2f/gi, "/")
      if (next === decoded) break
      decoded = next
    } catch {
      return undefined
    }
  }
  if (!decoded.startsWith("/")) return undefined
  const resolved = new URL("http://localhost" + decoded.replace(/[\\/]+/g, "/")).pathname
  return resolved.replace(/\/+$/, "")
}

async function supervisorProtectsIdentityHeaders() {
  if (!supervisorToken) return false

  try {
    const response = await fetch(`http://${SUPERVISOR_ADDRESS}/info`, { // nosemgrep
      headers: { authorization: `Bearer ${supervisorToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return false
    const { data } = await response.json()
    const version = typeof data?.supervisor === "string" && data.supervisor.match(/^(\d{4})\.(\d{1,2})\.(\d+)$/)
    if (!version) return false
    const [, year, month, patch] = version.map(Number)
    // Earlier versions may forward a caller-supplied groups header unchanged.
    return year > 2026 || (year === 2026 && (month > 10 || (month === 10 && patch >= 4)))
  } catch {
    return false
  }
}

const identityHeadersSafe = await supervisorProtectsIdentityHeaders()
if (supervisorToken && !identityHeadersSafe) {
  console.warn("Supervisor identity headers disabled. Check Supervisor connectivity and version (2026.10.4 or later).")
}

if (shuttingDown) process.exit(0)

let handler
try {
  inStartupDatabase = true
  await prepareDatabase()
  inStartupDatabase = false
  if (shuttingDown) process.exit(0)
  // Prevent Astro standalone from auto-starting its own HTTP server.
  process.env.ASTRO_NODE_AUTOSTART = "disabled"
  ;({ handler } = await import("../dist/server/entry.mjs"))
} catch (err) {
  inStartupDatabase = false
  writeJsonLine(2, {
    level: "error",
    event: "web.startup_error",
    code: err?.code ?? "UNKNOWN",
    message: err?.message ?? String(err),
    time: new Date().toISOString(),
  })
  process.exit(1)
}
if (shuttingDown) process.exit(0)

// PORT=0 asks the OS for a free port (tests and local tools); configured port lists stay 1–65535.
const ephemeralPort = !process.env.MEITHEAL_PORTS && process.env.PORT?.trim() === "0"
const parsedPorts = parsePortSpec(process.env.MEITHEAL_PORTS ?? process.env.PORT ?? DEFAULT_WEBSERVER_PORT)
const ports = ephemeralPort ? [0] : parsedPorts.ok ? parsedPorts.ports : [DEFAULT_WEBSERVER_PORT]
const host = process.env.MEITHEAL_HOST?.trim() || process.env.HOST?.trim() || "0.0.0.0"

function createRequestListener(boundServer) {
  return (req, res) => {
  // An IPv4 connection to an IPv6 listener may have a mapped address.
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? ""
  const fromSupervisor = Boolean(supervisorToken) && peer === SUPERVISOR_ADDRESS

  // Normalize only the path. Preserve the query string exactly.
  let sseSocket
  let waitForDatabaseDownloadDrain
  let rawPath
  const waitForDrain = signal => waitForDownloadDrain(res, signal)
  const waitForHtmlDrain = fromSupervisor ? waitForDrain : undefined
  if (req.url) {
    // A fragment is not part of an HTTP request target. Do not let Astro reinterpret it.
    if (req.url.includes("#")) {
      res.writeHead(400, { "cache-control": "private, no-store" }).end()
      return
    }
    const query = req.url.indexOf("?")
    const path = query === -1 ? req.url : req.url.slice(0, query)
    const search = query === -1 ? "" : req.url.slice(query)
    const normalizedPath = path.replace(/\/+/g, "/")
    rawPath = normalizedPath
    const canonical = privateRoutePath(normalizedPath)
    const isPins = canonical === pinApiPath || canonical === pinnedPagePath
    const isOnlineRead = onlineReadPaths.has(canonical)
    const isDraft = canonical === draftApiPath
    const isInactivity = canonical === inactivityApiPath || canonical === inactivityPagePath
    const isLabelCleanup = canonical === labelCleanupPath
    const isReceiptLookup = canonical === taskCapturePath && new URLSearchParams(search).has("captureReceipt")
    const isCaptureCreate = req.method === "POST" && req.headers["x-meitheal-capture-attempt"] !== undefined &&
      (canonical === taskCapturePath || boardCapturePath.test(canonical ?? ""))
    if (isReceiptLookup || isCaptureCreate) {
      res.setHeader("cache-control", "private, no-store")
      if (normalizedPath !== canonical) {
        res.writeHead(404).end()
        return
      }
      if (isReceiptLookup && req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { allow: "GET, HEAD" }).end()
        return
      }
    }
    if (isLabelCleanup && (path !== canonical || query !== -1)) {
      res.writeHead(path !== canonical ? 404 : 400, {
        "cache-control": "private, no-store",
        "content-type": "application/json",
      }).end(JSON.stringify({ ok: false, errorCode: "invalid", detail: "Use the canonical label cleanup path without query parameters." }))
      return
    }
    const hasTaskHistoryPath = taskHistoryPath.test(path)
    const isTaskHistoryAlias = !hasTaskHistoryPath && taskHistoryPath.test(canonical ?? "")
    if (isTaskHistoryAlias || ((isPins || isOnlineRead || isDraft || isInactivity || canonical === databaseExportPath) && path !== canonical)) {
      res.writeHead(404, { "cache-control": "private, no-store" }).end()
      return
    }
    if (isPins || isOnlineRead || isDraft || isInactivity || isLabelCleanup || hasTaskHistoryPath) res.setHeader("cache-control", "private, no-store")
    if ((canonical === pinApiPath || isDraft || canonical === inactivityApiPath) && query !== -1) {
      res.writeHead(400).end()
      return
    }
    // Keep scoped aliases inside ingress and let the normal middleware authorize them.
    let routedPath = normalizedPath
    const boardSelectors = new URLSearchParams(search)
    if (search && canonical && (boardSelectors.has("board") || boardSelectors.has("board_id") ||
        boardRouteSelection(canonical, boardSelectors))) {
      const parsedPath = new URL("http://localhost" + normalizedPath).pathname
      if (parsedPath.endsWith("/")) routedPath = parsedPath.slice(0, -1)
    }
    req.url = routedPath + search
    if (req.method === "GET" && normalizedPath === "/api/sse") sseSocket = res
    if (req.method === "POST" && normalizedPath === "/api/export/database.sqlite") {
      waitForDatabaseDownloadDrain = waitForDrain
      res.setHeader("cache-control", "no-store")
      // For a trusted HTTP LAN form, Astro cannot compare the public Origin
      // with its internal URL. This route verifies a signed, user-bound form.
      if (fromSupervisor && req.headers["sec-fetch-site"] === undefined) delete req.headers.origin
    }
  }

  const transportContext = {
    peer,
    fromSupervisor,
    identityHeadersSafe,
    configuredPath,
    sseSocket,
    shutdownSignal: shutdownController.signal,
    waitForDatabaseDownloadDrain,
    waitForHtmlDrain,
    behindIngress: false,
    streamingIngressHtml: false,
    abortRecorded: false,
    rawPath,
  }
  res.once("finish", () => {
    if (shuttingDown) boundServer.closeIdleConnections?.()
  })
  res.once("close", () => {
    if (
      Boolean(transportContext.behindIngress) &&
      !res.writableEnded &&
      !transportContext.abortRecorded &&
      (
        Boolean(transportContext.streamingIngressHtml) ||
        String(res.getHeader("content-type") ?? res._header ?? "").toLowerCase().includes("text/html")
      )
    ) {
      transportContext.abortRecorded = true
      recordIngressStreamAbort()
    }
  })

  if (rawPath !== "/api/sse" && rawPath !== databaseExportPath) {
    attachResponsePerformanceHooks(req, res, rawPath ?? "/")
  }

  runWithIngressTransport(transportContext, () => handler(req, res))
  }
}

for (const listenPort of ports) {
  const srv = http.createServer()
  srv.on("request", createRequestListener(srv))
  srv.on("error", (err) => {
    const isBindError = !hasListened
    writeJsonLine(2, {
      level: "error",
      event: isBindError ? "web.listen_error" : "web.server_error",
      code: err?.code ?? "UNKNOWN",
      host,
      port: listenPort,
      message: err?.message ?? String(err),
      time: new Date().toISOString(),
    })
    if (isBindError) {
      process.exit(1)
      return
    }
    if (!shuttingDown) shutdown("SERVER_ERROR", 1)
  })
  servers.push(srv)
  srv.listen(listenPort, host, () => {
    hasListened = true
    const bound = srv.address()
    console.log(`Meitheal server listening on http://${host}:${typeof bound === "object" && bound ? bound.port : listenPort}`)
  })
}
