/** Normalize Supervisor ingress requests before passing them to Astro. */
import http from "node:http"
import { runWithIngressTransport, waitForDownloadDrain } from "./ingress-transport.mjs"

// Home Assistant's documented ingress transport peer. Forwarding headers and
// Astro's clientAddress can describe the client, so neither establishes this.
const SUPERVISOR_ADDRESS = "172.30.32.2"
const supervisorToken = process.env.SUPERVISOR_TOKEN
const configuredPath = process.env.INGRESS_PATH
const databaseExportPath = "/api/export/database.sqlite"
const searchPath = "/api/search"
const pinApiPath = "/api/task-pins"
const pinnedPagePath = "/pinned"

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
    const response = await fetch(`http://${SUPERVISOR_ADDRESS}/info`, {
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

// Prevent Astro standalone from auto-starting its own HTTP server.
process.env.ASTRO_NODE_AUTOSTART = "disabled"
const { handler } = await import("../dist/server/entry.mjs")

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? "0.0.0.0"
const server = http.createServer((req, res) => {
  // An IPv4 connection to an IPv6 listener may have a mapped address.
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? ""
  const fromSupervisor = Boolean(supervisorToken) && peer === SUPERVISOR_ADDRESS

  // Normalize only the path. Preserve the query string exactly.
  let sseSocket
  let waitForDatabaseDownloadDrain
  const waitForDrain = signal => waitForDownloadDrain(res, signal)
  const waitForHtmlDrain = fromSupervisor ? waitForDrain : undefined
  if (req.url) {
    const query = req.url.indexOf("?")
    const path = query === -1 ? req.url : req.url.slice(0, query)
    const normalizedPath = path.replace(/\/+/g, "/")
    const canonical = privateRoutePath(normalizedPath)
    const isPins = canonical === pinApiPath || canonical === pinnedPagePath
    const isSearch = canonical === searchPath
    if ((isPins || isSearch || canonical === databaseExportPath) && path !== canonical) {
      res.writeHead(404, { "cache-control": "private, no-store" }).end()
      return
    }
    if (isPins || isSearch) res.setHeader("cache-control", "private, no-store")
    if (canonical === pinApiPath && query !== -1) {
      res.writeHead(400).end()
      return
    }
    req.url = normalizedPath + (query === -1 ? "" : req.url.slice(query))
    if (req.method === "GET" && normalizedPath === "/api/sse") sseSocket = res
    if (req.method === "POST" && normalizedPath === "/api/export/database.sqlite") {
      waitForDatabaseDownloadDrain = waitForDrain
      res.setHeader("cache-control", "no-store")
      // For a trusted HTTP LAN form, Astro cannot compare the public Origin
      // with its internal URL. This route verifies a signed, user-bound form.
      if (fromSupervisor && req.headers["sec-fetch-site"] === undefined) delete req.headers.origin
    }
  }

  runWithIngressTransport({ peer, fromSupervisor, identityHeadersSafe, configuredPath, sseSocket, waitForDatabaseDownloadDrain, waitForHtmlDrain }, () => handler(req, res))
})

server.listen(port, host, () => {
  console.log(`Meitheal server listening on http://${host}:${port}`)
})
