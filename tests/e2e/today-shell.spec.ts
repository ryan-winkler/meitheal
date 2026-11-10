import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Today Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the work section", async ({ page }) => {
    const workTab = page.locator(
      '#today-bar-tabs [data-unified-bar-section="today-work"]',
    )

    await workTab.click()

    await expect(page).toHaveURL(/#today-work$/)
    await expect(workTab).toHaveClass(/is-active/)
    await expect(page.locator("#today-work")).toBeVisible()
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#today-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
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
