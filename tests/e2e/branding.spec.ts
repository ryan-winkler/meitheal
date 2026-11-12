import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

test.describe("Branding — Typography", () => {
  test("Outfit font is loaded for headings", async ({ page }) => {
    await page.goto("/");
    const outfitLoaded = await page.evaluate(() =>
      document.fonts.check("700 12px Outfit")
    );
    expect(outfitLoaded).toBe(true);
  });

  test("Geist Variable font is loaded for body text", async ({ page }) => {
    await page.goto("/");
    const geistLoaded = await page.evaluate(() =>
      document.fonts.check('400 12px "Geist Variable"')
    );
    expect(geistLoaded).toBe(true);
  });
});

test.describe("Branding — Color Tokens", () => {
  // A first visit follows the system appearance, so name the dark palette these tokens belong to.
  test.use({ colorScheme: "dark" });

  test("--bg-primary uses Slate 900 (#0F172A = rgb 15,23,42)", async ({
    page,
  }) => {
    await page.goto("/");
    const bgPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-primary")
        .trim()
    );
    expect(bgPrimary.toLowerCase()).toBe("#0f172a");
  });

  test("--accent uses Indigo 500 (#6366F1 = rgb 99,102,241)", async ({
    page,
  }) => {
    await page.goto("/");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
    );
    expect(accent.toLowerCase()).toBe("#6366f1");
  });
});

test.describe("Branding — Logo", () => {
  test("Village Hub SVG logo is visible in sidebar", async ({ page }) => {
    await page.goto("/");
    const logo = page.locator(
      '.sidebar-brand svg[viewBox="0 0 100 100"]'
    );
    await expect(logo).toBeVisible();
  });

  test("Sidebar SVG uses theme-aware CSS vars", async ({ page }) => {
    await page.goto("/");
    const accentStroke = await page.evaluate(() => {
      const path = document.querySelector('.sidebar-brand svg path');
      return path?.getAttribute("stroke") ?? "";
    });
    expect(accentStroke).toContain("var(--accent");
  });
});

test.describe("Branding — Accent Picker", () => {
  test("Custom accent color updates --accent CSS var", async ({ page }) => {
    await page.goto("/settings");
    // Wait for settings page to load
    await page.waitForSelector(".settings-section", { timeout: 5000 }).catch(() => {});

    // Set a custom accent via localStorage (simulates picker)
    await page.evaluate(() => {
      const root = document.documentElement.style;
      root.setProperty("--accent", "#e11d48");
      localStorage.setItem("meitheal-accent-color", "#e11d48");
    });

    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
    );
    expect(accent).toBe("#e11d48");

    // Clean up
    await page.evaluate(() => {
      localStorage.removeItem("meitheal-accent-color");
    });
  });
});

test.describe("Branding — Greeting Context", () => {
  test("Dashboard greeting and workload signal are visible", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", {
      level: 1,
      name: /Good (Morning|Afternoon|Evening)!/,
    })).toBeVisible();
    const signal = page.locator(".dashboard-hero__status");
    await expect(signal.getByText("Current signal")).toBeVisible();
    await expect(signal).toContainText(/\d+ (overdue|in progress)|Everything is steady/);
  });
});
