import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.describe("Theme accent and keyboard focus", () => {
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

  for (const [theme, surface] of [["light", "#f8fafc"], ["dark", "#0f172a"]] as const) {
    test(`keeps keyboard focus visible with a ${theme} surface accent`, async ({ page }) => {
      await page.locator("#theme-select").selectOption(theme)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
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
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
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
