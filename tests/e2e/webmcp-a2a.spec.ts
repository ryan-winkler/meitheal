import { expect, test, type APIRequestContext } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run protocol checks")
test.describe.configure({ mode: "serial" })
const admin = { "x-hass-is-admin": "true", "x-hass-user-id": "local-protocol-tests" }
const envelope = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: "protocol-check", method, params })
const tokenIds: string[] = []

async function issueToken(request: APIRequestContext, scopes: string[]) {
  const response = await request.post("/api/agent-tokens", { headers: admin, data: { name: "Local protocol acceptance", scopes } })
  expect(response.status()).toBe(201)
  const { token, id } = await response.json()
  tokenIds.push(id)
  return { authorization: `Bearer ${token}`, "A2A-Version": "1.0" }
}

test.beforeEach(async ({ request }) => {
  for (const protocol of ["a2a", "mcp"]) {
    expect((await request.put("/api/settings", { headers: admin, data: { key: `agent-protocols-${protocol}-enabled`, value: true } })).ok()).toBe(true)
  }
})

test.afterAll(async ({ request }) => {
  for (const id of tokenIds) await request.delete("/api/agent-tokens", { headers: admin, data: { id, hard: true } })
})

test("A2A aliases advertise only supported search and preserve ingress links", async ({ request, baseURL }) => {
  for (const path of ["/.well-known/agent.json", "/.well-known/agent-card.json", "/api/a2a/agent-card"]) {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(200)
    expect(response.headers()["cache-control"]).toBe("no-store")
    const card = await response.json()
    expect(card).toMatchObject({
      supportedInterfaces: [{ url: `${baseURL}/api/a2a/message`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      skills: [{ id: "task-search", tags: ["tasks", "search", "read-only"] }],
      capabilities: { streaming: false, pushNotifications: false },
    })
    expect(card.skills).toHaveLength(1)
  }
  const ingressPath = "/api/hassio_ingress/local-protocol-fixture"
  const response = await request.get("/.well-known/agent-card.json", { headers: { "X-Ingress-Path": ingressPath } })
  expect((await response.json()).supportedInterfaces[0].url).toBe(`${baseURL}${ingressPath}/api/a2a/message`)
})

test("A2A searches real active titles without inventing asynchronous tasks", async ({ request, baseURL }) => {
  const headers = await issueToken(request, ["a2a:execute", "search:read"])
  const title = `ProtocolHeating${crypto.randomUUID().replaceAll("-", "")}`
  const created = await request.post("/api/tasks", { headers: admin, data: { title, description: "Private description must not appear in protocol output" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  try {
    const input = { message: { role: "ROLE_USER", messageId: "search-check", contextId: "test-context", parts: [{ text: title }] } }
    const response = await request.post("/api/a2a/message", { headers, data: envelope("SendMessage", input) })
    expect(response.status()).toBe(200)
    const json = await response.json()
    expect(json).toMatchObject({
      result: { message: { role: "ROLE_AGENT", contextId: "test-context", parts: [{ data: { tasks: [{ id, title, url: `${baseURL}/tasks?open=${id}` }] } }] } },
    })
    expect(json.result).not.toHaveProperty("task")
    expect(JSON.stringify(json)).not.toContain("Private description")
    const text = await request.post("/api/a2a/message", { headers, data: envelope("SendMessage", {
      ...input, configuration: { acceptedOutputModes: ["text/plain"] },
    }) })
    expect(await text.json()).toMatchObject({ result: { message: { parts: [{ text: expect.stringContaining(title), mediaType: "text/plain" }] } } })
    const list = await request.post("/api/a2a/message", { headers, data: envelope("ListTasks") })
    expect(await list.json()).toMatchObject({ result: { tasks: [], totalSize: 0 } })
  } finally {
    await request.delete(`/api/tasks/${id}`, { headers: admin })
  }
})

test("A2A enforces both scopes, bounded requests and explicit unsupported operations", async ({ request }) => {
  const reader = await issueToken(request, ["a2a:execute", "search:read"])
  for (const scopes of [["a2a:execute"], ["search:read"]]) {
    const headers = await issueToken(request, scopes)
    expect((await request.post("/api/a2a/message", { headers, data: envelope("ListTasks") })).status()).toBe(403)
  }
  const forged = await request.post("/api/a2a/message", { headers: { "A2A-Token": "fixture-forged", authorization: "Bearer fixture-forged" }, data: {} })
  expect(forged.status()).toBe(401)
  expect(await forged.text()).not.toContain("fixture-forged")
  for (const [method, params, code] of [
    ["GetTask", { id: "unknown" }, -32001],
    ["CancelTask", { id: "unknown" }, -32001],
    ["SendStreamingMessage", {}, -32004],
    ["CreateTaskPushNotificationConfig", {}, -32003],
    ["Unknown", {}, -32601],
    ["SendMessage", {}, -32602],
    ["SendMessage", { message: { role: "ROLE_USER", messageId: "unsupported", parts: [{ data: { query: "heating", skill: "task-management" } }] } }, -32004],
  ] as const) {
    const response = await request.post("/api/a2a/message", { headers: reader, data: envelope(method, params) })
    expect(await response.json()).toMatchObject({ error: { code } })
  }
  const wrongVersion = await request.post("/api/a2a/message", { headers: { ...reader, "A2A-Version": "0.3" }, data: envelope("ListTasks") })
  expect(await wrongVersion.json()).toMatchObject({ error: { code: -32009 } })
  const tooLarge = await request.post("/api/a2a/message", { headers: reader, data: { padding: "x".repeat(16 * 1024) } })
  expect(tooLarge.status()).toBe(413)
  const invalid = await request.post("/api/a2a/message", { headers: { ...reader, "content-type": "application/json" }, data: Buffer.from("{") })
  expect(await invalid.json()).toMatchObject({ error: { code: -32700 } })
  for (const response of [await request.get("/api/a2a/tasks/unknown", { headers: reader }), await request.post("/api/a2a/tasks/unknown:cancel", { headers: reader, data: {} })]) {
    expect(response.status()).toBe(404)
    expect(await response.json()).not.toHaveProperty("task")
  }
})

test("A2A setting disables discovery and execution", async ({ request }) => {
  const headers = await issueToken(request, ["a2a:execute", "search:read"])
  await request.put("/api/settings", { headers: admin, data: { key: "agent-protocols-a2a-enabled", value: false } })
  try {
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json", "/api/a2a/agent-card"]) expect((await request.get(path)).status()).toBe(404)
    expect((await request.post("/api/a2a/message", { headers, data: envelope("ListTasks") })).status()).toBe(404)
  } finally {
    await request.put("/api/settings", { headers: admin, data: { key: "agent-protocols-a2a-enabled", value: true } })
  }
})

test("MCP discovery inventory matches tools/list", async ({ request }) => {
  const discovery = await request.get("/.well-known/mcp.json")
  expect(discovery.ok()).toBe(true)
  const metadata = await discovery.json()
  const list = await request.post("/api/mcp", { data: envelope("tools/list") })
  expect(list.ok()).toBe(true)
  const tools = (await list.json()).result.tools
  expect(metadata.toolCount).toBe(tools.length)
  expect(metadata.endpoint).toBe("/api/mcp")
  expect(new Set(tools.map((tool: { name: string }) => tool.name)).size).toBe(tools.length)
  for (const tool of tools) {
    expect(tool.name).toMatch(/^[a-zA-Z0-9_]+$/)
    expect(tool.inputSchema.type).toBe("object")
  }
})
