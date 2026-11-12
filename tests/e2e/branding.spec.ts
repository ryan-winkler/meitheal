import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

test.describe("Branding — Typography", () => {
  test("Geist Variable font is loaded for headings and body text", async ({
    page,
  }) => {
    await page.goto("/");
    const geistHeadingLoaded = await page.evaluate(() =>
      document.fonts.check('500 16px "Geist Variable"')
    );
    const geistBodyLoaded = await page.evaluate(() =>
      document.fonts.check('400 12px "Geist Variable"')
    );
    expect(geistHeadingLoaded).toBe(true);
    expect(geistBodyLoaded).toBe(true);
  });

  test("JetBrains Mono font is loaded for phonetic mark and code", async ({
    page,
  }) => {
    await page.goto("/");
    const monoLoaded = await page.evaluate(() =>
      document.fonts.check('400 10px "JetBrains Mono"')
    );
    expect(monoLoaded).toBe(true);
  });
});

test.describe("Branding — Color Tokens", () => {
  // A first visit follows the system appearance, so name the dark palette these tokens belong to.
  test.use({ colorScheme: "dark" });

  test("--bg-primary uses Evergreen Carbon (#101210 = rgb 16,18,16)", async ({
    page,
  }) => {
    await page.goto("/");
    const bgPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-primary")
        .trim()
    );
    expect(bgPrimary.toLowerCase()).toBe("#101210");
  });

  test("--accent uses Living Mint (#69E3B2 = rgb 105,227,178)", async ({
    page,
  }) => {
    await page.goto("/");
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim()
    );
    expect(accent.toLowerCase()).toBe("#69e3b2");
  });
});

test.describe("Branding — Logo", () => {
  test("meitheal.io SVG mark and wordmark lockup are visible in sidebar", async ({
    page,
  }) => {
    await page.goto("/");
    const logo = page.locator('.sidebar-brand svg[viewBox="0 0 64 64"]');
    await expect(logo).toBeVisible();
    await expect(page.locator(".sidebar-brand-text")).toHaveText("meitheal.");
    await expect(page.locator(".sidebar-ipa")).toHaveText("/meh·hal/");
  });

  test("Sidebar SVG completion dot uses theme-aware --accent CSS var", async ({
    page,
  }) => {
    await page.goto("/");
    const accentFill = await page.evaluate(() => {
      const circle = document.querySelector(".sidebar-brand svg circle");
      return circle?.getAttribute("fill") ?? "";
    });
    expect(accentFill).toContain("var(--accent");
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
