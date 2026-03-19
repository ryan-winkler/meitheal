import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Calendar Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/calendar")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the agenda section", async ({ page }) => {
    const agendaTab = page.locator(
      '#calendar-bar-tabs [data-unified-bar-section="calendar-agenda"]',
    )

    await agendaTab.click()

    await expect(page).toHaveURL(/#calendar-agenda$/)
    await expect(agendaTab).toHaveClass(/is-active/)
    await expect(page.locator("#calendar-agenda")).toBeVisible()
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#calendar-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("day drawer add-task handoff opens the shared task modal", async ({ page }) => {
    await page.locator('.cal-cell[data-date]:not(.cal-other)').first().click()

    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
    await page.locator("#day-drawer-add-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("secondary view tabs preserve query string when switching routes", async ({ page }) => {
    await page.goto("/calendar?status=active&priority=1")
    await page.waitForLoadState("networkidle")

    await page.getByRole("link", { name: /Table View/i }).click()
    await page.waitForLoadState("networkidle")

    await expect(page).toHaveURL(/\/table\?status=active&priority=1$/)
  })
})
