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
    await expect(workLink).toHaveClass(/is-active/)
    await expect(workLink).toHaveAttribute("aria-current", "location")
    await expect(workLink).not.toHaveAttribute("aria-selected")
    await expect(page.locator("#today-work")).toBeVisible()
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#today-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("filters and Clear Done have accessible names", async ({ page }) => {
    const filters = page.locator("#today-filter-bar")
    for (const name of ["Filter by status", "Filter by priority", "Filter by RICE score", "Sort tasks"]) {
      await expect(filters.getByRole("combobox", { name, exact: true })).toBeVisible()
    }
    await expect(page.getByRole("button", { name: "Clear Done", exact: true })).toBeVisible()
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
