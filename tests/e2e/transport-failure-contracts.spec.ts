import { expect, test, type APIRequestContext } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

const admin = { "x-hass-is-admin": "true", "x-hass-user-id": "transport-contract-fixture" }
test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.218" } })
test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro server")

async function token(request: APIRequestContext, scopes: string[]) {
  const response = await request.post("/api/agent-tokens", { headers: admin, data: { name: "Transport contract fixture", scopes } })
  expect(response.status()).toBe(201)
  const value = await response.json()
  return { id: value.id as string, headers: { authorization: `Bearer ${value.token}` } }
}

async function removeToken(request: APIRequestContext, id: string) {
  await request.delete("/api/agent-tokens", { headers: { ...admin, origin: process.env.E2E_BASE_URL! }, data: { id, hard: true } })
}

test("read-only and mixed-identity proposal credentials cannot reset or import settings", async ({ request }) => {
  const reader = await token(request, ["settings:read"])
  const proposer = await token(request, ["tasks:propose"])
  const key = `transport_fixture_${crypto.randomUUID().replaceAll("-", "")}`
  await request.put("/api/settings", { data: { key, value: "retained" } })
  try {
    const reset = await request.delete("/api/settings?reset=all", { headers: { ...reader.headers, origin: process.env.E2E_BASE_URL! } })
    expect(reset.status()).toBe(403)
    const imported = await request.post("/api/import/settings", { headers: { ...admin, ...proposer.headers }, data: { theme: "light" } })
    expect(imported.status()).toBe(403)
    expect((await request.post("/api/features", { headers: { ...admin, ...proposer.headers }, data: {} })).status()).toBe(403)
    expect((await request.post("/api/not-an-authorized-route", { headers: proposer.headers, data: {} })).status()).toBe(403)
    expect((await (await request.get(`/api/settings?key=${key}`)).json()).value).toBe("retained")
  } finally { await removeToken(request, reader.id); await removeToken(request, proposer.id) }
})

test("MCP search and composite reads expose denied underlying reads as errors", async ({ request }) => {
  const caller = await token(request, ["mcp:execute"])
  try {
    for (const name of ["searchTasks", "dailyBriefing"]) {
      const response = await request.post("/api/mcp", { headers: caller.headers, data: { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: { query: "denied fixture" } } } })
      const result = await response.json()
      expect(result.result.isError).toBe(true)
      expect(result.result.content[0].text).toContain("403")
    }
  } finally { await removeToken(request, caller.id) }
})

test("MCP acknowledges native empty DELETE success without inventing failure", async ({ request }) => {
  const created = await (await request.post("/api/tasks", { data: { title: "Empty DELETE contract fixture" } })).json()
  const caller = await token(request, ["mcp:execute", "tasks:delete"])
  try {
    const response = await request.post("/api/mcp", { headers: caller.headers, data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "deleteTask", arguments: { id: created.id } } } })
    const result = (await response.json()).result
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: 204, ok: true })
    expect((await request.get(`/api/tasks/${created.id}`)).status()).toBe(404)
  } finally { await removeToken(request, caller.id) }
})

test("generated MCP partial-update and reorder contracts match native requests", async ({ request }) => {
  const listing = await (await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json()
  const tools = listing.result.tools as Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, unknown> } }>
  expect(tools.find(tool => tool.name === "updateTask")!.inputSchema.required).toEqual(["id"])
  expect(tools.find(tool => tool.name === "reorderTasks")!.inputSchema).toMatchObject({ required: ["ordered_ids"], properties: { ordered_ids: { type: "array" } } })
  const created = await (await request.post("/api/tasks", { data: { title: "Partial mutation contract fixture" } })).json()
  try {
    for (const [name, args] of [["updateTask", { id: created.id, nfc_tag_id: `contract-${created.id}` }], ["reorderTasks", { ordered_ids: [created.id] }]] as const) {
      const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } } })
      expect((await response.json()).result.isError).toBe(false)
    }
    expect((await (await request.get(`/api/tasks/${created.id}`)).json()).nfc_tag_id).toBe(`contract-${created.id}`)
  } finally { await request.delete(`/api/tasks/${created.id}`, { headers: { origin: process.env.E2E_BASE_URL! } }) }
})


test("project read credentials do not authorize project writes", async ({ request }) => {
  const reader = await token(request, ["projects:read"])
  try {
    expect((await request.post("/api/projects", { headers: reader.headers, data: {} })).status()).toBe(403)
  } finally { await removeToken(request, reader.id) }
})


test("imported string preferences retain the settings repository serialization contract", async ({ request }) => {
  const previous = await (await request.get("/api/settings?key=date_format")).json()
  try {
    const imported = await request.post("/api/import/settings", { headers: admin, data: { _version: 2, settings: { date_format: "yyyy-MM-dd" } } })
    expect(imported.status()).toBe(200)
    expect((await (await request.get("/api/settings?key=date_format")).json()).value).toBe("yyyy-MM-dd")
    expect((await (await request.get("/api/settings")).json()).date_format).toBe("yyyy-MM-dd")
  } finally { await request.put("/api/settings", { data: { key: "date_format", value: previous.value } }) }
})


