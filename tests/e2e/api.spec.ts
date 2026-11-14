import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run API endpoint checks")

test("well-known API contract exists", async ({ request, baseURL }) => {
  const response = await request.get(`${baseURL}/.well-known/jsondoc.json`)
  expect(response.ok()).toBeTruthy()
  expect(response.headers()["content-type"]).toContain("application/json")
  const contract = await response.json()
  expect(contract.openapi).toBe("3.1.0")
  expect(contract.paths["/api/tasks"].get.operationId).toBe("listTasks")
  expect(contract.paths["/api/tasks/create"].post.operationId).toBe("createTask")
  const ingressDocument = "https://ha.example.test/api/hassio_ingress/fixture/.well-known/jsondoc.json"
  expect(new URL(contract.servers[0].url, ingressDocument).pathname).toBe("/api/hassio_ingress/fixture/")
})

test("automation instructions appear in the saved task description", async ({ request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const description = "Check the indicator before closing the cover."
  for (const details of [
    { description: `<script>ignored()</script>${description}`, frameworkPayload: { description: "A separate calendar note" } },
    { frameworkPayload: { description: `<script>ignored()</script>${description}` } },
  ]) {
    const created = await request.post("/api/tasks/create", { headers, data: { title: "Inspect the air filter", ...details } })
    expect(created.status()).toBe(201)
    const { task } = await created.json()
    const path = `/api/tasks/${task.id}`
    try {
      const saved = await request.get(path)
      expect(saved.status()).toBe(200)
      expect(await saved.json()).toMatchObject({ description })
    } finally {
      await request.delete(path, { headers })
    }
  }
})

test("task labels are accepted as an array or as a JSON string", async ({ request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const created = await request.post("/api/tasks", { headers, data: { title: "Replace the porch bulb", labels: ["repair", "garage"] } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const path = `/api/tasks/${id}`
  try {
    expect(JSON.parse((await (await request.get(path)).json()).labels)).toEqual(["repair", "garage"])

    const asArray = await request.put(path, { headers, data: { labels: ["outdoor"] } })
    expect(asArray.status()).toBe(200)
    expect(JSON.parse((await (await request.get(path)).json()).labels)).toEqual(["outdoor"])

    const asString = await request.put(path, { headers, data: { labels: JSON.stringify(["outdoor", "lighting"]) } })
    expect(asString.status()).toBe(200)
    expect(JSON.parse((await (await request.get(path)).json()).labels)).toEqual(["outdoor", "lighting"])

    for (const labels of [[1, 2], "repair", { name: "repair" }]) {
      const rejected = await request.put(path, { headers, data: { labels } })
      expect(rejected.status(), `labels ${JSON.stringify(labels)}`).toBe(400)
    }
  } finally {
    await request.delete(path, { headers })
  }
})

test("an unknown API path answers with JSON, not the HTML page", async ({ request }) => {
  const response = await request.get("/api/this-route-does-not-exist")
  expect(response.status()).toBe(404)
  expect(response.headers()["content-type"]).toContain("application/problem+json")
  expect(await response.json()).toMatchObject({ status: 404, error: expect.any(String) })
})

test("time, comments and links read back with the ticket key they were written with", async ({ request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const ids: string[] = []
  try {
    for (const title of ["Ticket key reader", "Ticket key link target"]) {
      const created = await request.post("/api/tasks", { headers, data: { title } })
      expect(created.status()).toBe(201)
      ids.push((await created.json()).id)
    }
    const key = (await (await request.get(`/api/tasks/${ids[0]}`)).json()).ticket_key as string
    expect(key).toMatch(/^[A-Z]+-\d+$/)

    expect((await request.post(`/api/tasks/${key}/time`, { headers, data: { action: "start" } })).ok()).toBe(true)
    expect((await (await request.get(`/api/tasks/${key}/time`)).json()).entries).toHaveLength(1)

    expect((await request.post(`/api/tasks/${key}/comments`, { headers, data: { content: "Written with the ticket key" } })).ok()).toBe(true)
    const { comments } = await (await request.get(`/api/tasks/${key}/comments`)).json()
    expect(comments.map((comment: { content: string }) => comment.content)).toContain("Written with the ticket key")

    const linked = await request.post(`/api/tasks/${key}/links`, { headers, data: { target_task_id: ids[1], link_type: "related_to" } })
    expect(linked.ok(), await linked.text()).toBe(true)
    expect((await (await request.get(`/api/tasks/${key}/links`)).json()).outbound).toHaveLength(1)
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})
