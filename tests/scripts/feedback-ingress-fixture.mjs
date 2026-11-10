import http from "node:http"
import { runWithIngressTransport, waitForDownloadDrain } from "../../apps/web/scripts/ingress-transport.mjs"

process.env.ASTRO_NODE_AUTOSTART = "disabled"
const { handler } = await import("../../apps/web/dist/server/entry.mjs")
const configuredPath = "/api/hassio_ingress/feedback-fixture"

const server = http.createServer((request, response) => {
  const fromSupervisor = request.url?.startsWith(`${configuredPath}/`) ?? false
  const user = /(?:^|;\s*)feedback-fixture=(admin|member|old)(?:;|$)/.exec(request.headers.cookie ?? "")?.[1]
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
  runWithIngressTransport({
    peer: fromSupervisor ? "172.30.32.2" : "172.30.33.7",
    fromSupervisor,
    identityHeadersSafe: user !== "old",
    configuredPath,
    waitForDatabaseDownloadDrain: databaseDownload ? waitForDrain : undefined,
    waitForHtmlDrain: fromSupervisor ? waitForDrain : undefined,
  }, () => handler(request, response))
})

server.listen(Number(process.env.MEITHEAL_INGRESS_FIXTURE_PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address()
  process.env.PORT = String(port)
  process.send({ port, configuredPath })
})
