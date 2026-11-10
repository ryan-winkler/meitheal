import { test, expect } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("New Task Modal", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
  })

  test("New Task modal opens when + New Task button is clicked", async ({ page }) => {
    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).not.toHaveClass(/active/)

    // Click the "+ New Task" button in the header
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    await expect(overlay).toHaveClass(/active/)
  })

  test("New Task modal has correct accessibility attributes", async ({ page }) => {
    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveAttribute("role", "dialog")
    await expect(overlay).toHaveAttribute("aria-modal", "true")
    await expect(overlay).toHaveAttribute("aria-labelledby", "new-task-title")
  })

  test("New Task modal has all required form fields", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    await expect(page.locator("#new-task-title-input")).toBeVisible()
    await expect(page.locator("#new-task-desc-input")).toBeVisible()
    await expect(page.locator("#nt-priority-dropdown").getByRole("button")).toBeVisible()
    await expect(page.locator("#new-task-status")).toHaveValue(/.+/)
    const status = page.getByRole("radiogroup", { name: "Task status" })
    await expect(status.getByRole("radio").first()).toBeVisible()
    await expect(page.locator("#nt-recurrence-dropdown").getByRole("button")).toBeVisible()
    await expect(page.locator("#submit-new-task-btn")).toBeVisible()
    await expect(page.locator("#cancel-new-task")).toBeVisible()
  })

  test("New Task modal closes on close button click", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    await page.click("#close-new-task-modal")

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal closes on Cancel button click", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    await page.click("#cancel-new-task")

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal closes on Escape key", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    await page.keyboard.press("Escape")

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal closes on backdrop click", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    // Click the overlay itself (outside the modal-content)
    await overlay.click({ position: { x: 10, y: 10 } })

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal title input autofocuses", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    const titleInput = page.locator("#new-task-title-input")
    await expect(titleInput).toBeFocused()
  })
})
