/**
 * Helper System E2E Tests
 *
 * Tests the InlineHelper component and helper-system.ts controller:
 * - Helpers render and can be dismissed
 * - Dismissed helpers persist across page loads
 * - ? keyboard shortcut restores dismissed helpers
 * - Flash notification appears on restore
 *
 * @domain navigation (UX support)
 * @phase 15 — Hierarchy Architecture Overhaul
 */
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Helper System", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    // Clear helper dismissal state
    await page.addInitScript(() => {
      localStorage.removeItem("meitheal-dismissed-helpers")
    })
    await page.goto("/tasks")
    await page.waitForLoadState("networkidle")
  })

  test("helper renders with collapse toggle and dismiss button", async ({ page }) => {
    const helper = page.locator("[data-helper-id='tasks-kanban-explainer']")
    await expect(helper).toBeVisible()

    // Toggle button
    const toggle = helper.locator("[data-helper-toggle]")
    await expect(toggle).toBeVisible()

    // Dismiss button
    const dismiss = helper.locator("[data-helper-dismiss]")
    await expect(dismiss).toBeVisible()
  })

  test("clicking collapse toggle hides helper body", async ({ page }) => {
    const helper = page.locator("[data-helper-id='tasks-kanban-explainer']")
    const toggle = helper.locator("[data-helper-toggle]")
    const body = helper.locator(".inline-helper__body")

    // Body should be visible initially
    await expect(body).toBeVisible()

    // Click toggle
    await toggle.click()

    // Helper should gain collapsed class
    await expect(helper).toHaveClass(/inline-helper--collapsed/)
  })

  test("dismissing helper hides it", async ({ page }) => {
    const helper = page.locator("[data-helper-id='tasks-kanban-explainer']")
    const dismiss = helper.locator("[data-helper-dismiss]")

    await dismiss.click()

    // Helper should be hidden
    await expect(helper).not.toBeVisible()
  })

  test("dismissed helper stays hidden on page reload", async ({ page }) => {
    const helper = page.locator("[data-helper-id='tasks-kanban-explainer']")
    const dismiss = helper.locator("[data-helper-dismiss]")

    // Dismiss
    await dismiss.click()
    await expect(helper).not.toBeVisible()

    // Reload
    await page.reload()
    await page.waitForLoadState("networkidle")

    // Still hidden
    const helperAfterReload = page.locator("[data-helper-id='tasks-kanban-explainer']")
    await expect(helperAfterReload).not.toBeVisible()
  })

  test("? keyboard shortcut restores dismissed helpers", async ({ page }) => {
    const helper = page.locator("[data-helper-id='tasks-kanban-explainer']")
    const dismiss = helper.locator("[data-helper-dismiss]")

    // Dismiss first
    await dismiss.click()
    await expect(helper).not.toBeVisible()

    // Press ? to restore
    await page.keyboard.press("Shift+/") // ? on US layout

    // Helper should be visible again
    await expect(helper).toBeVisible()

    // Flash notification should appear
    const flash = page.locator(".helper-restore-flash")
    await expect(flash).toBeVisible()
  })

  test("? shortcut does nothing when no helpers are dismissed", async ({ page }) => {
    // All helpers are visible — pressing ? should not show flash
    await page.keyboard.press("Shift+/")

    const flash = page.locator(".helper-restore-flash")
    await expect(flash).not.toBeVisible()
  })

  test("helper dismiss button has accessible label", async ({ page }) => {
    const dismiss = page.locator("[data-helper-id='tasks-kanban-explainer'] [data-helper-dismiss]")
    await expect(dismiss).toHaveAttribute("aria-label", "Dismiss helper")
  })

  test("helper has correct role and aria-label", async ({ page }) => {
    const helper = page.locator("[data-helper-id='tasks-kanban-explainer']")
    await expect(helper).toHaveAttribute("role", "note")
    await expect(helper).toHaveAttribute("aria-label", "Task Views Hub")
  })
})
