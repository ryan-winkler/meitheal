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

const helperSelector = "[data-helper-id='spaces-explainer']"

test.describe("Helper System", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/planning#spaces")
  })

  test("helper renders with collapse toggle and dismiss button", async ({ page }) => {
    const helper = page.locator(helperSelector)
    await expect(helper).toBeVisible()

    // Toggle button
    const toggle = helper.locator("[data-helper-toggle]")
    await expect(toggle).toBeVisible()

    // Dismiss button
    const dismiss = helper.locator("[data-helper-dismiss]")
    await expect(dismiss).toBeVisible()
  })

  test("clicking collapse toggle hides helper body", async ({ page }) => {
    const helper = page.locator(helperSelector)
    const toggle = helper.locator("[data-helper-toggle]")
    const body = helper.locator(".inline-helper__body")

    await expect(body).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")

    await toggle.click()

    await expect(helper).toHaveClass(/inline-helper--collapsed/)
    await expect(body).toHaveCSS("opacity", "0")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
  })

  test("dismissing helper hides it", async ({ page }) => {
    const helper = page.locator(helperSelector)
    const dismiss = helper.locator("[data-helper-dismiss]")

    await dismiss.click()

    // Helper should be hidden
    await expect(helper).not.toBeVisible()
  })

  test("dismissed helper stays hidden on page reload", async ({ page }) => {
    const helper = page.locator(helperSelector)
    const dismiss = helper.locator("[data-helper-dismiss]")

    // Dismiss
    await dismiss.click()
    await expect(helper).not.toBeVisible()

    // Reload
    await page.reload()

    // Still hidden
    const helperAfterReload = page.locator(helperSelector)
    await expect(helperAfterReload).not.toBeVisible()
  })

  test("? restores a dismissed helper after reload with working controls", async ({ page }) => {
    const helper = page.locator(helperSelector)
    const toggle = helper.getByRole("button", { name: "Toggle helper" })
    const dismiss = helper.getByRole("button", { name: "Dismiss helper" })

    await dismiss.click()
    await expect(helper).not.toBeVisible()
    await page.reload()
    await expect(helper).toBeAttached()
    await expect(helper).not.toBeVisible()

    await page.keyboard.press("?")

    await expect(helper).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator(".helper-restore-flash")).toBeVisible()
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden()

    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await dismiss.click()
    await expect(helper).not.toBeVisible()
  })

  test("? shortcut shows no restore notice when no helpers are dismissed", async ({ page }) => {
    // All helpers are visible — pressing ? should not show flash
    await page.keyboard.press("?")

    const flash = page.locator(".helper-restore-flash")
    await expect(flash).not.toBeVisible()
  })

  test("helper dismiss button has accessible label", async ({ page }) => {
    const dismiss = page.locator(helperSelector).getByRole("button", { name: "Dismiss helper" })
    await expect(dismiss).toHaveAttribute("aria-label", "Dismiss helper")
  })

  test("helper has correct role and aria-label", async ({ page }) => {
    const helper = page.locator(helperSelector)
    await expect(helper).toHaveAttribute("role", "note")
    await expect(helper).toHaveAttribute("aria-label", "Areas & Projects")
  })
})
