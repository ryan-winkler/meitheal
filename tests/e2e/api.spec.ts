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
