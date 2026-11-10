import { test, expect } from "@playwright/test";
import { APPEARANCE_PREFERENCES } from "../../apps/web/src/lib/appearance-preferences"
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

  test("Selecting Custom shows import section", async ({ page }) => {
    const themeSelect = page.locator("#theme-select");
    const customSection = page.locator("#custom-theme-section");

    await themeSelect.selectOption("dark");
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
    await expect(page.locator("#settings-bar h1")).toHaveCSS("font-family", /Outfit/)
    await expect(save).toHaveCSS("border-radius", "6px")
  })

  test("all ten appearance categories apply, persist and reset without changing theme or accent", async ({ page }) => {
    await page.locator("#theme-select").selectOption("dark")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.evaluate(() => {
      localStorage.setItem("meitheal-accent-color", "#ffffff")
      localStorage.setItem("meitheal_sidebar_collapsed", "true")
      localStorage.setItem("meitheal_project_nav_group_collapsed", "false")
    })
    await page.goto("/settings#appearance-settings")
    await page.reload()
    const form = page.locator("#appearance-preferences-form")
    await expect(form.locator("select")).toHaveCount(10)
    const choices = {
      navigation: "navbar", navTone: "accent", font: "comic", base: "mist", radius: "1.5",
      width: "boxed", header: "default", navStyle: "floating", panelStyle: "floating", sidebar: "folded",
    }
    for (const [name, value] of Object.entries(choices)) await form.locator(`[name="${name}"]`).selectOption(value)
    await form.getByRole("button", { name: "Save appearance" }).click()
    await expect(page.locator("#appearance-save-status")).toHaveText("Appearance saved on this device.")
    for (const [name, value] of Object.entries(choices)) {
      const suffix = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
      await expect(page.locator("html")).toHaveAttribute(`data-appearance-${suffix}`, value)
    }
    await expect(page.locator("body")).toHaveCSS("font-family", /Comic Neue/)
    expect(await page.evaluate(() => document.fonts.load('16px "Comic Neue"').then(fonts => fonts.length))).toBeGreaterThan(0)
    await expect(page.locator("#sidebar")).toHaveCSS("position", "relative")
    await expect(page.locator(".main-content")).toHaveCSS("margin-left", "0px")
    await expect(page.locator("#settings-bar")).toHaveCSS("position", "static")
    expect(await page.locator("#main-content").evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1184)
    await expect(page.locator("#task-detail-panel")).toHaveCSS("border-radius", "24px")
    await page.locator("#settings-bar-search-launcher").click()
    await expect(page.locator(".search-hub-panel")).toBeVisible()
    await expect(page.locator(".search-hub-panel")).toHaveCSS("width", "768px")
    await page.keyboard.press("Escape")
    const sidebar = page.locator("#sidebar")
    await expect(sidebar).not.toHaveCSS("background-color", "rgb(255, 255, 255)")
    if (await page.locator("#sidebar-areas-group").count()) {
      await expect(page.locator("#sidebar-areas-group")).not.toHaveAttribute("open", "")
      await page.locator("#project-nav-group-toggle").press("Enter")
      await expect(page.locator("#project-nav-content")).toBeVisible()
      await page.locator("#project-nav-group-toggle").press("Escape")
      await expect(page.locator("#project-nav-group-toggle")).toBeFocused()
      expect(await page.evaluate(() => localStorage.getItem("meitheal_project_nav_group_collapsed"))).toBe("false")
    }
    await page.reload()
    for (const [name, value] of Object.entries(choices)) await expect(form.locator(`[name="${name}"]`)).toHaveValue(value)
    await page.setViewportSize({ width: 320, height: 780 })
    await expect(page.locator("#mobile-tab-bar")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await expect(page.locator("body")).not.toHaveClass(/sidebar-collapsed/)
    await form.getByRole("button", { name: "Reset to defaults" }).click()
    await expect(page.locator("html")).toHaveAttribute("data-appearance-font", "comic")
    await form.getByRole("button", { name: "Save appearance" }).click()
    for (const [name, preference] of Object.entries(APPEARANCE_PREFERENCES)) await expect(form.locator(`[name="${name}"]`)).toHaveValue(preference.defaultValue)
    expect(await page.evaluate(() => localStorage.getItem("meitheal-theme"))).toBe("dark")
    expect(await page.evaluate(() => localStorage.getItem("meitheal-accent-color"))).toBe("#ffffff")
    expect(await page.evaluate(() => localStorage.getItem("meitheal_sidebar_collapsed"))).toBe("true")
  })

  test("sidebar modes preserve remembered state and expand for keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => {
      localStorage.setItem("meitheal_sidebar_collapsed", "false")
      localStorage.setItem("meitheal-appearance", JSON.stringify({ sidebar: "folded" }))
    })
    await page.goto("/settings#appearance-settings")
    await page.reload()
    const sidebar = page.locator("#sidebar")
    const body = page.locator("body")
    await expect(body).toHaveClass(/sidebar-collapsed/)
    const form = page.locator("#appearance-preferences-form")
    await form.locator('[name="sidebar"]').selectOption("expanded")
    await form.getByRole("button", { name: "Save appearance" }).click()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    await page.locator("#sidebar-toggle-btn").click()
    await expect(body).toHaveClass(/sidebar-collapsed/)
    expect(await page.evaluate(() => localStorage.getItem("meitheal_sidebar_collapsed"))).toBe("false")
    await page.reload()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    await form.locator('[name="sidebar"]').selectOption("hover")
    await form.locator('[name="navStyle"]').selectOption("floating")
    await form.getByRole("button", { name: "Save appearance" }).click()
    await page.mouse.move(1000, 700)
    await expect(body).toHaveClass(/sidebar-collapsed/)
    const before = await page.locator(".main-content").evaluate(el => el.getBoundingClientRect().left)
    await sidebar.locator('a[href="/today"]').first().focus()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    expect(await page.locator(".main-content").evaluate(el => el.getBoundingClientRect().left)).toBe(before)
    await form.locator('[name="sidebar"]').focus()
    await expect(body).toHaveClass(/sidebar-collapsed/)
    await form.locator('[name="sidebar"]').selectOption("remember")
    await form.getByRole("button", { name: "Save appearance" }).click()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
  })

  test("neutral palette follows Light and Auto while fluid width and sticky headers remain effective", async ({ page }) => {
    await page.setViewportSize({ width: 2000, height: 1000 })
    await page.goto("/settings#appearance-settings")
    const form = page.locator("#appearance-preferences-form")
    await form.locator('[name="base"]').selectOption("stone")
    await form.locator('[name="navigation"]').selectOption("navbar")
    await form.locator('[name="width"]').selectOption("fluid")
    await form.getByRole("button", { name: "Save appearance" }).click()
    expect(await page.locator("#settings-shell").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(1280)
    await expect(page.locator("#settings-bar")).toHaveCSS("position", "sticky")
    await expect(page.locator("#settings-bar")).toHaveCSS("top", "64px")
    await page.goto("/settings#personal-settings")
    await page.locator("#theme-select").selectOption("light")
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-primary-rgb").trim())).toBe("250 250 249")
    await page.emulateMedia({ colorScheme: "light" })
    await page.locator("#theme-select").selectOption("auto")
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-primary-rgb").trim())).toBe("250 250 249")
    await page.emulateMedia({ colorScheme: "dark" })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-primary-rgb").trim())).toBe("28 25 23")
  })

  test("appearance preserves other saved preferences and keeps the draft if storage rejects it", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem("meitheal-appearance", JSON.stringify({
      font: "invalid", radius: "9", navigation: "navbar", futurePreference: "retained",
    })))
    await page.goto("/settings#appearance-settings")
    await page.reload()
    const root = page.locator("html")
    const font = page.getByLabel("Typeface", { exact: true })
    const radius = page.getByLabel("Corner roundness", { exact: true })
    const save = page.getByRole("button", { name: "Save appearance" })
    const status = page.locator("#appearance-save-status")
    await expect(font).toHaveValue("sans")
    await expect(radius).toHaveValue("1")
    await font.selectOption("mono")
    await radius.selectOption("1.5")
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key === "meitheal-appearance") throw new DOMException("Storage blocked by fixture")
        setItem.call(this, key, value)
      }
    })
    await save.click()
    await expect(status).toHaveText("Appearance could not be saved in this browser.")
    await expect(font).toHaveValue("mono")
    await expect(radius).toHaveValue("1.5")
    await expect(root).toHaveAttribute("data-appearance-font", "sans")
    await expect(root).toHaveAttribute("data-appearance-radius", "1")

    await page.reload()
    await font.selectOption("mono")
    await radius.selectOption("1.5")
    await save.click()
    await expect(status).toHaveText("Appearance saved on this device.")
    await expect(page.locator("body")).toHaveCSS("font-family", /monospace/)
    await expect(save).toHaveCSS("border-radius", "9px")
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meitheal-appearance")!))).toEqual({
      navigation: "navbar", navTone: "match", font: "mono", base: "slate", radius: "1.5",
      width: "default", header: "sticky", navStyle: "attached", panelStyle: "attached", sidebar: "remember",
      futurePreference: "retained",
    })
  })
});
