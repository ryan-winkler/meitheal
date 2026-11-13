import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.describe("Theme Settings", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("meitheal-theme", localStorage.getItem("meitheal-theme") || "dark"));
    await page.goto("/settings#personal-settings");
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "");
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
    await expect(page.locator("#appearance-settings > summary")).toHaveText("Saincheap an chuma")

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

  test("Theme persists across page reload", async ({ page }) => {
    const themeSelect = page.locator("#theme-select");

    // Select light
    await themeSelect.selectOption("light");
    await page.waitForTimeout(500);

    // Re-open the page to verify persistence across a fresh navigation
    await page.goto("/settings#personal-settings");
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "");

    // Theme should still be light
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "light");
  });

  test("typeface and corners apply on save and survive navigation and reset", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 })
    await page.goto("/settings#appearance-settings")
    const root = page.locator("html")
    const summary = page.locator("#appearance-settings > summary")
    const font = page.getByLabel("Typeface", { exact: true })
    const radius = page.getByLabel("Corner roundness", { exact: true })
    const save = page.getByRole("button", { name: "Save appearance" })
    const status = page.locator("#appearance-save-status")
    await expect(summary).toBeFocused()
    await expect(font).toBeVisible()
    await expect(radius).toHaveValue("1")
    await font.selectOption("serif")
    await radius.selectOption("0")
    await expect(root).toHaveAttribute("data-appearance-font", "sans")
    await expect(root).toHaveAttribute("data-appearance-radius", "1")
    await save.click()
    await expect(status).toHaveText("Appearance saved on this device.")
    await expect(page.locator("body")).toHaveCSS("font-family", /Georgia/)
    await expect(page.locator("#settings-bar h1")).toHaveCSS("font-family", /Georgia/)
    await expect(save).toHaveCSS("border-radius", "0px")

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => {
      document.addEventListener("astro:after-swap", () => { sessionStorage.setItem("appearance-swap-fixture", "done") }, { once: true })
    })
    await page.locator('#sidebar a[href="/today"]').first().click()
    await expect(page).toHaveURL(/\/today(?:#|$)/)
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("appearance-swap-fixture"))).toBe("done")
    await expect(root).toHaveAttribute("data-appearance-font", "serif")
    await expect(root).toHaveAttribute("data-appearance-radius", "0")

    await page.goto("/settings#appearance-settings")
    await expect(font).toHaveValue("serif")
    await expect(radius).toHaveValue("0")
    await page.getByRole("button", { name: "Reset to defaults" }).click()
    await expect(status).toHaveText("Default choices selected. Save to apply them.")
    await expect(root).toHaveAttribute("data-appearance-font", "serif")
    await expect(font).toHaveValue("sans")
    await expect(radius).toHaveValue("1")
    await save.click()
    await expect(root).toHaveAttribute("data-appearance-font", "sans")
    await expect(root).toHaveAttribute("data-appearance-radius", "1")
    await expect(page.locator("#settings-bar h1")).toHaveCSS("font-family", /Geist Variable/)
    await expect(save).toHaveCSS("border-radius", "6px")
  })


});
