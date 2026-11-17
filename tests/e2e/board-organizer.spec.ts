import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built app")

test("Household Groups organize capture and Projects inside the Board", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const name = "Workshop " + crypto.randomUUID().slice(0, 6)

  await page.goto("/boards/household?view=groups")
  await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible()
  await page.getByText("New group", { exact: true }).click()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name)
  await page.getByRole("button", { name: "Create group", exact: true }).click()
  await expect(page).toHaveURL(/\/boards\/household\?area=/)
  const groupId = new URL(page.url()).searchParams.get("area")!
  await page.getByRole("tab", { name: /Tasks/ }).click()
  const taskPanel = page.getByRole("tabpanel", { name: /Tasks/ })
  await taskPanel.getByText("New task", { exact: true }).click()
  await taskPanel.getByRole("textbox", { name: "Title" }).fill("Replace workshop light")
  await taskPanel.getByRole("button", { name: "Create task" }).click()
  await expect(taskPanel.getByRole("link", { name: "Replace workshop light" })).toBeVisible()

  const projectResponse = await request.post("/api/projects", {
    headers, data: { title: "Improve lighting", area_id: groupId },
  })
  expect(projectResponse.status()).toBe(201)
  const project = await projectResponse.json()
  const capture = await request.post("/api/tasks", {
    headers, data: { title: "Fit dimmer", placement: { projectId: project.id } },
  })
  expect(capture.status()).toBe(201)
  const saved = await capture.json()
  expect(saved).toMatchObject({ title: "Fit dimmer", area_id: groupId, project_id: project.id })
  expect((await request.post("/api/tasks", {
    headers, data: { title: "Invalid placement", placement: { areaId: "missing" } },
  })).status()).toBe(404)

  await page.goto(`/boards/household?project=${project.id}#tasks`)
  await expect(page.getByText("Fit dimmer", { exact: true })).toBeVisible()
  await page.goto(`/boards/household?project=${project.id}&from=${groupId}#tasks`)
  await expect(page.getByRole("link", { name: "← " + name, exact: true })).toHaveAttribute("href", `/boards/household?area=${groupId}`)
  await expect(page.locator('#sidebar [data-page="boards"]')).toBeVisible()
  await expect(page.locator('#sidebar [data-page="areas"]')).toHaveCount(0)
})
