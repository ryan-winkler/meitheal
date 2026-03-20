/**
 * Parent Page Shell E2E Tests
 *
 * Tests the parent pages (Progress, Planning) render their
 * stat cards, inline helpers, section navigation, and deep links correctly.
 * Tasks page now redirects to /kanban (Phase 16).
 *
 * @domain navigation
 * @phase 16 — Task Views Overhaul
 */
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Page — /tasks redirect", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("redirects /tasks to /kanban", async ({ page }) => {
    await page.goto("/tasks")
    await page.waitForLoadState("networkidle")
    expect(page.url()).toContain("/kanban")
  })
})

test.describe("Progress Parent Page — /progress", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/progress")
    await page.waitForLoadState("networkidle")
  })

  test("renders routines section with stat cards and helper", async ({ page }) => {
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
    const helper = page.locator("[data-helper-id='planning-hub-explainer']")
    await expect(helper).toBeVisible()
    await expect(helper).toHaveClass(/inline-helper--info/)
  })

  test("eisenhower, triage, and rice sections are hidden by default", async ({ page }) => {
    await expect(page.locator("#planning-section-eisenhower")).toHaveAttribute("hidden", "")
    await expect(page.locator("#planning-section-triage")).toHaveAttribute("hidden", "")
    await expect(page.locator("#planning-section-rice")).toHaveAttribute("hidden", "")
  })
})
