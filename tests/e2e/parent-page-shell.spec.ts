/**
 * Parent Page Shell E2E Tests
 *
 * Tests the three parent pages (Tasks, Progress, Planning) render their
 * stat cards, inline helpers, section navigation, and deep links correctly.
 *
 * @domain navigation
 * @phase 15 — Hierarchy Architecture Overhaul
 */
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Parent Page — /tasks", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/tasks")
    await page.waitForLoadState("networkidle")
  })

  test("renders parent page shell with correct pageId", async ({ page }) => {
    const shell = page.locator("[data-page-id='tasks']")
    await expect(shell).toBeVisible()
  })

  test("renders kanban section with stat cards", async ({ page }) => {
    const section = page.locator("#tasks-section-kanban")
    await expect(section).toBeVisible()

    // Stat cards present
    const statCards = section.locator(".stat-card")
    await expect(statCards.first()).toBeVisible()

    // Deep link to kanban legacy view
    const link = section.locator("a[href='/kanban']")
    await expect(link).toBeVisible()
  })

  test("renders calendar section", async ({ page }) => {
    const section = page.locator("#tasks-section-calendar")
    // Calendar section is hidden by default (hash routing)
    await expect(section).toHaveAttribute("hidden", "")

    // Navigate to calendar hash
    await page.goto("/tasks#calendar")
    await page.waitForLoadState("networkidle")
    await expect(section).not.toHaveAttribute("hidden", "")
  })

  test("renders inline helper with dismiss button", async ({ page }) => {
    const helper = page.locator("[data-helper-id='tasks-kanban-explainer']")
    await expect(helper).toBeVisible()
    await expect(helper.locator("[data-helper-dismiss]")).toBeVisible()
  })

  test("renders table and gantt sections (hidden by default)", async ({ page }) => {
    await expect(page.locator("#tasks-section-table")).toHaveAttribute("hidden", "")
    await expect(page.locator("#tasks-section-gantt")).toHaveAttribute("hidden", "")
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

  test("renders eisenhower section with quadrant stats", async ({ page }) => {
    const section = page.locator("#planning-section-eisenhower")
    await expect(section).toBeVisible()

    // Stat cards for quadrant counts
    const statCards = section.locator(".stat-card")
    await expect(statCards.first()).toBeVisible()

    // Deep link to eisenhower legacy view
    const link = section.locator("a[href='/eisenhower']")
    await expect(link).toBeVisible()
  })

  test("renders planning helper with correct variant", async ({ page }) => {
    const helper = page.locator("[data-helper-id='planning-hub-explainer']")
    await expect(helper).toBeVisible()
    await expect(helper).toHaveClass(/inline-helper--info/)
  })

  test("triage and rice sections are hidden by default", async ({ page }) => {
    await expect(page.locator("#planning-section-triage")).toHaveAttribute("hidden", "")
    await expect(page.locator("#planning-section-rice")).toHaveAttribute("hidden", "")
  })
})
