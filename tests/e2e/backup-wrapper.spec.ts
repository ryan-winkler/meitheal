import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../apps/web")

test("built wrapper overwrites forged socket metadata and scopes native backup hooks", async () => {
  test.skip(!existsSync(join(appRoot, "dist/server/entry.mjs")), "Build the web app before production-wrapper acceptance")
  const directory = await mkdtemp(join(tmpdir(), "meitheal-backup-wrapper-"))
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const address = reservation.address()
  if (!address || typeof address === "string") throw new Error("Missing isolated test port")
  const port = address.port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))

  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), INGRESS_PATH: "/api/hassio_ingress/wrapper-origin", SUPERVISOR_TOKEN: "synthetic-backup-wrapper", MEITHEAL_DB_URL: `file:${join(directory, "test.db")}`, MEITHEAL_LOG_LEVEL: "error", MEITHEAL_AUDIT_ENABLED: "false", ASTRO_NODE_LOGGING: "disabled" }
  delete env.LOKI_URL
  delete env.HA_TOKEN
  delete env.HA_BASE_URL
  const server = spawn(process.execPath, ["scripts/serve.mjs"], { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] })
  let diagnostic = ""
  for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8000) })

  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: object, localAddress = "127.0.0.1") => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({ hostname: "127.0.0.1", port, localAddress, path, method, headers: { host: `localhost:${port}`, "content-type": "application/json", ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }), ...headers } }, response => {
      let raw = ""
      response.on("data", chunk => { raw += String(chunk) })
      response.on("end", () => {
        try { resolve({ status: response.statusCode ?? 0, data: raw ? JSON.parse(raw) : null }) } catch { reject(new Error(`Non-JSON wrapper response (${response.statusCode})`)) }
      })
    })
    req.on("error", reject)
    req.setTimeout(3000, () => req.destroy(new Error("Isolated wrapper request timed out")))
    req.end(payload)
  })

  const post = (path: string, headers: Record<string, string> = {}, body?: object, localAddress = "127.0.0.1") => send("POST", path, headers, body, localAddress)

  try {
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) {
      if (server.exitCode !== null) throw new Error(`Wrapper exited: ${diagnostic}`)
      try {
        if ((await post("/api/backup/complete")).status === 200) { ready = true; break }
      } catch { /* Wait for the owned process to listen. */ }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(ready, diagnostic).toBe(true)
    const native = await post("/api/backup/prepare", { "x-meitheal-socket-peer": "172.30.32.2" })
    expect(native.status).toBe(200) // Actual loopback replaced the forged ingress peer.
    expect(native.data).toMatchObject({ ok: true, checkpoint: "complete" })

    const spoof = await post("/api/backup/prepare", { "x-meitheal-socket-peer": "127.0.0.1", "x-forwarded-for": "127.0.0.1" }, undefined, "127.0.0.2")
    expect(spoof.status).toBe(403) // Forwarded clientAddress cannot impersonate the socket.
    const member = await post("/api/backup/prepare", { "x-remote-user-id": "member", "x-remote-user-groups": "system-users", "x-hass-is-admin": "true" })
    expect(member.status).toBe(403)

    const owner = { "x-remote-user-id": "owner", "x-remote-user-groups": "system-admin", origin: `http://localhost:${port}` }
    const minted = await post("/api/agent-tokens", owner, { name: "Backup wrapper read-only fixture", scopes: ["settings:read"] })
    expect(minted.status).toBe(201)
    expect((await post("/api/backup/prepare", { authorization: `Bearer ${minted.data.token}` })).status).toBe(403)
    expect((await post("/api/backup/complete")).data).toEqual({ ok: true, writes_paused: false })

    // Astro7 normalizes Request.url to localhost, while retaining the original
    // Host. The built wrapper must preserve JSON same-site review and truthful
    // discovery without wildcard allowedDomains or a new trusted-origin helper.
    const authority = "ha.example:8123"
    const publicOrigin = `https://${authority}`
    const external = { host: authority, origin: publicOrigin, "x-forwarded-proto": "https" }
    const externalOwner = { ...external, "x-remote-user-id": "owner", "x-remote-user-groups": "system-admin" }
    const externalMember = { ...external, "x-remote-user-id": "member", "x-remote-user-groups": "system-users", "x-hass-is-admin": "true" }
    expect((await send("PUT", "/api/settings", externalMember, { key: "wrapper_origin_fixture", value: "denied" })).status).toBe(403)
    expect((await send("PUT", "/api/settings", externalOwner, { key: "wrapper_origin_fixture", value: "acknowledged" })).status).toBe(200)
    for (const protocol of ["a2a", "mcp"]) {
      expect((await send("PUT", "/api/settings", externalOwner, { key: `agent-protocols-${protocol}-enabled`, value: true })).status).toBe(200)
    }
    const card = await send("GET", "/.well-known/agent-card.json", external)
    expect(card.status).toBe(200)
    expect(card.data.supportedInterfaces[0].url).toBe(`${publicOrigin}/api/hassio_ingress/wrapper-origin/api/a2a/message`)
    const discovery = await send("GET", "/.well-known/mcp.json", external)
    expect(discovery.status).toBe(200)
    expect(discovery.data.endpoint).toBe("/api/hassio_ingress/wrapper-origin/api/mcp")
    const task = await post("/api/tasks", externalOwner, { title: "External Host proposal fixture" })
    expect(task.status).toBe(201)
    const search = await post("/api/mcp", externalOwner, { jsonrpc: "2.0", id: "origin-search", method: "tools/call", params: { name: "searchTasks", arguments: { q: "External Host proposal fixture" } } })
    expect(search.status).toBe(200)
    expect(search.data.result.isError).toBe(false)
    expect(JSON.parse(search.data.result.content[0].text).tasks.some((value: { id: string }) => value.id === task.data.id)).toBe(true)
    const proposer = await post("/api/agent-tokens", externalOwner, { name: "External Host proposal fixture", scopes: ["tasks:propose"] })
    expect(proposer.status).toBe(201)
    const agent = { ...external, authorization: `Bearer ${proposer.data.token}` }
    const handoffPath = `/api/tasks/${task.data.id}/handoff`
    const claim = await post(handoffPath, agent, { action: "claim" })
    expect(claim.status).toBe(200)
    const proposal = await post(handoffPath, agent, { action: "propose", lease: claim.data.lease, summary: "Test actual normalized-host review", updates: { title: "Reviewed external Host fixture" } })
    expect(proposal.status).toBe(200)
    const decisionPath = `/api/tasks/${task.data.id}/accept-proposal`
    const input = { action: "accept", proposal_hash: proposal.data.hash }
    expect((await post(decisionPath, externalMember, input)).status).toBe(403)
    expect((await post(decisionPath, { ...externalOwner, origin: "https://foreign.invalid", referer: publicOrigin }, input)).status).toBe(403)
    expect((await post(decisionPath, { ...externalOwner, authorization: agent.authorization }, input)).status).toBe(403)
    expect((await post(decisionPath, externalOwner, input)).status).toBe(200)
    expect((await post(decisionPath, externalOwner, input)).status).toBe(409)
    expect((await send("GET", `/api/tasks/${task.data.id}`, externalOwner)).data.title).toBe("Reviewed external Host fixture")
    expect((await send("DELETE", "/api/agent-tokens", externalOwner, { id: proposer.data.id, hard: true })).status).toBe(200)
  } finally {
    await new Promise<void>(resolve => {
      if (server.exitCode !== null) { resolve(); return }
      const timer = setTimeout(() => { server.kill("SIGKILL"); resolve() }, 2000)
      server.once("exit", () => { clearTimeout(timer); resolve() })
      server.kill("SIGTERM")
    })
    await rm(directory, { recursive: true, force: true })
  }
})
