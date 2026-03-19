import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Habits Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/habits")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the habits library section", async ({ page }) => {
    const libraryTab = page.locator(
      '#habits-bar-tabs [data-unified-bar-section="habits-library"]',
    )

    await libraryTab.click()

    await expect(page).toHaveURL(/#habits-library$/)
    await expect(libraryTab).toHaveClass(/is-active/)
    await expect(page.locator("#habits-library")).toBeVisible()
  })

  test("search launcher opens the global search hub", async ({ page }) => {
    await page.locator("#habits-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("new habit action opens the shared habits modal", async ({ page }) => {
    await page.locator("#habits-bar-new-habit").click()

    await expect(page.locator("#habit-modal-overlay")).toBeVisible()
    await expect(page.locator("#habit-name")).toBeFocused()
  })
})
