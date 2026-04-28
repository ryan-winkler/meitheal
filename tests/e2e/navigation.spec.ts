import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.describe("Responsive Navigation", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

  test("Desktop: sidebar is visible by default, toggle is hidden", async ({ page }) => {
    // 1920x1080 is typical desktop
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("#sidebar");
    const menuToggle = page.locator("#menu-toggle");

    await expect(sidebar).toBeVisible();
    await expect(menuToggle).not.toBeVisible();
  });

  test("Mobile: bottom navigation is the primary shell and sidebar stays closed", async ({ page }) => {
    // 375x812 is iPhone X
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("#sidebar");
    const bottomNav = page.locator("#mobile-tab-bar");

    await expect(bottomNav).toBeVisible();
    await expect(sidebar).not.toHaveClass(/open/);
    await expect(sidebar).toHaveCSS("visibility", "hidden");
    await expect(sidebar).toHaveCSS("pointer-events", "none");
  });

  test("Mobile: bottom navigation marks Dashboard active on the dashboard", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bottomNav = page.locator("#mobile-tab-bar");
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.locator('[data-page="dashboard"]')).toHaveClass(/active/);
    await expect(bottomNav.locator('[data-page="dashboard"]')).toHaveAttribute("aria-current", "page");
    await expect(bottomNav.locator('[data-page="today"]')).not.toHaveClass(/active/);
  });

  test("Mobile: closed sidebar is not visible or interactive", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("#sidebar");
    await expect(sidebar).not.toHaveClass(/open/);
    await expect(sidebar).toHaveCSS("visibility", "hidden");
    await expect(sidebar).toHaveCSS("pointer-events", "none");
  });

  test("Mobile: sidebar hierarchy actions are discoverable touch targets when opened", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.locator("#sidebar").evaluate((sidebar) => sidebar.classList.add("open"));

    const firstAction = page.locator(".stree__action-btn").first();
    const actionCount = await page.locator(".stree__action-btn").count();
    test.skip(actionCount === 0, "No hierarchy action buttons in this fixture");

    const metrics = await firstAction.evaluate((action) => {
      const rect = action.getBoundingClientRect();
      const actionGroup = action.closest(".stree__actions");
      return {
        width: rect.width,
        height: rect.height,
        opacity: actionGroup ? getComputedStyle(actionGroup).opacity : "",
      };
    });
    expect(metrics.opacity).toBe("1");
    expect(metrics.width).toBeGreaterThanOrEqual(44);
    expect(metrics.height).toBeGreaterThanOrEqual(44);
  });

  test("Mobile: bottom navigation does not inherit desktop shortcut badges", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bottomNav = page.locator("#mobile-tab-bar");
    await expect(bottomNav).toBeVisible();
    expect(await bottomNav.locator("[data-shortcut]").count()).toBe(0);
    expect(await bottomNav.locator(".shortcut-badge").count()).toBe(0);
  });

  test("Mobile: Calendar tab targets the consolidated task calendar view", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const calendarTab = page.locator('#mobile-tab-bar [data-page="calendar"]');
    await expect(calendarTab).toHaveAttribute("href", "/tasks#calendar");

    await calendarTab.click();
    await expect(page).toHaveURL(/\/tasks#calendar$/);
    await expect(calendarTab).toHaveClass(/active/);
    await expect(calendarTab).toHaveAttribute("aria-current", "page");
  });
});
