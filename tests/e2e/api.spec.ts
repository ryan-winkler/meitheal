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
