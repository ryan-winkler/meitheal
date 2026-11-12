import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Eisenhower Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/eisenhower")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar renders with correct barId", async ({ page }) => {
    const bar = page.locator("#eisenhower-bar")
    await expect(bar).toBeVisible()
    await expect(bar).toHaveClass(/unified-bar/)
  })

  test("unified bar tabs jump to the matrix section", async ({ page }) => {
    const matrixTab = page.locator(
      '#eisenhower-bar-tabs [data-unified-bar-section="eisenhower-matrix"]',
    )

    await matrixTab.click()

    await expect(page).toHaveURL(/#eisenhower-matrix$/)
    await expect(matrixTab).toHaveClass(/is-active/)
    await expect(page.locator("#eisenhower-matrix")).toBeVisible()
  })

  test("search launcher opens SearchHub", async ({ page }) => {
    await page.locator("#eisenhower-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("quadrant grid renders all four quadrants", async ({ page }) => {
    const grid = page.locator(".eisenhower__grid")
    await expect(grid).toBeVisible()

    for (const quadrant of ["do-first", "schedule", "delegate", "not-now"]) {
      await expect(page.locator(`[data-quadrant="${quadrant}"]`)).toBeVisible()
    }
  })

  test("mobile quadrant tabs show one panel and support keyboard navigation", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    const panels = page.locator("[data-quadrant]")
    const first = page.getByRole("tab", { name: /Do First/ })
    const schedule = page.getByRole("tab", { name: /Schedule/ })
    const last = page.getByRole("tab", { name: /Not Now/ })

    await expect(first).toHaveAttribute("aria-selected", "true")
    await expect(panels.filter({ visible: true })).toHaveCount(1)
    await first.focus()
    await first.press("ArrowRight")
    await expect(schedule).toBeFocused()
    await expect(schedule).toHaveAttribute("aria-selected", "true")
    await expect(first).toHaveAttribute("tabindex", "-1")
    const schedulePanel = page.getByRole("tabpanel", { name: /Schedule/ })
    await expect(schedulePanel).toBeVisible()
    await expect(schedule).toHaveAttribute("aria-controls", "eisenhower-quadrant-schedule")
    await schedule.press("Tab")
    await expect(schedulePanel).toBeFocused()

    await schedule.focus()
    await schedule.press("End")
    await expect(last).toBeFocused()
    await expect(last).toHaveAttribute("aria-selected", "true")
    await last.press("ArrowRight")
    await expect(first).toBeFocused()
    await schedule.click()
    await expect(schedulePanel).toBeVisible()
    await expect(panels.filter({ visible: true })).toHaveCount(1)

    await page.setViewportSize({ width: 1440, height: 960 })
    await expect(page.getByRole("tablist", { name: "Quadrant tabs" })).toBeHidden()
    await expect(panels.filter({ visible: true })).toHaveCount(4)
    await expect(page.locator("[data-quadrant][role=tabpanel]")).toHaveCount(0)

    const focusDelegate = page.getByRole("button", { name: "Focus on Delegate" })
    await focusDelegate.click()
    await expect(panels.filter({ visible: true })).toHaveCount(1)
    await expect(focusDelegate).toBeVisible()
    await page.setViewportSize({ width: 768, height: 800 })
    await expect(schedulePanel).toBeVisible()
    await expect(panels.filter({ visible: true })).toHaveCount(1)
    await page.setViewportSize({ width: 769, height: 960 })
    await expect(focusDelegate).toBeVisible()
    await focusDelegate.click()
    await expect(panels.filter({ visible: true })).toHaveCount(4)
  })

  test("the mobile matrix keeps every quadrant available without JavaScript", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 800 } })
    try {
      const page = await context.newPage()
      await page.goto(new URL("/eisenhower", baseURL).href)
      await expect(page.getByRole("tablist", { name: "Quadrant tabs" })).toBeHidden()
      await expect(page.locator("[data-quadrant]").filter({ visible: true })).toHaveCount(4)
    } finally {
      await context.close()
    }
  })

  test("task list semantics follow a drag into an empty quadrant", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const title = "Eisenhower quadrant list semantics"
    const created = await request.post("/api/tasks", {
      headers,
      data: { title, urgency: 1, importance: 1 },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json()
    const taskPath = `/api/tasks/${id}`

    try {
      await page.reload()
      const source = page.locator('[data-drop-zone="not-now"]')
      const target = page.locator('[data-drop-zone="schedule"]')
      const card = page.locator(`.tli[data-id="${id}"]`)

      await expect(source.getByRole("listitem").filter({ has: card })).toBeVisible()
      await expect(target.locator(".quadrant__empty")).toBeVisible()
      await expect(target).not.toHaveAttribute("role", "list")

      await card.dragTo(target)

      const link = target.getByRole("listitem").getByRole("link", { name: title })
      await expect(target).toHaveAttribute("role", "list")
      await expect(target.locator(".quadrant__empty")).toBeHidden()
      await expect(source.locator(".quadrant__empty")).toBeVisible()
      await expect(source).not.toHaveAttribute("role", "list")
      await link.focus()
      await expect(link).toBeFocused()
      await expect.poll(async () => (await (await request.get(taskPath)).json()).importance).toBe(5)
      await page.setViewportSize({ width: 320, height: 800 })
      await expect(page.getByRole("tab", { name: /Schedule/ })).toHaveAccessibleName(/Schedule 1/)
      await expect(page.getByRole("tab", { name: /Not Now/ })).toHaveAccessibleName(/Not Now 0/)
    } finally {
      const removed = await request.delete(taskPath, { headers, data: {} })
      expect(removed.status()).toBe(204)
    }
  })

  test("flow section renders handoff cards", async ({ page }) => {
    const flowSection = page.locator("#eisenhower-flow")
    await expect(flowSection).toBeVisible()

    const cards = flowSection.locator(".eisenhower__flow-card")
    await expect(cards).toHaveCount(4)
  })

  test("title switcher dropdown is discoverable", async ({ page }) => {
    const switcherBtn = page.locator("#eisenhower-bar-switcher-btn")
    await expect(switcherBtn).toBeVisible()
    await expect(switcherBtn).toHaveAttribute("aria-haspopup", "true")

    // Click to open dropdown
    await switcherBtn.click()
    const dropdown = page.locator("#eisenhower-bar-switcher-dropdown")
    await expect(dropdown).toBeVisible()
  })
})
