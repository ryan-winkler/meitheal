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

  test("Language changes reload the matching client dictionary", async ({ page }) => {
    const html = page.locator("html")
    const lookup = () => page.evaluate(() => (window as Window & {
      mI18n: { get(key: string): string }
    }).mI18n.get("nav.today"))

    await expect(html).toHaveAttribute("lang", "en")
    expect(await lookup()).toBe("Today")

    await page.locator("#locale-select").selectOption("ga")
    await expect(html).toHaveAttribute("lang", "ga")
    expect(await lookup()).toBe("Inniu")

    await page.locator("#locale-select").selectOption("en")
    await expect(html).toHaveAttribute("lang", "en")
    expect(await lookup()).toBe("Today")
  })

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

  for (const [theme, surface] of [["light", "#f8fafc"], ["dark", "#0f172a"]] as const) {
    test(`keeps keyboard focus visible with a ${theme} surface accent`, async ({ page }) => {
      await page.locator("#theme-select").selectOption(theme)
      const picker = page.locator("#accent-color-custom")
      const tokens = () => page.locator("html").evaluate(root => {
        const style = getComputedStyle(root)
        return {
          accent: style.getPropertyValue("--accent").trim().toLowerCase(),
          focus: style.getPropertyValue("--border-focus").trim().toLowerCase(),
        }
      })
      const baseline = await tokens()
      const focusRgb = baseline.focus.match(/[0-9a-f]{2}/g)?.map(part => Number.parseInt(part, 16))
      expect(focusRgb).toHaveLength(3)
      await picker.fill(surface)
      await expect.poll(tokens).toEqual({ accent: surface, focus: baseline.focus })
      await expect(page.getByRole("button", { name: "Indigo (Default)" })).toHaveAttribute("aria-pressed", "false")

      await page.getByRole("link", { name: "Today", exact: true }).first().click()
      await expect(page).toHaveURL(/\/today$/)
      await expect.poll(tokens).toEqual({ accent: surface, focus: baseline.focus })
      const eyebrow = page.locator("#today-overview .page-hero__eyebrow")
      const paletteAccent = await eyebrow.evaluate(element =>
        getComputedStyle(element).getPropertyValue("--accent-text").trim(),
      )
      const accentRgb = paletteAccent.match(/[0-9a-f]{2}/gi)?.map(part => Number.parseInt(part, 16))
      expect(accentRgb).toHaveLength(3)
      await expect(eyebrow).toHaveCSS("color", `rgb(${accentRgb?.join(", ")})`)
      await page.goBack()
      await expect(page).toHaveURL(/\/settings(?:#.*)?$/)
      await expect(picker).toHaveValue(surface)
      await page.goForward()
      await expect(page).toHaveURL(/\/today$/)
      await expect.poll(tokens).toEqual({ accent: surface, focus: baseline.focus })
      await page.getByRole("link", { name: "Settings", exact: true }).first().click()
      await expect(picker).toHaveValue(surface)
      await page.reload()
      await expect.poll(tokens).toEqual({ accent: surface, focus: baseline.focus })
      await picker.focus()
      await page.keyboard.press("Tab")
      const reset = page.locator("#accent-reset")
      await expect(reset).toBeFocused()
      await expect(reset).toHaveCSS("outline-color", `rgb(${focusRgb?.join(", ")})`)
      await expect(reset).toHaveCSS("outline-width", "2px")
      await page.keyboard.press("Enter")
      await expect.poll(tokens).toEqual(baseline)
      await expect(page.getByRole("button", { name: "Indigo (Default)" })).toHaveAttribute("aria-pressed", "true")
    })
  }
});
