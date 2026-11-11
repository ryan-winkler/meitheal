import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro server")
test.use({ serviceWorkers: "block" })

for (const action of ["review", "complete-q4", "triage"] as const) {
  test(`repeated page loads keep one ${action} task mutation`, async ({ page, request, baseURL }) => {
    const created = await request.post("/api/tasks", { data: {
      title: `Eisenhower lifecycle ${action}`,
      urgency: action === "triage" ? 0 : 1, importance: action === "triage" ? 0 : 1,
    } })
    expect(created.status(), await created.text()).toBe(201)
    const task = await created.json()
    const taskPath = `/api/tasks/${task.id}`
    const statusWrites: string[] = []
    let reviewWrites = 0
    let triageWrites = 0
    try {
      await page.route(`**${taskPath}`, async route => {
        if (route.request().method() === "PUT") {
          const payload = route.request().postDataJSON()
          if (payload.status) statusWrites.push(payload.status)
          if (payload.framework_payload) reviewWrites++
          if (payload.urgency === 4 && payload.importance === 5) triageWrites++
        }
        await route.continue()
      })
      await page.goto("/eisenhower")
      const card = page.locator(`[data-drop-zone="not-now"] .tli[data-id="${task.id}"]`)
      await expect(card).toBeVisible()
      await page.evaluate(() => {
        document.dispatchEvent(new Event("astro:page-load"))
        document.dispatchEvent(new Event("astro:page-load"))
      })
      if (action === "review") {
        await page.locator('[data-action="start-review"]').click()
        await expect(page.locator("#review-overlay")).toBeVisible()
        await page.locator('[data-action="review-archive"]').click()
        await expect(page.locator("#review-overlay")).toBeHidden()
        await expect.poll(() => reviewWrites).toBe(1)
      } else if (action === "triage") {
        await page.locator('[data-action="start-triage"]').click()
        await expect(page.locator("#triage-overlay")).toBeVisible()
        await expect(page.locator("#triage-task-name")).toHaveText(task.title)
        await page.locator("#triage-urgency").fill("4")
        await page.locator("#triage-importance").fill("5")
        await page.locator('[data-action="triage-save"]').click()
        await expect(page.locator("#triage-overlay")).toBeHidden()
        const saved = await (await request.get(taskPath)).json()
        expect(saved).toMatchObject({ urgency: 4, importance: 5 })
        expect(triageWrites).toBe(1)
        expect(statusWrites).toEqual([])
        return
      } else {
        await page.locator('[data-action="complete-q4"]').click()
        await expect(card).toHaveCount(0)
      }
      await expect.poll(async () => (await (await request.get(taskPath)).json()).status).toBe("complete")
      expect(statusWrites).toEqual(["complete"])
    } finally {
      await request.delete(taskPath, { headers: { origin: new URL(baseURL!).origin } })
    }
  })
}

test("aborted page ownership retires actions and review listeners before the next setup", async ({ page, request, baseURL }) => {
  const created = await request.post("/api/tasks", { data: {
    title: "Eisenhower lifecycle navigation", urgency: 1, importance: 1,
  } })
  expect(created.status(), await created.text()).toBe(201)
  const task = await created.json()
  const taskPath = `/api/tasks/${task.id}`
  const statusWrites: string[] = []
  try {
    await page.route(`**${taskPath}`, async route => {
      if (route.request().method() === "PUT" && route.request().postDataJSON().status) {
        statusWrites.push(route.request().postDataJSON().status)
      }
      await route.continue()
    })
    await page.goto("/eisenhower")
    await page.locator('[data-action="start-review"]').click()
    await expect(page.locator("#review-overlay")).toBeVisible()
    await page.evaluate(() => document.dispatchEvent(new Event("astro:before-swap")))
    await page.keyboard.press("Escape")
    await expect(page.locator("#review-overlay")).toBeVisible()
    await page.locator('[data-action="close-review"]').click()
    await expect(page.locator("#review-overlay")).toBeVisible()
    expect(statusWrites).toEqual([])
    await page.evaluate(() => {
      document.dispatchEvent(new Event("astro:page-load"))
      document.dispatchEvent(new Event("astro:page-load"))
    })
    await page.keyboard.press("Escape")
    await expect(page.locator("#review-overlay")).toBeHidden()
    await page.locator('[data-action="complete-q4"]').click()
    await expect(page.locator(`.tli[data-id="${task.id}"]`)).toHaveCount(0)
    expect(statusWrites).toEqual(["complete"])
  } finally {
    await request.delete(taskPath, { headers: { origin: new URL(baseURL!).origin } })
  }
})
