import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for disposable local API/browser acceptance")

test.use({ extraHTTPHeaders: { "x-forwarded-for": "198.51.100.215" } })

test("Today celebrates the acknowledged completion result without another counter write", async ({ page, request }) => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for local browser checks")
  const headers = { "x-hass-is-admin": "true", "x-hass-user-id": "completion-feedback-regression" }
  expect((await request.put("/api/settings", { headers, data: { key: "feature_gamification", value: true } })).ok()).toBe(true)
  const title = `Completion feedback ${crypto.randomUUID()}`
  const created = await request.post("/api/tasks", { data: { title, priority: 2, due_date: new Date().toISOString().slice(0, 10) } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  try {
    const before = (await (await request.get("/api/gamification")).json()).stats.totalCompleted
    await page.goto("/today")
    const checkbox = page.locator(`.tli__checkbox[data-id="${id}"]`)
    await expect(checkbox).toBeVisible()
    const counterRequests: string[] = []
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/gamification") counterRequests.push(request.method())
    })
    // Exercise the real mutation once, then supply a deterministic newly-earned
    // achievement fixture in that response to test its presentation boundary.
    await page.route(`**/api/tasks/${id}`, async route => {
      const response = await route.fetch()
      if (route.request().method() !== "PUT") return route.fulfill({ response })
      const body = await response.json()
      if (body.gamification) body.gamification.newAchievements = [{ icon: "🏆", name: "Completion response fixture" }]
      await route.fulfill({ response, json: body })
    })
    await checkbox.check()
    await expect(page.locator("#toast-container").first()).toContainText("+40 XP")
    await expect(page.locator("#toast-container").first()).toContainText("Achievement: Completion response fixture")
    expect(counterRequests).toEqual([])
    const after = (await (await request.get("/api/gamification")).json()).stats.totalCompleted
    expect(after).toBe(before + 1)
    const repeated = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
    expect(await repeated.json()).not.toHaveProperty("gamification")
    expect((await (await request.get("/api/gamification")).json()).stats.totalCompleted).toBe(after)
  } finally { await request.delete(`/api/tasks/${id}`) }
})

test("Kanban celebrates an acknowledged transition and rejects failed moves without earned feedback", async ({ page, request }) => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for local browser checks")
  const ids: string[] = []
  try {
    for (let index = 0; index < 2; index++) {
      const response = await request.post("/api/tasks", { data: { title: `Kanban completion feedback ${crypto.randomUUID()}`, priority: 2 } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    await page.goto("/tasks#kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const counterRequests: string[] = []
    page.on("request", request => {
      if (new URL(request.url()).pathname === "/api/gamification") counterRequests.push(request.method())
    })
    const drop = async (id: string) => page.locator('.kanban-column[data-status="complete"]').evaluate((column, taskId) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData("text/plain", taskId)
      column.dispatchEvent(new DragEvent("drop", { dataTransfer, bubbles: true, cancelable: true }))
    }, id)
    await expect(page.locator(`.kanban-card[data-id="${ids[0]}"]`).first()).toBeVisible()
    await drop(ids[0]!)
    await expect(page.locator("#toast-container").first()).toContainText("+40 XP")
    expect((await (await request.get(`/api/tasks/${ids[0]}`)).json()).status).toBe("complete")
    expect(counterRequests).toEqual([])

    await page.locator("#toast-container").first().evaluate(element => element.replaceChildren())
    await page.locator(".kanban-contextual-toast").evaluateAll(elements => elements.forEach(element => element.remove()))
    await page.route(`**/api/tasks/${ids[1]}`, route => route.fulfill({ status: 503, json: { error: "Fixture failed move" } }))
    await drop(ids[1]!)
    await expect(page.getByText("Failed to move task — reverting", { exact: true })).toBeVisible()
    await expect(page.locator("#toast-container").first()).not.toContainText("XP")
    await expect(page.locator(".kanban-contextual-toast.success")).toHaveCount(0)
    expect((await (await request.get(`/api/tasks/${ids[1]}`)).json()).status).toBe("pending")
    expect(counterRequests).toEqual([])
  } finally { for (const id of ids) await request.delete(`/api/tasks/${id}`) }
})
