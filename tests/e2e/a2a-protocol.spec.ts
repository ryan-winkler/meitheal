import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type APIRequestContext } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable ingress fixture")

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
const admin = { cookie: "feedback-fixture=admin" }
const envelope = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: "a2a-test", method, params })

let work: string
let child: ReturnType<typeof fork>
let request: APIRequestContext
let origin: string
let ingress: string

test.beforeAll(async ({ playwright }) => {
  work = await mkdtemp(join(tmpdir(), "meitheal-a2a-"))
  const env = { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}` }
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
  child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const [info] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(10_000) }),
    once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
  ])
  origin = `http://127.0.0.1:${info.port}`
  ingress = origin + info.configuredPath
  request = await playwright.request.newContext()
})

test.afterAll(async () => {
  await request?.dispose()
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit")
    child.kill()
    await exited
  }
  if (work) await rm(work, { recursive: true, force: true })
})

async function issueToken(scopes: string[]) {
  const response = await request.post(ingress + "/api/agent-tokens", {
    headers: { ...admin, origin },
    data: { name: "A2A test fixture", scopes },
  })
  expect(response.status()).toBe(201)
  const { token } = await response.json()
  return { authorization: `Bearer ${token}` }
}

async function toggle(enabled: boolean) {
  const response = await request.put(ingress + "/api/settings", {
    headers: { ...admin, origin },
    data: { key: "agent-protocols-a2a-enabled", value: enabled },
  })
  expect(response.ok()).toBe(true)
}

