import { expect, test, type APIRequestContext } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for disposable local API/browser acceptance")

test.describe.configure({ mode: "serial" })
const admin = { "x-hass-is-admin": "true", "x-hass-user-id": "truthfulness-local-test" }
async function setting(request: APIRequestContext, key: string, value: unknown) {
  const response = await request.put("/api/settings", { headers: admin, data: { key, value } })
  expect(response.ok(), await response.text()).toBe(true)
}

test("disabled MCP blocks discovery, initialize, list and calls; A2A exposes only scoped search", async ({ request }) => {
  await setting(request, "agent-protocols-mcp-enabled", false)
  try {
    expect((await request.get("/.well-known/mcp.json")).status()).toBe(404)
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      expect((await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: "test", method, params: { name: "completeTask", arguments: { id: "missing" } } } })).status()).toBe(404)
    }
  } finally { await setting(request, "agent-protocols-mcp-enabled", true) }
  expect((await request.get("/.well-known/mcp.json")).ok()).toBe(true)
  await setting(request, "agent-protocols-a2a-enabled", false)
  try {
    expect((await request.get("/api/a2a/agent-card")).status()).toBe(404)
    expect((await request.post("/api/a2a/message", { data: { message: {} } })).status()).toBe(404)
  } finally { await setting(request, "agent-protocols-a2a-enabled", true) }
  const card = await request.get("/api/a2a/agent-card")
  expect(card.status()).toBe(200)
  expect((await card.json()).skills.map((skill: { id: string }) => skill.id)).toEqual(["task-search"])
  expect((await request.post("/api/a2a/message", { data: { message: {} } })).status()).toBe(401)
  expect((await request.get("/api/a2a/tasks/unknown")).status()).toBe(404)
})

test("NFC assignment completes unique tasks, rejects unknown and ambiguous tags, retries idempotently", async ({ request }) => {
  await setting(request, "feature_nfc", true)
  const tag = `test-${crypto.randomUUID()}`
  const ids: string[] = []
  try {
    for (const title of ["NFC fixture one", "NFC fixture two"]) {
      const response = await request.post("/api/tasks", { data: { title } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    expect((await request.put(`/api/tasks/${ids[0]}`, { data: { nfc_tag_id: tag } })).ok()).toBe(true)
    await expect((await request.get(`/api/tasks/${ids[0]}`)).json()).resolves.toMatchObject({ nfc_tag_id: tag })
    const first = await request.post("/api/nfc/complete", { data: { tag_id: tag } })
    expect(first.status(), await first.text()).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true, task_id: ids[0] })
    expect(await (await request.get(`/api/tasks/${ids[0]}`)).json()).toMatchObject({ status: "complete" })
    expect(await (await request.post("/api/nfc/complete", { data: { tag_id: tag } })).json()).toMatchObject({ already_complete: true })
    await request.put(`/api/tasks/${ids[1]}`, { data: { nfc_tag_id: tag } })
    expect((await request.post("/api/nfc/complete", { data: { tag_id: tag } })).status()).toBe(409)
    expect((await request.post("/api/nfc/complete", { data: { tag_id: "unassigned" } })).status()).toBe(404)
    expect((await request.put(`/api/tasks/${ids[1]}`, { data: { nfc_tag_id: "" } })).status()).toBe(400)
  } finally { for (const id of ids) await request.delete(`/api/tasks/${id}`) }
})

test("goal percentage survives round trip and invalid percentages cannot overwrite it", async ({ request }) => {
  const response = await request.post("/api/goals", { data: { title: "Progress fixture" } })
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  try {
    expect((await request.put(`/api/goals/${id}`, { data: { progress: 37.5 } })).status()).toBe(200)
    expect(await (await request.get(`/api/goals/${id}`)).json()).toMatchObject({ progress: 37.5, metric_type: "percentage", metric_target: 100, metric_current: 37.5 })
    for (const progress of [-1, 101, "50"]) expect((await request.put(`/api/goals/${id}`, { data: { progress } })).status()).toBe(400)
    expect(await (await request.get(`/api/goals/${id}`)).json()).toMatchObject({ progress: 37.5 })
  } finally { await request.delete(`/api/goals/${id}`) }
})

test("manual calendar routes fail honestly without HA and MCP does not complete missing tasks", async ({ request }) => {
  for (const route of ["/api/integrations/calendar/sync", "/api/ha/calendars"]) {
    const response = await request.post(route, { data: { action: "sync", entity_id: "calendar.fixture" } })
    expect(response.status()).toBe(502)
    expect(await response.json()).toMatchObject({ ok: false })
  }
  const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: "completion", method: "tools/call", params: { name: "completeTask", arguments: { id: "nonexistent-task" } } } })
  const body = await response.json()
  expect(body.result.isError).toBe(true)
  expect(JSON.parse(body.result.content[0].text)).toHaveProperty("error")
})


