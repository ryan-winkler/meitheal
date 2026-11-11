import { expect, test } from "@playwright/test"

test("resize diagnostics stay quiet while real uncaught failures still notify", async ({ page }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable App")
  await page.goto("/today")
  await page.waitForLoadState("networkidle")
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__meitheal_error_handler_registered))).toBe(true)
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", {
    message: "ResizeObserver loop completed with undelivered notifications.", filename: location.href,
  })))
  await expect(page.getByText("Something went wrong. Check console for details.", { exact: true })).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", {
    message: "Fixture application failure", filename: location.href,
  })))
  await expect(page.locator("#toast-container")).toContainText("Something went wrong")
})
