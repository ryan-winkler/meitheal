import { expect, test } from "@playwright/test"

import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro server")
test.use({ serviceWorkers: "block", extraHTTPHeaders: { "x-forwarded-for": "198.51.100.219" } })

test("Canonical calendar/timeline and Eisenhower completion paths", async ({ page, request }) => {
  const today = new Date().toISOString().slice(0, 10)
  const ids: string[] = []
  const create = async (title: string, extra = {}) => {
    const response = await request.post("/api/tasks", { data: { title, due_date: today, start_date: today, end_date: today, ...extra } })
    expect(response.status()).toBe(201)
    const task = await response.json()
    ids.push(task.id)
    return task.id
  }
  const complete = await create("CI canonical completed fixture")
  const active = await create("CI canonical active fixture")
  const review = await create("CI canonical weekly review fixture", { urgency: 1, importance: 1 })
  await request.put(`/api/tasks/${complete}`, { data: { status: "complete" } })
  await request.put(`/api/tasks/${active}`, { data: { status: "active" } })
  try {
    await page.route("**/api/ha/events?**", route => route.fulfill({ json: { ok: true, events: [] } }))
    await page.goto("/tasks#calendar")
    await page.locator(`.cal-cell[data-date="${today}"]`).click()
    await expect(page.locator(`#day-drawer-tasks [data-task-id="${complete}"] .day-drawer-item-icon`)).toHaveText("✅")
    await expect(page.locator(`#day-drawer-tasks [data-task-id="${active}"] .day-drawer-item-icon`)).toHaveText("🔵")
    await page.goto("/tasks#timeline")
    await expect(page.locator(".gantt-sidebar-row--complete").filter({ hasText: "CI canonical completed fixture" })).toBeVisible()
    await page.goto("/eisenhower")
    await expect(page.locator(`[data-drop-zone="not-now"] .tli[data-id="${review}"]`)).toBeVisible()
    const statuses: string[] = []
    page.on("request", req => {
      if (req.method() === "PUT" && new URL(req.url()).pathname === `/api/tasks/${review}`) {
        const status = req.postDataJSON()?.status
        if (status) statuses.push(status)
      }
    })
    await page.evaluate(() => {
      document.dispatchEvent(new Event("astro:page-load"))
      document.dispatchEvent(new Event("astro:page-load"))
    })
    await page.locator('[data-action="start-review"]').click()
    await expect(page.locator("#review-overlay")).toBeVisible()
    await page.locator('[data-action="review-archive"]').click()
    await expect.poll(async () => (await (await request.get(`/api/tasks/${review}`)).json()).status).toBe("complete")
    expect(statuses).toEqual(["complete"])
    const bulk = await create("CI canonical Q4 completion fixture", { urgency: 1, importance: 1 })
    await page.goto("/eisenhower")
    await expect(page.locator(`[data-drop-zone="not-now"] .tli[data-id="${bulk}"]`)).toBeVisible()
    const bulkStatuses: string[] = []
    page.on("request", req => {
      if (req.method() === "PUT" && new URL(req.url()).pathname === `/api/tasks/${bulk}` && req.postDataJSON()?.status) bulkStatuses.push(req.postDataJSON().status)
    })
    await page.locator('[data-action="complete-q4"]').click()
    await expect.poll(async () => (await (await request.get(`/api/tasks/${bulk}`)).json()).status).toBe("complete")
    expect(bulkStatuses).toEqual(["complete"])
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers: { origin: new URL(process.env.E2E_BASE_URL!).origin } })
  }
})
