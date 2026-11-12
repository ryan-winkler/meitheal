import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run A2A/WebMCP checks");

test.describe("A2A Agent Card Discovery", () => {
  test("the well-known aliases return the dynamic A2A agent card", async ({ request }) => {
    const response = await request.get("/api/a2a/agent-card")
    expect(response.ok()).toBeTruthy()
    const card = await response.json()
    expect(card).toMatchObject({
      name: "Meitheal",
      skills: [{ id: "task-search" }, { id: "assigned-tasks" }],
      supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["application/json", "text/plain"],
    })
    expect(card.supportedInterfaces[0].url).toMatch(/\/api\/a2a\/message$/)
    expect(response.headers()["cache-control"]).toBe("private, no-store")
    for (const alias of ["/.well-known/agent.json", "/.well-known/agent-card.json"]) {
      const discovery = await request.get(alias, { maxRedirects: 0 })
      expect(discovery.ok()).toBeTruthy()
      expect(discovery.headers()["cache-control"]).toBe("private, no-store")
      expect(await discovery.json()).toEqual(card)
    }
  })

  test("the card retains the discovery fields", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/api/a2a/agent-card`);
    expect(response.ok()).toBeTruthy();
    const card = await response.json();

    expect(card.name).toBeTruthy();
    expect(card.description).toBeTruthy();
    expect(card.supportedInterfaces).toBeDefined();
    expect(Array.isArray(card.supportedInterfaces)).toBe(true);
    expect(card.supportedInterfaces).toHaveLength(1)
    expect(card.provider).toBeDefined();
    expect(card.capabilities).toBeDefined();
    expect(card.skills).toBeDefined();
  });

  test("the card documents its routes and disables push", async ({
    request,
    baseURL,
  }) => {
    const response = await request.get(`${baseURL}/api/a2a/agent-card`);
    const card = await response.json();

    expect(card.description).toMatch(/read-only/)
    expect(card.capabilities).toMatchObject({ pushNotifications: false, streaming: false })
    expect(card.documentationUrl).toMatch(/\/openapi\.yaml$/)
    expect((await request.get(new URL(card.documentationUrl).pathname)).ok()).toBe(true)
  });
});

test.describe("A2A Route Availability", () => {
  test("requires an agent token and never fabricates A2A tasks", async ({ request }) => {
    const message = await request.post("/api/a2a/message", {
      data: { message: { role: "user", parts: [{ text: "Create a task" }] } },
    })
    expect(message.status()).toBe(401)
    expect(message.headers()["cache-control"]).toBe("private, no-store")
    const body = await message.json()
    expect(body).toMatchObject({ detail: expect.stringContaining("agent token") })
    expect(body).not.toHaveProperty("task")

    for (const response of [
      await request.get("/api/a2a/tasks/unknown"),
      await request.post("/api/a2a/tasks/unknown", { data: {} }),
      await request.post("/api/a2a/tasks/unknown:cancel", { data: {} }),
    ]) {
      expect(response.status()).toBe(404)
      expect(response.headers()["cache-control"]).toBe("private, no-store")
      expect(await response.json()).not.toHaveProperty("task")
    }
  })

  test("the installed setting controls discovery and execution through managed ingress", async ({ playwright }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and its disposable ingress fixture")
    const work = await mkdtemp(join(tmpdir(), "meitheal-a2a-availability-"))
    const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
    const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
      MEITHEAL_TEST_CORE_USER_LOOKUP: "1",
    }
    const api = await playwright.request.newContext()
    let server: ReturnType<typeof fork> | undefined

    try {
      execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
      const child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
      server = child
      const [info] = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(10_000) }),
        once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
      ])
      const origin = `http://127.0.0.1:${info.port}`
      const ingress = origin + info.configuredPath
      const cards = ["/.well-known/agent-card.json", "/.well-known/agent.json", "/api/a2a/agent-card"] as const
      const enroll = async (...scopes: string[]) => {
        const response = await api.post(ingress + "/api/agent-tokens", {
          headers: { origin, cookie: "feedback-fixture=admin" },
          data: { name: "A2A availability fixture", scopes },
        })
        expect(response.status()).toBe(201)
        const { token } = await response.json()
        return { origin, authorization: `Bearer ${token}` }
      }
      const authorized = await enroll("a2a:execute", "search:read")
      const unrelated = await enroll("search:read")
      const call = (path: string, method: string, headers: Record<string, string> = authorized) =>
        api.fetch(ingress + path, { method, headers, ...(method === "POST" ? { data: {} } : {}) })
      const save = (role: string, value: unknown) => api.put(ingress + "/api/settings", {
        headers: { origin, cookie: `feedback-fixture=${role}` },
        data: { key: "agent-protocols-a2a-enabled", value },
      })

      expect((await api.get(origin + cards[0])).status()).toBe(403)
      expect((await api.post(origin + "/api/a2a/message", {
        headers: { origin, "A2A-Token": "forged" },
        data: {},
      })).status()).toBe(401)
      expect((await call("/api/a2a/message", "POST", {
        origin, authorization: `Bearer mth_${"a".repeat(64)}`,
      })).status()).toBe(401)
      expect((await call("/api/a2a/message", "POST", unrelated)).status()).toBe(403)
      for (const path of cards) {
        const response = await call(path, "GET")
        expect(response.status()).toBe(200)
        expect(response.headers()["cache-control"]).toBe("private, no-store")
        const card = await response.json()
        expect(card).toMatchObject({ skills: [{ id: "task-search" }, { id: "assigned-tasks" }] })
        expect(card.supportedInterfaces[0].url).toBe(origin + info.configuredPath + "/api/a2a/message")
        expect(card.documentationUrl).toBe(origin + info.configuredPath + "/openapi.yaml")
      }
      expect(await (await call("/api/a2a/message", "POST")).json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 } })
      expect((await save("member", false)).status()).toBe(403)
      expect((await save("admin", false)).status()).toBe(200)

      for (const [path, method] of [
        ...cards.map(path => [path, "GET"] as const),
        ["/api/a2a/message", "POST"],
        ["/api/a2a/tasks/unknown", "GET"],
        ["/api/a2a/tasks/unknown", "POST"],
      ] as const) {
        const response = await call(path, method)
        expect(response.status()).toBe(404)
        expect(response.headers()["cache-control"]).toBe("private, no-store")
        expect(await response.json()).toMatchObject({ detail: "A2A is disabled." })
      }
      expect((await call("/api/a2a/message", "POST", unrelated)).status()).toBe(403)
      expect((await save("admin", "true")).status()).toBe(200)
      expect((await call(cards[0], "GET")).status()).toBe(200)
      expect(await (await call("/api/a2a/message", "POST")).json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 } })
      const unknown = await call("/api/a2a/tasks/unknown", "GET")
      expect(await unknown.json()).toMatchObject({ status: 404, detail: "A2A task not found." })
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit")
        server.kill()
        await exited
      }
      await api.dispose()
      await rm(work, { recursive: true, force: true })
    }
  })
})

