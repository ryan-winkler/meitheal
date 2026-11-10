import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Upcoming Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/upcoming")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the week section", async ({ page }) => {
    const weekTab = page.locator(
      '#upcoming-bar-tabs [data-unified-bar-section="upcoming-week"]',
    )

    await weekTab.click()

    await expect(page).toHaveURL(/#upcoming-week$/)
    await expect(weekTab).toHaveClass(/is-active/)
    await expect(page.locator("#upcoming-week")).toBeVisible()
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#upcoming-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("new task button opens the shared task modal", async ({ page }) => {
    await page.locator("#upcoming-bar-new-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("clicking an upcoming task opens the shared task detail surface", async ({ page }) => {
    const firstTask = page.locator(".task-item").first()
    if (await firstTask.count() === 0) {
      test.skip(true, "Need at least one upcoming task to verify detail handoff")
      return
    }

    await firstTask.click()

    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
  })
})
