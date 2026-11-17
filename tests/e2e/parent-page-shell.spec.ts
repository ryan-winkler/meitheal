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
    await expect(page.locator("#tasks-view-kanban")).toBeVisible()
    const actions = page.locator("#tasks-filter-row").getByRole("group", { name: "Kanban board actions" })
    await expect(actions.getByRole("link", { name: "Deferred", exact: true })).toBeVisible()
  })
})

test.describe("Progress Parent Page — /progress", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/progress")
  })

  test("switches from Pillars to Routines and offers direct creation and browsing", async ({ page }) => {
    const pillars = page.locator("#progress-section-pillars")
    await expect(pillars).toHaveAttribute("aria-hidden", "false")
    await expect(pillars).toBeVisible()
    const sectionPicker = page.getByRole("button", { name: "Progress & Growth — switch section" })
    await sectionPicker.click()
    await expect(sectionPicker).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("menuitem", { name: "Routines" }).click()
    await expect(page).toHaveURL(/\/progress#routines$/)
    await expect(page.locator('#progress-bar-tabs a[href="#routines"]')).toHaveAttribute("aria-current", "location")
    const section = page.locator("#progress-section-routines")
    await expect(section).toBeVisible()

    await expect(section.getByRole("link", { name: "New Routine" })).toHaveAttribute("href", "/habits?new=1")
    await expect(section.getByRole("link", { name: "View Routines" })).toHaveAttribute("href", "/habits")
  })

  test("navigating to goals hash shows goals section", async ({ page }) => {
    await page.goto("/progress#goals")

    const goalsSection = page.locator("#progress-section-goals")
    await expect(goalsSection).toHaveAttribute("aria-hidden", "false")
    await expect(goalsSection).toBeVisible()

    await expect(goalsSection.getByRole("button", { name: "+ New Goal" })).toBeVisible()
  })

  test("navigating to achievements hash shows achievements section", async ({ page }) => {
    await page.goto("/progress#achievements")

    const section = page.locator("#progress-section-achievements")
    await expect(section).toHaveAttribute("aria-hidden", "false")
    await expect(section).toBeVisible()
  })
})

test.describe("Planning Parent Page — /planning", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/planning")
  })

  test("renders Eisenhower as the default planning view", async ({ page }) => {
    const matrix = page.locator("#planning-section-eisenhower")
    await expect(matrix).toHaveAttribute("aria-hidden", "false")
    await expect(matrix).toBeVisible()
  })

  test("section links keep native Tab order and announce the current location", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 })
    const navigation = page.locator("#planning-bar-tabs")
    const eisenhower = navigation.locator('a[href="#eisenhower"]')
    const triage = navigation.locator('a[href="#triage"]')
    const rice = navigation.locator('a[href="#rice"]')

    await expect(eisenhower).toHaveAttribute("aria-current", "location")
    await expect(navigation.locator("a[aria-selected]")).toHaveCount(0)
    await eisenhower.focus()
    await page.keyboard.press("Tab")
    await expect(triage).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(triage).toHaveAttribute("aria-current", "location")
    await expect(page.locator("#planning-section-triage")).toBeVisible()

    await page.keyboard.press("ArrowRight")
    await expect(rice).toBeFocused()
    await expect(rice).toHaveAttribute("aria-current", "location")
    await expect(navigation.locator('a[aria-current="location"]')).toHaveCount(1)
    await page.goBack()
    await expect(triage).toHaveAttribute("aria-current", "location")
    await page.goForward()
    await expect(rice).toHaveAttribute("aria-current", "location")
  })

  test("opens the Boards directory from a legacy Spaces bookmark", async ({ page }) => {
    await page.goto("/planning#spaces")
    await expect(page).toHaveURL(/\/boards$/)
    await expect(page.getByRole("link", { name: "Household" }).first()).toBeVisible()
  })

  test("only the default section is visible on first load", async ({ page }) => {
    await expect(page.locator("#planning-section-spaces")).toHaveAttribute("hidden", "")
    await expect(page.locator("#planning-section-triage")).toHaveAttribute("hidden", "")
    await expect(page.locator("#planning-section-rice")).toHaveAttribute("hidden", "")
  })
})
