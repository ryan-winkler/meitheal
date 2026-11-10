import { expect, test } from "@playwright/test"

test.skip(!process.env.E2E_BASE_URL, "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

test("To-do selection hydrates JSON arrays and legacy single entity IDs", async ({ page }) => {
  let saved: unknown = '["todo.shopping","todo.household"]'
  await page.route("**/api/settings", async route => {
    if (route.request().method() !== "GET") return route.continue()
    const response = await route.fetch()
    return route.fulfill({ response, json: { ...await response.json(), todo_entities: saved } })
  })
  await page.route("**/api/todo", route => route.fulfill({ json: { ok: true, entities: [
    { entity_id: "todo.shopping", friendly_name: "Shopping", state: "2", sync: null },
    { entity_id: "todo.household", friendly_name: "Household", state: "1", sync: null },
  ] } }))
  await page.goto("/settings#integrations-settings")
  await expect(page.locator('.todo-entity-toggle:checked')).toHaveCount(2)
  saved = "todo.household"
  await page.reload()
  await expect(page.locator('.todo-entity-toggle:checked')).toHaveCount(1)
  await expect(page.locator('.todo-entity-toggle[value="todo.household"]')).toBeChecked()
})

test("Task AI handoff explains an invalid saved URL without opening a provider", async ({ page, request }) => {
  const created = await request.post("/api/tasks", { data: { title: "Invalid AI URL fixture" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  let opens = 0
  page.on("popup", () => opens++)
  await page.route("**/api/ha/assist", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }))
  await page.route("**/api/settings?key=ai-provider", route => route.fulfill({ json: { value: "custom" } }))
  await page.route("**/api/settings?key=ai-custom-url", route => route.fulfill({ json: { value: "javascript:alert(1)" } }))
  try {
    await page.goto(`/tickets/${id}`)
    await expect(page.locator("#td-title")).toHaveValue("Invalid AI URL fixture")
    await page.locator("#td-ask-ai").click()
    await expect(page.getByText("The saved AI URL is invalid. Open Settings → Automation & AI to correct it.", { exact: true })).toBeVisible()
    expect(opens).toBe(0)
  } finally {
    expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204)
  }
})
