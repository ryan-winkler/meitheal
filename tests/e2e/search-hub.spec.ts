import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

function getSearchShortcut(): string {
  return process.platform === "darwin" ? "Meta+K" : "Control+K"
}

test.describe("Search Hub", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings")
  })

  test("keyboard shortcut and launcher open the same overlay", async ({ page }) => {
    const overlay = page.locator("#search-hub-overlay")

    await page.keyboard.press(getSearchShortcut())
    await expect(overlay).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()

    await page.locator("#search-hub-close").click()
    await expect(overlay).toBeHidden()

    await page.getByRole("button", { name: "Search settings…", exact: true }).click()
    await expect(overlay).toBeVisible()
  })

  test("settings scope deep-links to the matching field anchor", async ({ page }) => {
    await page.getByRole("button", { name: "Search settings…", exact: true }).click()
    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await page.locator('[data-scope="settings"]').click()

    const searchInput = page.locator("#search-hub-input")
    await searchInput.fill("theme")

    const themeResult = page.locator(".search-hub-item").filter({
      has: page.locator(".search-hub-item-title", { hasText: /^Theme$/ }),
    }).first()
    await expect(themeResult).toBeVisible()

    await themeResult.click()

    await expect(page).toHaveURL(/\/settings#theme-select$/)
    await expect(page.locator("#theme-select")).toBeVisible()
  })

  test("views scope navigates to another page result", async ({ page }) => {
    await page.getByRole("button", { name: "Search settings…", exact: true }).click()
    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await page.locator('[data-scope="views"]').click()

    const searchInput = page.locator("#search-hub-input")
    await searchInput.fill("calendar")

    const calendarResult = page.locator(".search-hub-item").filter({ hasText: "Calendar" }).first()
    await expect(calendarResult).toBeVisible()

    await calendarResult.click()

    await expect(page).toHaveURL(/\/tasks\?view=calendar#calendar$/)
    await expect(page.locator("#tasks-view-calendar")).toBeVisible()
  })

  test("actions scope can open the Home Assistant assist modal", async ({ page }) => {
    await page.getByRole("button", { name: "Search settings…", exact: true }).click()
    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await page.locator('[data-scope="actions"]').click()

    const assistAction = page.locator(".search-hub-item").filter({ hasText: "Ask Home Assistant" }).first()
    await expect(assistAction).toBeVisible()

    await assistAction.click()

    await expect(page.locator("#ask-ha-overlay")).toBeVisible()
  })
})
