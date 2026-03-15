import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.describe("Theme Settings", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings#personal-settings");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-settings-nav="personal-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  test("Theme select has all 4 options (Dark, Light, Auto, Custom)", async ({ page }) => {
    const themeSelect = page.locator("#theme-select");
    await expect(themeSelect).toBeVisible();

    const options = await themeSelect.locator("option").allTextContents();
    expect(options).toContain("Dark");
    expect(options).toContain("Light");
    expect(options).toContain("Auto (System)");
    expect(options).toContain("Custom");
  });

  test("Selecting Light applies data-theme=light and .light class", async ({ page }) => {
    const themeSelect = page.locator("#theme-select");
    await themeSelect.selectOption("light");

    // Wait for theme-watcher to apply changes
    await page.waitForTimeout(200);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(html).toHaveClass(/light/);
  });

  test("Selecting Dark applies .dark class", async ({ page }) => {
    // First switch to light to ensure we're testing the toggle
    const themeSelect = page.locator("#theme-select");
    await themeSelect.selectOption("light");
    await page.waitForTimeout(200);

    // Switch back to dark
    await themeSelect.selectOption("dark");
    await page.waitForTimeout(200);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await expect(html).toHaveClass(/dark/);
  });

  test("Selecting Custom shows import section", async ({ page }) => {
    const themeSelect = page.locator("#theme-select");
    const customSection = page.locator("#custom-theme-section");

    // Custom section should be hidden initially (dark is default)
    await expect(customSection).not.toBeVisible();

    // Select custom
    await themeSelect.selectOption("custom");
    await page.waitForTimeout(200);

    // Custom section should now be visible
    await expect(customSection).toBeVisible();

    // Import button and info text should be visible
    await expect(page.locator("#custom-theme-empty")).toBeVisible();
    await expect(page.getByText("Import CSS Theme")).toBeVisible();
  });

  test("Switching away from Custom hides import section", async ({ page }) => {
    const themeSelect = page.locator("#theme-select");
    const customSection = page.locator("#custom-theme-section");

    // Select custom first
    await themeSelect.selectOption("custom");
    await page.waitForTimeout(200);
    await expect(customSection).toBeVisible();

    // Switch to dark
    await themeSelect.selectOption("dark");
    await page.waitForTimeout(200);
    await expect(customSection).not.toBeVisible();
  });

  test("Theme persists across page reload", async ({ page }) => {
    const themeSelect = page.locator("#theme-select");

    // Select light
    await themeSelect.selectOption("light");
    await page.waitForTimeout(500);

    // Re-open the page to verify persistence across a fresh navigation
    await page.goto("/settings#personal-settings");
    await page.waitForLoadState("networkidle");

    // Theme should still be light
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
  });
});
