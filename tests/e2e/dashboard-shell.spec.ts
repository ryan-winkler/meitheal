import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Dashboard Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the focused dashboard section", async ({ page }) => {
    const focusTab = page.locator(
      '#dashboard-bar-tabs [data-unified-bar-section="dashboard-open"]',
    )

    await focusTab.click()

    await expect(page).toHaveURL(/#dashboard-open$/)
    await expect(focusTab).toHaveClass(/is-active/)
    await expect(page.locator("#dashboard-open")).toBeVisible()
  })

  test("search launcher opens the global search hub", async ({ page }) => {
    await page.locator("#dashboard-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("new task button opens the shared task modal", async ({ page }) => {
    await page.locator("#dashboard-bar-new-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })
})