test("discovery aliases advertise a scoped endpoint that returns real task data", async () => {
  const cardResponse = await request.get(ingress + "/.well-known/agent-card.json")
  expect(cardResponse.ok()).toBe(true)
  const card = await cardResponse.json()
  expect(card).toMatchObject({
    name: "Meitheal",
    supportedInterfaces: [{ url: ingress + "/api/a2a/message", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    documentationUrl: ingress + "/openapi.yaml",
    skills: [{ id: "task-search" }, { id: "assigned-tasks" }],
    securitySchemes: { meithealToken: { httpAuthSecurityScheme: { scheme: "Bearer" } } },
    securityRequirements: [{ schemes: { meithealToken: { values: [] } } }],
    capabilities: { streaming: false, pushNotifications: false },
  })
  expect(await (await request.get(ingress + "/.well-known/agent.json")).json()).toEqual(card)
  expect(await (await request.get(ingress + "/api/a2a/agent-card")).json()).toEqual(card)
  const proxied = await request.get(ingress + "/.well-known/agent-card.json", {
    headers: { "X-Forwarded-Proto": "https", "X-Forwarded-Host": "unrelated.example" },
  })
  expect((await proxied.json()).supportedInterfaces[0].url).toBe(ingress.replace("http:", "https:") + "/api/a2a/message")

  const writer = await issueToken(["tasks:write"])
  const reader = await issueToken(["a2a:execute", "search:read"])
  const title = "A2A acceptance fixture for heating"
  const created = await request.post(origin + "/api/tasks", {
    headers: writer,
    data: { title, description: "Do not include task descriptions in search output" },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const endpoint = card.supportedInterfaces[0].url
  const message = { role: "ROLE_USER", messageId: "first", parts: [{ data: { query: "heating" } }] }

  const result = await request.post(endpoint, {
    headers: { ...reader, "A2A-Version": "1.0" },
    data: envelope("SendMessage", { message }),
  })
  expect(result.ok()).toBe(true)
  const json = await result.json()
  expect(json).toMatchObject({
    jsonrpc: "2.0",
    id: "a2a-test",
    result: {
      message: {
        role: "ROLE_AGENT",
        messageId: expect.any(String),
        contextId: expect.any(String),
        parts: [{ data: { tasks: [{ id, title, url: ingress + `/tasks?open=${id}` }] }, mediaType: "application/json" }],
      },
    },
  })
  expect(json.result).not.toHaveProperty("task")
  expect(JSON.stringify(json)).not.toContain("Do not include task descriptions")

  const textResponse = await request.post(endpoint, {
    headers: { ...reader, "A2A-Version": "1.0" },
    data: envelope("SendMessage", {
      message: { ...message, contextId: json.result.message.contextId, parts: [{ text: "heating" }] },
      configuration: { acceptedOutputModes: ["text/plain"] },
    }),
  })
  expect(await textResponse.json()).toMatchObject({
    result: { message: { contextId: json.result.message.contextId, parts: [{ text: expect.stringContaining(title), mediaType: "text/plain" }] } },
  })
})

test("enforces scopes, reports unsupported operations, and disables execution with discovery", async () => {
  const endpoint = ingress + "/api/a2a/message"
  const reader = await issueToken(["a2a:execute", "search:read", "tasks:read"])
  const searchOnlyReader = await issueToken(["a2a:execute", "search:read"])
  const protocolOnly = await issueToken(["a2a:execute"])
  const searchOnly = await issueToken(["search:read"])
  const version = { "A2A-Version": "1.0" }
  const read = { ...reader, ...version }
  const searchRead = { ...searchOnlyReader, ...version }
  const taskQuery = envelope("SendMessage", { message: {
    role: "ROLE_USER", messageId: "invalid-input", parts: [{ data: { query: "heating", skill: "task-management" } }],
  } })

  expect((await request.post(endpoint, { headers: { ...version, "A2A-Token": "forged" }, data: taskQuery })).status()).toBe(401)
  expect((await request.post(endpoint, { headers: { ...protocolOnly, ...version }, data: taskQuery })).status()).toBe(403)
  expect((await request.post(endpoint, { headers: { ...searchOnly, ...version }, data: taskQuery })).status()).toBe(403)
  expect((await request.post(endpoint, { headers: searchRead, data: envelope("GetTask", { id: "does-not-exist" }) })).status()).toBe(403)
  expect((await request.post(endpoint, { headers: searchRead, data: envelope("ListTasks") })).status()).toBe(403)
  expect((await request.get(ingress + "/api/a2a/tasks/missing", { headers: searchRead })).status()).toBe(403)
  expect((await request.get(ingress + "/api/a2a/tasks/missing", { headers: reader })).status()).toBe(400)
  expect((await request.get(ingress + "/api/a2a/tasks/missing")).status()).toBe(401)

  for (const [method, params, code] of [
    ["GetTask", { id: "does-not-exist" }, -32001],
    ["CancelTask", { id: "does-not-exist" }, -32001],
    ["SendStreamingMessage", {}, -32004],
    ["CreateTaskPushNotificationConfig", {}, -32003],
    ["Unknown", {}, -32601],
    ["SendMessage", {}, -32602],
    ["SendMessage", taskQuery.params, -32004],
  ] as const) {
    const response = await request.post(endpoint, { headers: read, data: envelope(method, params) })
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: "a2a-test", error: { code } })
  }
  const wrongVersion = await request.post(endpoint, { headers: reader, data: envelope("ListTasks") })
  expect(await wrongVersion.json()).toMatchObject({ error: { code: -32009 } })
  const list = await request.post(endpoint, { headers: read, data: envelope("ListTasks") })
  expect(await list.json()).toMatchObject({ result: { tasks: [], nextPageToken: "", totalSize: 0 } })
  expect((await request.get(ingress + "/api/a2a/tasks/missing", { headers: read })).status()).toBe(404)

  await toggle(false)
  try {
    for (const route of ["/.well-known/agent-card.json", "/.well-known/agent.json", "/api/a2a/agent-card"]) {
      expect((await request.get(ingress + route)).status()).toBe(404)
    }
    expect((await request.post(endpoint, { headers: read, data: envelope("ListTasks") })).status()).toBe(404)
  } finally {
    await toggle(true)
  }
})

test("an agent reads its assigned household tasks as A2A tasks and cannot cancel them", async () => {
  const endpoint = ingress + "/api/a2a/message"
  const asAdmin = { ...admin, origin }
  const agentResponse = await request.post(ingress + "/api/users/custom", { headers: asAdmin, data: { name: "A2A agent", kind: "agent" } })
  expect(agentResponse.status()).toBe(201)
  const agentBody = await agentResponse.json()
  const assigneeId: string = agentBody.id ?? agentBody.user?.id
  const tokenResponse = await request.post(ingress + "/api/agent-tokens", {
    headers: asAdmin,
    data: { name: "A2A assignee", scopes: ["a2a:execute", "search:read", "tasks:read"], assigneeId },
  })
  expect(tokenResponse.status()).toBe(201)
  const agent = { authorization: `Bearer ${(await tokenResponse.json()).token}`, "A2A-Version": "1.0" }
  const unlinked = { ...await issueToken(["a2a:execute", "search:read", "tasks:read"]), "A2A-Version": "1.0" }
  const noRead = { ...await issueToken(["a2a:execute", "search:read"]), "A2A-Version": "1.0" }

  const create = async (data: Record<string, unknown>) => {
    const response = await request.post(ingress + "/api/tasks", { headers: asAdmin, data })
    expect(response.status()).toBe(201)
    return await response.json()
  }
  const mine = await create({ title: "Descale the kettle", assigned_to: assigneeId, status: "active" })
  const done = await create({ title: "Order filters", assigned_to: assigneeId, status: "complete" })
  const other = await create({ title: "Someone else's task" })
  const call = async (headers: Record<string, string>, method: string, params?: unknown) =>
    await (await request.post(endpoint, { headers, data: envelope(method, params) })).json()

  const list = await call(agent, "ListTasks", { includeArtifacts: true })
  expect(list.result).toMatchObject({ totalSize: 1, nextPageToken: "", tasks: [{
    id: mine.id,
    contextId: mine.id,
    status: { state: "TASK_STATE_WORKING" },
    artifacts: [{ parts: [{ mediaType: "application/json", data: {
      id: mine.id, title: "Descale the kettle", assigned_to: assigneeId, url: ingress + `/tasks?open=${mine.id}`,
    } }] }],
  }] })
  expect((await call(agent, "ListTasks")).result.tasks[0]).not.toHaveProperty("artifacts")
  expect((await call(agent, "ListTasks", { status: "TASK_STATE_COMPLETED" })).result.tasks.map((task: { id: string }) => task.id)).toEqual([done.id])
  expect((await call(agent, "ListTasks", { pageToken: "not-a-page" })).error.code).toBe(-32602)
  // Without a linked assignee there is no "my tasks"; without tasks:read reads are denied with 403.
  expect((await call(unlinked, "ListTasks")).result).toMatchObject({ tasks: [], totalSize: 0 })
  expect((await request.post(endpoint, { headers: noRead, data: envelope("ListTasks") })).status()).toBe(403)

  expect((await call(agent, "GetTask", { id: other.id })).result).toMatchObject({ id: other.id, status: { state: expect.stringMatching(/^TASK_STATE_/) } })
  expect((await request.post(endpoint, { headers: noRead, data: envelope("GetTask", { id: mine.id }) })).status()).toBe(403)
  expect((await call(agent, "CancelTask", { id: mine.id })).error.code).toBe(-32002)
  const unchanged = await (await request.get(ingress + `/api/tasks/${mine.id}`, { headers: admin })).json()
  expect(unchanged.status).toBe(mine.status)

  const rest = await request.get(ingress + `/api/a2a/tasks/${mine.id}`, { headers: agent })
  expect(rest.status()).toBe(200)
  expect(await rest.json()).toMatchObject({ id: mine.id, status: { state: "TASK_STATE_WORKING" } })
  expect((await request.get(ingress + `/api/a2a/tasks/${mine.id}`, { headers: noRead })).status()).toBe(403)
  expect((await request.post(ingress + `/api/a2a/tasks/${mine.id}`, { headers: agent, data: {} })).status()).toBe(404)
})