test("description limits reject oversized writes without silently discarding content", async ({ request }) => {
  const description = "Heating maintenance notes. ".repeat(400)
  expect(description.length).toBeGreaterThan(10000)
  expect((await request.post("/api/tasks", { data: { title: "Description boundary fixture", description } })).status()).toBe(400)
  const created = await (await request.post("/api/tasks", { data: { title: "Retained description fixture", description: "Keep this text" } })).json()
  try {
    expect((await request.put(`/api/tasks/${created.id}`, { data: { description } })).status()).toBe(400)
    expect((await (await request.get(`/api/tasks/${created.id}`)).json()).description).toBe("Keep this text")
  } finally { await request.delete(`/api/tasks/${created.id}`, { headers: { origin: process.env.E2E_BASE_URL! } }) }
})


test("MCP search honors its discovered q contract and query compatibility alias", async ({ request }) => {
  const listing = await (await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json()
  const search = listing.result.tools.find((tool: { name: string }) => tool.name === "searchTasks")
  expect(search.inputSchema.required).toContain("q")
  expect(search.inputSchema.properties.scope.enum).toEqual(["tasks"])
  const prefix = `MCPSearch${crypto.randomUUID().replaceAll("-", "")}`
  const titles = [`${prefix} heating maintenance`, `${prefix} garden maintenance`]
  const created = [] as Array<{ id: string }>
  try {
    for (const title of titles) created.push(await (await request.post("/api/tasks", { data: { title, description: `${prefix} privateboundary` } })).json())
    for (const key of ["q", "query"]) {
      const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: key, method: "tools/call", params: { name: "searchTasks", arguments: { [key]: `${prefix} heating`, limit: 1 } } } })
      const result = (await response.json()).result
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content[0].text)).toMatchObject({ count: 1, tasks: [{ id: created[0]!.id, title: titles[0] }] })
    }
    expect(search.inputSchema.properties.task_fields).toBeDefined()
    for (const [task_fields, count] of [["title", 0], ["description", 1]] as const) {
      const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: task_fields, method: "tools/call", params: { name: "searchTasks", arguments: { q: `${prefix} privateboundary`, task_fields, limit: 1 } } } })
      const result = (await response.json()).result
      expect(result.isError).toBe(false)
      expect(JSON.parse(result.content[0].text).count).toBe(count)
    }
  } finally {
    for (const task of created) await request.delete(`/api/tasks/${task.id}`, { headers: { origin: process.env.E2E_BASE_URL! } })
  }
})


test("unsupported entity-state helper is absent from discovery and rejects calls explicitly", async ({ request }) => {
  const listing = await (await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json()
  expect(listing.result.tools.some((tool: { name: string }) => tool.name === "getEntityState")).toBe(false)
  const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "getEntityState", arguments: { entity_id: "sensor.temperature" } } } })
  const result = (await response.json()).result
  expect(result.isError).toBe(true)
  expect(result.content[0].text).toContain("Unknown tool")
})


test("published calendar action and task-list sort contracts execute native request shapes", async ({ request }) => {
  const listing = await (await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).json()
  const tools = listing.result.tools as Array<{ name: string; inputSchema: { required?: string[]; properties: Record<string, { enum?: string[] }> } }>
  const calendar = tools.find(tool => tool.name === "syncCalendar")!
  expect(calendar.inputSchema.required).toContain("action")
  expect(calendar.inputSchema.properties.action!.enum).toEqual(["sync", "enable", "disable"])
  const taskList = tools.find(tool => tool.name === "listTasks")!
  expect(taskList.inputSchema.properties.sort!.enum).toContain("updated_at")
  expect(taskList.inputSchema.properties.sort!.enum).not.toContain("updated")
  const prefix = `SortContract${crypto.randomUUID().replaceAll("-", "")}`
  const created: Array<{ id: string }> = []
  try {
    for (const suffix of ["Zulu", "Alpha"]) created.push(await (await request.post("/api/tasks", { data: { title: `${prefix} ${suffix}` } })).json())
    const list = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "listTasks", arguments: { sort: "title", order: "asc", limit: 500 } } } })
    const listResult = (await list.json()).result
    expect(listResult.isError).toBe(false)
    const page = JSON.parse(listResult.content[0].text)
    expect(page).toMatchObject({ total: expect.any(Number), limit: 500, offset: 0 })
    expect(page.tasks.filter((task: { title: string }) => task.title.startsWith(prefix)).map((task: { id: string }) => task.id)).toEqual([created[1]!.id, created[0]!.id])
    const disabled = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "syncCalendar", arguments: { action: "disable" } } } })
    expect((await disabled.json()).result.isError).toBe(false)
  } finally {
    for (const task of created) await request.delete(`/api/tasks/${task.id}`, { headers: { origin: process.env.E2E_BASE_URL! } })
  }
})


test("official HA member identity cannot write household settings or inherit legacy admin claims", async ({ request }) => {
  const member = { "x-remote-user-id": "household-member", "x-remote-user-groups": "system-users", "x-hass-is-admin": "true" }
  expect((await request.put("/api/settings", { headers: member, data: { key: "transport_household_probe", value: "denied" } })).status()).toBe(403)
  expect((await request.post("/api/agent-tokens", { headers: member, data: { name: "Denied member", scopes: ["tasks:read"] } })).status()).toBe(403)
  const owner = await request.post("/api/agent-tokens", { headers: { "x-remote-user-id": "owner", "x-remote-user-groups": "system-admin" }, data: { name: "Official owner fixture", scopes: ["tasks:read"] } })
  expect(owner.status()).toBe(201)
  await removeToken(request, (await owner.json()).id)
})
