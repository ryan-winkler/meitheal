import http from "node:http"
import { runWithIngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"

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

  runWithIngressTransport({
    peer: fromSupervisor ? "172.30.32.2" : "172.30.33.7",
    fromSupervisor,
    identityHeadersSafe: user !== "old",
    configuredPath,
  }, () => handler(request, response))
})

server.listen(0, "127.0.0.1", () => {
  process.send({ port: server.address().port, configuredPath })
})
