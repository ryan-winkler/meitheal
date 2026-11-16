import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Today Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar links jump to the work section and mark it current", async ({ page }) => {
    const workLink = page.locator(
      '#today-bar-tabs [data-unified-bar-section="today-work"]',
    )

    await workLink.click()

    await expect(page).toHaveURL(/#today-work$/)
    await expect(page.locator("#today-work")).toBeInViewport()
    await expect(workLink).toHaveClass(/is-active/)
    await expect(workLink).toHaveAttribute("aria-current", "location")
    await expect(workLink).not.toHaveAttribute("aria-selected")

    const work = page.locator("#today-work")
    const habits = page.locator("#today-habits")
    const habitsLink = page.locator('#today-bar-tabs [data-unified-bar-section="today-habits"]')
    await habits.evaluate((section) => {
      section.style.minHeight = "150vh"
    })
    await work.evaluate((section) => {
      const bottom = section.getBoundingClientRect().bottom + window.scrollY
      window.scrollTo({ top: bottom - 120, behavior: "instant" })
    })
    await expect(work).toBeInViewport()
    await expect(habits).toBeInViewport()
    await expect(workLink).toHaveAttribute("aria-current", "location")

    await page.evaluate(() => window.scrollBy({ top: 240, behavior: "instant" }))
    await expect(work).not.toBeInViewport()
    await expect(habitsLink).toHaveAttribute("aria-current", "location")
    await expect(workLink).toHaveAttribute("aria-current", "false")
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#today-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("filters and Archive completed have accessible names", async ({ page }) => {
    const filters = page.locator("#today-filter-bar")
    for (const name of ["Filter by status", "Filter by priority", "Filter by RICE score", "Sort tasks"]) {
      await expect(filters.getByRole("combobox", { name, exact: true })).toBeVisible()
    }
    await expect(page.getByRole("button", { name: "Archive completed", exact: true })).toBeVisible()
  })

  test("new task button opens the shared task modal", async ({ page }) => {
    await page.locator("#today-bar-new-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("clicking a today task opens the shared task detail surface", async ({ page }) => {
    const firstTask = page.locator(".tli").first()
    if (await firstTask.count() === 0) {
      test.skip(true, "Need at least one today task to verify detail handoff")
      return
    }

    await firstTask.click()

    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
  })
})
