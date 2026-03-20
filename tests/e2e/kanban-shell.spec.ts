import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Shell (Kanban)", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/tasks")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the fields section", async ({ page }) => {
    const fieldsTab = page.locator(
      '#kanban-bar-tabs [data-unified-bar-section="kanban-fields"]',
    )

    await fieldsTab.click()

    await expect(page).toHaveURL(/#kanban-fields$/)
    await expect(fieldsTab).toHaveClass(/is-active/)
    await expect(page.locator("#kanban-fields")).toBeVisible()
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#kanban-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("manage lanes opens the lane management panel", async ({ page }) => {
    const panel = page.locator("#lane-mgmt")

    await expect(panel).toHaveClass(/hidden/)
    await page.locator("#manage-lanes-btn").click()
    await expect(panel).not.toHaveClass(/hidden/)

    await page.locator("#lane-mgmt-close").click()
    await expect(panel).toHaveClass(/hidden/)
  })

  test("view pills preserve query string when switching routes", async ({ page }) => {
    await page.goto("/tasks?status=active&priority=1")
    await page.waitForLoadState("networkidle")

    await page.locator('.unified-bar__view-pill[href="/calendar?status=active&priority=1"]').click()
    await page.waitForLoadState("networkidle")

    await expect(page).toHaveURL(/\/calendar\?status=active&priority=1$/)
  })

  test("/kanban redirects to /tasks", async ({ page }) => {
    const response = await page.goto("/kanban")
    await page.waitForLoadState("networkidle")

    await expect(page).toHaveURL(/\/tasks/)
  })
})