test.describe("MCP Discovery", () => {
  test("the public manifest points clients to authenticated discovery", async ({ request }) => {
    const response = await request.get("/.well-known/mcp.json")
    expect(response.ok()).toBeTruthy()
    const manifest = await response.json()
    expect(manifest).toMatchObject({
      name: "meitheal",
      protocol: "mcp",
      protocolVersion: "2025-03-26",
      endpoint: "/api/mcp",
      authentication: { type: "bearer", requiredScope: "mcp:execute" },
    })
    expect(manifest.discovery).toContain("tools/list")
    expect(manifest).not.toHaveProperty("tools")

    const discovery = await request.post(manifest.endpoint, {
      headers: { origin: new URL(response.url()).origin },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
    expect(discovery.status()).toBe(401)
    expect(discovery.headers()["www-authenticate"]).toMatch(/^Bearer/i)
    expect(await discovery.json()).not.toHaveProperty("result")
  })

  test("the runtime catalog exposes valid schemas only for the token's scopes", async ({ playwright }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and its disposable ingress fixture")
    const work = await mkdtemp(join(tmpdir(), "meitheal-mcp-discovery-"))
    const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
    const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
    const env = {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
      MEITHEAL_TEST_CORE_USER_LOOKUP: "1",
    }
    const api = await playwright.request.newContext()
    let server: ReturnType<typeof fork> | undefined

    try {
      execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
      const child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
      server = child
      const [info] = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(10_000) }),
        once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
      ])
      const origin = `http://127.0.0.1:${info.port}`
      const ingress = origin + info.configuredPath
      const discovery = await api.get(origin + info.configuredPath + "/.well-known/agent-card.json", { maxRedirects: 0 })
      expect(discovery.status()).toBe(200)
      const card = await discovery.json()
      expect(card.documentationUrl).toBe(origin + info.configuredPath + "/openapi.yaml")
      expect((await api.get(card.documentationUrl)).ok()).toBe(true)
      const adminPath = origin + info.configuredPath + "/api/agent-tokens"
      const issueToken = async (scopes: string[]) => {
        const enrollment = await api.post(adminPath, {
          headers: { cookie: "feedback-fixture=admin" },
          data: { name: "MCP discovery fixture", scopes },
        })
        expect(enrollment.status()).toBe(201)
        const { token } = await enrollment.json()
        return { authorization: `Bearer ${token}` }
      }
      const send = (headers: Record<string, string>, method: string, params?: Record<string, unknown>) =>
        api.post(ingress + "/api/mcp", { headers: { origin, ...headers }, data: { jsonrpc: "2.0", id: 1, method, params } })
      const readHeaders = await issueToken(["mcp:execute", "tasks:read"])
      const writeHeaders = await issueToken(["mcp:execute", "tasks:write"])
      const noMcpHeaders = await issueToken(["tasks:read"])

      const manifest = await api.get(ingress + "/.well-known/mcp.json")
      expect(manifest.status()).toBe(200)
      expect(manifest.headers()["cache-control"]).toBe("no-store")
      expect(await manifest.json()).toMatchObject({
        endpoint: info.configuredPath + "/api/mcp",
        supportedVersions: expect.arrayContaining(["2026-07-28", "2025-03-26"]),
      })
      expect((await api.get(origin + "/.well-known/mcp.json")).status()).toBe(403)
      expect((await send({}, "tools/list")).status()).toBe(401)
      expect((await send(noMcpHeaders, "tools/list")).status()).toBe(403)
      const initialize = await send(readHeaders, "initialize")
      expect(initialize.status(), await initialize.text()).toBe(200)
      expect(await initialize.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } } },
      })
      const negotiated = await send(readHeaders, "initialize", { protocolVersion: "2025-11-25" })
      expect(await negotiated.json()).toMatchObject({ result: { protocolVersion: "2025-11-25" } })
      const initialized = await api.post(ingress + "/api/mcp", {
        headers: { origin, ...readHeaders, "mcp-protocol-version": "2025-11-25" },
        data: { jsonrpc: "2.0", method: "notifications/initialized" },
      })
      expect(initialized.status()).toBe(202)
      expect(await initialized.text()).toBe("")
      const probe = (headers: Record<string, string>, method = "GET") =>
        api.fetch(ingress + "/api/mcp", { method, headers: { origin, ...headers } })
      for (const method of ["GET", "HEAD"]) {
        expect((await probe({}, method)).status()).toBe(401)
        expect((await probe(noMcpHeaders, method)).status()).toBe(403)
        const unsupported = await probe(readHeaders, method)
        expect(unsupported.status()).toBe(405)
        expect(unsupported.headers().allow).toBe("POST")
      }

      const readList = await send(readHeaders, "tools/list")
      const writeList = await send(writeHeaders, "tools/list")
      expect(readList.ok()).toBeTruthy()
      expect(writeList.ok()).toBeTruthy()
      const read = await readList.json()
      const write = await writeList.json()
      expect(read).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } })
      expect(write).toMatchObject({ jsonrpc: "2.0", id: 1, result: { tools: expect.any(Array) } })
      const readTools = read.result.tools as McpTool[]
      const writeTools = write.result.tools as McpTool[]
      for (const tools of [readTools, writeTools]) {
        const names = tools.map(tool => tool.name)
        expect(new Set(names).size).toBe(names.length)
        expect(names.filter(name => /agenttoken|localfeedback|exportdatabase|settings/i.test(name))).toEqual([])
        expect(names).not.toContain("findCommentPeople")
        for (const tool of tools) {
          expect(tool.name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,62}$/)
          expect(tool.description).toMatch(/\S/)
          expect(tool.inputSchema).toMatchObject({ type: "object", properties: expect.any(Object) })
          for (const property of Object.values(tool.inputSchema.properties)) {
            expect(property).toEqual(expect.any(Object))
          }
          for (const required of tool.inputSchema.required ?? []) {
            expect(Object.keys(tool.inputSchema.properties)).toContain(required)
          }
        }
      }
      expect(readTools.map(tool => tool.name)).not.toContain("createTask")
      expect(writeTools.map(tool => tool.name)).not.toContain("listTasks")
      expect(readTools.find(tool => tool.name === "listTasks")?.inputSchema).toMatchObject({
        properties: { limit: { type: "integer" } },
      })
      expect(writeTools.find(tool => tool.name === "createTask")?.inputSchema).toMatchObject({
        properties: { title: { type: "string" } },
        required: expect.arrayContaining(["title"]),
      })
      const people = await api.post(ingress + "/api/comment-people", {
        headers: { origin, ...readHeaders }, data: { q: "" },
      })
      expect(people.status()).toBe(403)
      expect(people.headers()["cache-control"]).toBe("private, no-store")

      const denied = await send(readHeaders, "tools/call", { name: "createTask", arguments: { title: "Denied" } })
      expect(denied.ok()).toBeTruthy()
      expect(await denied.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32603, message: "Tool is unavailable to this token" },
      })

      const version = "2026-07-28"
      const modern = (method: string, params: Record<string, unknown> = {}, extraHeaders = {}) =>
        send({ ...readHeaders, "mcp-protocol-version": version, "mcp-method": method, ...extraHeaders }, method, {
          ...params,
          _meta: { "io.modelcontextprotocol/protocolVersion": version, "io.modelcontextprotocol/clientCapabilities": {} },
        })
      const discover = await modern("server/discover")
      expect(discover.status()).toBe(200)
      expect(await discover.json()).toMatchObject({
        result: {
          resultType: "complete",
          supportedVersions: expect.arrayContaining([version]),
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "meitheal" } },
        },
      })
      const list = await modern("tools/list")
      expect(await list.json()).toMatchObject({ result: { resultType: "complete", tools: readTools } })
      const params = { name: "listTasks", arguments: { limit: 1 } }
      const tool = await modern("tools/call", params, { "mcp-name": "listTasks", origin })
      expect(tool.status()).toBe(200)
      expect(tool.headers()["ratelimit"]).toBeDefined()
      expect(await tool.json()).toMatchObject({
        result: { resultType: "complete", isError: false, structuredContent: { tasks: expect.any(Array) } },
      })
      const wrongName = await modern("tools/call", params, { "mcp-name": "createTask" })
      expect(wrongName.status()).toBe(400)
      expect(await wrongName.json()).toMatchObject({ error: { code: -32020 } })
      const wrongVersion = await modern("tools/list", {}, { "mcp-protocol-version": "2099-01-01" })
      expect(wrongVersion.status()).toBe(400)
      expect(await wrongVersion.json()).toMatchObject({ error: { code: -32022 } })
      expect((await modern("tools/list", {}, { origin: "https://untrusted.example" })).status()).toBe(403)
      expect((await send(readHeaders, "tools/list", { padding: "x".repeat(1024 * 1024) })).status()).toBe(413)

      const save = (value: unknown, role: string) => api.put(ingress + "/api/settings", {
        headers: { cookie: `feedback-fixture=${role}` },
        data: { key: "agent-protocols-mcp-enabled", value },
      })
      expect((await save(false, "member")).status()).toBe(403)
      expect((await save(false, "admin")).status()).toBe(200)
      const hidden = await api.get(ingress + "/.well-known/mcp.json")
      expect(hidden.status()).toBe(404)
      expect(hidden.headers()["cache-control"]).toBe("no-store")
      expect(await hidden.json()).not.toHaveProperty("endpoint")
      expect((await send(readHeaders, "tools/list")).status()).toBe(404)
      expect((await modern("server/discover")).status()).toBe(404)
      expect((await probe(readHeaders)).status()).toBe(404)
      expect((await probe(noMcpHeaders)).status()).toBe(403)
      expect((await send(noMcpHeaders, "tools/list")).status()).toBe(403)
      expect((await save("true", "admin")).status()).toBe(200)
      expect((await api.get(ingress + "/.well-known/mcp.json")).status()).toBe(200)
      expect((await send(readHeaders, "tools/list")).status()).toBe(200)
    } finally {
      if (server && server.exitCode === null && server.signalCode === null) {
        const exited = once(server, "exit")
        server.kill()
        await exited
      }
      await api.dispose()
      await rm(work, { recursive: true, force: true })
    }
  })
})

interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, unknown>
    required?: string[]
  }
}