test("canonical task completion records once and legacy celebration cannot increment counts", async ({ request }) => {
  await setting(request, "feature_gamification", true)
  const before = (await (await request.get("/api/gamification")).json()).stats.totalCompleted
  const created = await request.post("/api/tasks", { data: { title: "Completion accounting fixture", priority: 2 } })
  const { id } = await created.json()
  try {
    const completed = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
    expect(completed.ok()).toBe(true)
    expect(await completed.json()).toHaveProperty("gamification.stats")
    expect((await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })).ok()).toBe(true)
    expect((await request.post("/api/gamification", { data: { priority: 2 } })).status()).toBe(410)
    const after = (await (await request.get("/api/gamification")).json()).stats.totalCompleted
    expect(after).toBe(before + 1)
  } finally { await request.delete(`/api/tasks/${id}`) }
})

test("MCP title and ID completion preserve denied underlying mutation results", async ({ request }) => {
  await setting(request, "agent-protocols-mcp-enabled", true)
  const title = `Scope fixture ${crypto.randomUUID()}`
  const { id } = await (await request.post("/api/tasks", { data: { title } })).json()
  const tokenResponse = await request.post("/api/agent-tokens", { headers: admin, data: { name: "local MCP read-only regression", scopes: ["mcp:execute", "tasks:read", "search:read"] } })
  expect(tokenResponse.status()).toBe(201)
  const token = await tokenResponse.json()
  try {
    for (const args of [{ id }, { title }]) {
      const response = await request.post("/api/mcp", {
        headers: { authorization: `Bearer ${token.token}` },
        data: { jsonrpc: "2.0", id: "denied", method: "tools/call", params: { name: "completeTask", arguments: args } },
      })
      const body = await response.json()
      expect(body.result.isError).toBe(true)
      expect(JSON.parse(body.result.content[0].text).error).toContain("403")
    }
    const creation = await request.post("/api/mcp", {
      headers: { authorization: `Bearer ${token.token}` },
      data: { jsonrpc: "2.0", id: "denied-create", method: "tools/call", params: { name: "createTask", arguments: { title: "Must not be created" } } },
    })
    const creationResult = (await creation.json()).result
    expect(creationResult.isError).toBe(true)
    expect(JSON.parse(creationResult.content[0].text).error).toContain("403")
    expect((await (await request.get(`/api/tasks/${id}`)).json()).status).toBe("pending")
  } finally {
    await request.delete(`/api/tasks/${id}`)
    await request.delete("/api/agent-tokens", { headers: admin, data: { id: token.id, hard: true } })
  }
})

test("MCP canonical creation retains priority, due date and description", async ({ request }) => {
  await setting(request, "agent-protocols-mcp-enabled", true)
  const response = await request.post("/api/mcp", { data: { jsonrpc: "2.0", id: "create", method: "tools/call", params: { name: "createTask", arguments: { title: "MCP canonical create fixture", priority: 1, due_date: "2027-02-01", description: "Preserved description" } } } })
  const body = await response.json()
  expect(body.result.isError).toBe(false)
  const task = JSON.parse(body.result.content[0].text)
  try { expect(task).toMatchObject({ priority: 1, due_date: "2027-02-01", description: "Preserved description" }) }
  finally { if (task.id) await request.delete(`/api/tasks/${task.id}`) }
})


test("canonical task reads retain persisted urgency, importance and effort metadata", async ({ request }) => {
  const response = await request.post("/api/tasks", { data: {
    title: "Eisenhower read roundtrip fixture", urgency: 0, importance: 5,
    effort_minutes: 45, effort_type: "deep", blocked_by: "Waiting for a household decision",
  } })
  expect(response.status()).toBe(201)
  const created = await response.json()
  const detail = await (await request.get(`/api/tasks/${created.id}`)).json()
  const listed = (await (await request.get(`/api/tasks?search=${encodeURIComponent(created.title)}`)).json()).tasks.find((task: { id: string }) => task.id === created.id)
  for (const result of [detail, listed]) {
    expect(result).toMatchObject({ urgency: 0, importance: 5 })
  }
  expect(detail.effort_minutes).toBe(created.effort_minutes)
})
