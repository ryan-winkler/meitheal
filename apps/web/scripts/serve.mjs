/** Normalize Supervisor ingress requests before passing them to Astro. */
import http from "node:http"
import { runWithIngressTransport, waitForDownloadDrain } from "./ingress-transport.mjs"

// Home Assistant's documented ingress transport peer. Forwarding headers and
// Astro's clientAddress can describe the client, so neither establishes this.
const SUPERVISOR_ADDRESS = "172.30.32.2"
const supervisorToken = process.env.SUPERVISOR_TOKEN
const configuredPath = process.env.INGRESS_PATH

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
  if (req.url) {
    const query = req.url.indexOf("?")
    const path = query === -1 ? req.url : req.url.slice(0, query)
    const normalizedPath = path.replace(/\/+/g, "/")
    req.url = normalizedPath + (query === -1 ? "" : req.url.slice(query))
    if (req.method === "GET" && normalizedPath === "/api/sse") sseSocket = res
    if (req.method === "GET" && normalizedPath === "/api/export/database.sqlite") {
      waitForDatabaseDownloadDrain = signal => waitForDownloadDrain(res, signal)
    }
  }

  runWithIngressTransport({ peer, fromSupervisor, identityHeadersSafe, configuredPath, sseSocket, waitForDatabaseDownloadDrain }, () => handler(req, res))
})

server.listen(port, host, () => {
  console.log(`Meitheal server listening on http://${host}:${port}`)
})
