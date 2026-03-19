import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Table Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/table")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the filters section", async ({ page }) => {
    const filtersTab = page.locator(
      '#table-bar-tabs [data-unified-bar-section="table-filters"]',
    )

    await filtersTab.click()

    await expect(page).toHaveURL(/#table-filters$/)
    await expect(filtersTab).toHaveClass(/is-active/)
    await expect(page.locator("#table-filters")).toBeVisible()
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#table-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("new task button opens the shared task modal", async ({ page }) => {
    await page.locator("#table-bar-new-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("secondary view tabs preserve query string when switching routes", async ({ page }) => {
    await page.goto("/table?status=active&priority=1")
    await page.waitForLoadState("networkidle")

    await page.getByRole("link", { name: /Kanban Area/i }).click()
    await page.waitForLoadState("networkidle")

    await expect(page).toHaveURL(/\/kanban\?status=active&priority=1$/)
  })

  test("clicking a table row opens the shared task detail surface", async ({ page }) => {
    const firstRowBadge = page.locator(".table-row .ticket-key-badge").first()
    if (await firstRowBadge.count() === 0) {
      test.skip(true, "Need at least one table row to verify detail handoff")
      return
    }

    await firstRowBadge.click()

    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
  })
})
