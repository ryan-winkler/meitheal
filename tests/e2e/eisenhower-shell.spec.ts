import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Eisenhower Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/eisenhower")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar renders with correct barId", async ({ page }) => {
    const bar = page.locator("#eisenhower-bar")
    await expect(bar).toBeVisible()
    await expect(bar).toHaveClass(/unified-bar/)
  })

  test("unified bar tabs jump to the matrix section", async ({ page }) => {
    const matrixTab = page.locator(
      '#eisenhower-bar-tabs [data-unified-bar-section="eisenhower-matrix"]',
    )

    await matrixTab.click()

    await expect(page).toHaveURL(/#eisenhower-matrix$/)
    await expect(matrixTab).toHaveClass(/is-active/)
    await expect(page.locator("#eisenhower-matrix")).toBeVisible()
  })

  test("search launcher opens SearchHub", async ({ page }) => {
    await page.locator("#eisenhower-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("quadrant grid renders all four quadrants", async ({ page }) => {
    const grid = page.locator(".eisenhower__grid")
    await expect(grid).toBeVisible()

    for (const quadrant of ["do-first", "schedule", "delegate", "not-now"]) {
      await expect(page.locator(`[data-quadrant="${quadrant}"]`)).toBeVisible()
    }
  })

  test("flow section renders handoff cards", async ({ page }) => {
    const flowSection = page.locator("#eisenhower-flow")
    await expect(flowSection).toBeVisible()

    const cards = flowSection.locator(".eisenhower__flow-card")
    await expect(cards).toHaveCount(4)
  })

  test("title switcher dropdown is discoverable", async ({ page }) => {
    const switcherBtn = page.locator("#eisenhower-bar-switcher-btn")
    await expect(switcherBtn).toBeVisible()
    await expect(switcherBtn).toHaveAttribute("aria-haspopup", "true")

    // Click to open dropdown
    await switcherBtn.click()
    const dropdown = page.locator("#eisenhower-bar-switcher-dropdown")
    await expect(dropdown).toBeVisible()
  })
})
