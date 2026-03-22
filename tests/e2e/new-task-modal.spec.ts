import { test, expect } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("New Task Modal", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  test("New Task modal opens when + New Task button is clicked", async ({ page }) => {
    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).not.toHaveClass(/active/)

    // Click the "+ New Task" button in the header
    await page.click("#create-task-btn")
    await page.waitForTimeout(300)

    await expect(overlay).toHaveClass(/active/)
  })

  test("New Task modal has correct accessibility attributes", async ({ page }) => {
    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveAttribute("role", "dialog")
    await expect(overlay).toHaveAttribute("aria-modal", "true")
    await expect(overlay).toHaveAttribute("aria-labelledby", "new-task-title")
  })

  test("New Task modal has all required form fields", async ({ page }) => {
    await page.click("#create-task-btn")
    await page.waitForTimeout(300)

    await expect(page.locator("#new-task-title-input")).toBeVisible()
    await expect(page.locator("#new-task-desc-input")).toBeVisible()
    await expect(page.locator("#new-task-priority")).toBeVisible()
    // Status is now a hidden input backing interactive pill buttons
    await expect(page.locator("#new-task-status")).toHaveCount(1)
    // At least 1 pill (fallback "To Do") renders; more from /api/lanes
    const pillCount = await page.locator(".nt-status-pill").count()
    expect(pillCount).toBeGreaterThanOrEqual(1)
    await expect(page.locator("#new-task-recurrence")).toBeVisible()
    await expect(page.locator("#submit-new-task-btn")).toBeVisible()
    await expect(page.locator("#cancel-new-task")).toBeVisible()
  })

  test("New Task modal closes on close button click", async ({ page }) => {
    await page.click("#create-task-btn")
    await page.waitForTimeout(300)

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    await page.click("#close-new-task-modal")
    await page.waitForTimeout(500)

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal closes on Cancel button click", async ({ page }) => {
    await page.click("#create-task-btn")
    await page.waitForTimeout(300)

    await page.click("#cancel-new-task")
    await page.waitForTimeout(500)

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal closes on Escape key", async ({ page }) => {
    await page.click("#create-task-btn")
    await page.waitForTimeout(300)

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    await page.keyboard.press("Escape")
    await page.waitForTimeout(500)

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal closes on backdrop click", async ({ page }) => {
    await page.click("#create-task-btn")
    await page.waitForTimeout(300)

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    // Click the overlay itself (outside the modal-content)
    await overlay.click({ position: { x: 10, y: 10 } })
    await page.waitForTimeout(500)

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal title input autofocuses", async ({ page }) => {
    await page.click("#create-task-btn")
    await page.waitForTimeout(300)

    const titleInput = page.locator("#new-task-title-input")
    await expect(titleInput).toBeFocused()
  })
})

