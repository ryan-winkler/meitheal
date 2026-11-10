/**
 * Parent Page Shell E2E Tests
 *
 * Tests the parent pages (Progress, Planning) render their
 * stat cards, inline helpers, section navigation, and deep links correctly.
 * Tasks opens the Kanban view within its own route.
 *
 * @domain navigation
 * @phase 16 — Task Views Overhaul
 */
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Page — /tasks default view", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("opens the Kanban view by default", async ({ page }) => {
    await page.goto("/tasks")
    await expect(page).toHaveURL(/\/tasks#kanban$/)
    await expect(page.getByRole("toolbar", { name: "Kanban view actions" })).toBeVisible()
  })
})

test.describe("Progress Parent Page — /progress", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/progress")
    await page.waitForLoadState("networkidle")
  })

  test("switches from Pillars to Routines with stat cards and helper", async ({ page }) => {
    await expect(page.locator("#progress-section-pillars")).toBeVisible()
    await page.getByRole("button", { name: "Progress & Growth — switch section" }).click()
    await page.getByRole("menuitem", { name: "Routines" }).click()
    await expect(page).toHaveURL(/\/progress#routines$/)
    const section = page.locator("#progress-section-routines")
    await expect(section).toBeVisible()

    // Helper visible
    const helper = page.locator("[data-helper-id='progress-routines-explainer']")
    await expect(helper).toBeVisible()

    // Stat cards
    const statCards = section.locator(".stat-card")
    await expect(statCards.first()).toBeVisible()

    // Deep link
    const link = section.locator("a[href='/habits']")
    await expect(link).toBeVisible()
  })

  test("navigating to goals hash shows goals section", async ({ page }) => {
    await page.goto("/progress#goals")
    await page.waitForLoadState("networkidle")

    const goalsSection = page.locator("#progress-section-goals")
    await expect(goalsSection).not.toHaveAttribute("hidden", "")

    // Goals helper
    const helper = page.locator("[data-helper-id='progress-goals-explainer']")
    await expect(helper).toBeVisible()
  })

  test("navigating to achievements hash shows achievements section", async ({ page }) => {
    await page.goto("/progress#achievements")
    await page.waitForLoadState("networkidle")

    const section = page.locator("#progress-section-achievements")
    await expect(section).not.toHaveAttribute("hidden", "")
  })
})

test.describe("Planning Parent Page — /planning", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/planning")
    await page.waitForLoadState("networkidle")
  })

  test("renders spaces section as default view", async ({ page }) => {
    // Planning now defaults to spaces (Areas & Projects)
    const spacesSection = page.locator("#planning-section-spaces")
    await expect(spacesSection).toBeVisible()
  })

  test("renders planning helper with correct variant", async ({ page }) => {
    const helper = page.locator("[data-helper-id='spaces-explainer']")
    await expect(helper).toBeVisible()
    await expect(helper).toHaveClass(/inline-helper--info/)
  })

  test("eisenhower, triage, and rice sections are hidden by default", async ({ page }) => {
    await expect(page.locator("#planning-section-eisenhower")).toHaveAttribute("hidden", "")
    await expect(page.locator("#planning-section-triage")).toHaveAttribute("hidden", "")
    await expect(page.locator("#planning-section-rice")).toHaveAttribute("hidden", "")
  })
})
