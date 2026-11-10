import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

// Manual capture tool: CI has neither an app server nor installed browser binaries.
test.skip(shouldSkipBrowserSpecs() || process.env.MEITHEAL_CAPTURE_SCREENSHOT !== "1", "Set E2E_BASE_URL and MEITHEAL_CAPTURE_SCREENSHOT=1 for an explicit UI capture")

test("capture the advanced task filter", async ({ page }, testInfo) => {
  await page.goto("/tasks")
  const toggle = page.locator("#kanban-advanced-toggle")
  await expect(toggle).toBeVisible()
  await toggle.click()
  const panel = page.locator("#kanban-advanced-panel")
  await expect(panel).toBeVisible()
  await page.locator("#kanban-advanced-add-condition").click()
  await expect(panel.locator(".advanced-filter-row")).not.toHaveCount(0)
  const screenshot = testInfo.outputPath("advanced-filter.png")
  await page.screenshot({ path: screenshot, fullPage: true })
  await testInfo.attach("Advanced task filter", { path: screenshot, contentType: "image/png" })
})
