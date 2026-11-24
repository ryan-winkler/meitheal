import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";
import { saveAppearance } from "../helpers/appearance-settings";

test.describe("Theme accent and keyboard focus", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("meitheal-theme", localStorage.getItem("meitheal-theme") || "dark"));
    await page.goto("/settings#look-and-feel-settings");
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "");
    await expect(page.locator('[data-settings-nav="look-and-feel-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  for (const [theme, surface] of [["light", "#f6f5f0"], ["dark", "#101210"]] as const) {
    test(`keeps keyboard focus visible with a ${theme} surface accent`, async ({ page }) => {
      await page.locator("#theme-select").selectOption(theme)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const picker = page.locator("#accent-color-custom")
      const mintSwatch = page.getByRole("button", { name: "Mint", exact: true })
      const tokens = () => page.locator("html").evaluate(root => {
        const style = getComputedStyle(root)
        return {
          accent: style.getPropertyValue("--accent").trim().toLowerCase(),
          focus: style.getPropertyValue("--border-focus").trim().toLowerCase(),
        }
      })
      // The focus ring follows the readable accent variant; it must stay visible on the page.
      const focusContrast = () => page.locator("html").evaluate(root => {
        const context = document.createElement("canvas").getContext("2d")!
        const luminance = (color: string) => {
          context.fillStyle = color
          context.fillRect(0, 0, 1, 1)
          const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data, value => {
            const fraction = value / 255
            return fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4
          })
          return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
        }
        const focus = luminance(getComputedStyle(root).getPropertyValue("--border-focus").trim())
        const page = luminance(getComputedStyle(document.body).backgroundColor)
        return (Math.max(focus, page) + 0.05) / (Math.min(focus, page) + 0.05)
      })
      const expectSurfaceAccent = async () => {
        await expect.poll(async () => (await tokens()).accent).toBe(surface)
        expect(await focusContrast()).toBeGreaterThanOrEqual(3)
      }
      await saveAppearance(page)
      const baseline = await tokens()
      await picker.fill(surface)
      await saveAppearance(page)
      await expectSurfaceAccent()
      await expect(mintSwatch).toHaveAttribute("aria-pressed", "false")

      await page.getByRole("link", { name: "Today", exact: true }).first().click()
      await expect(page).toHaveURL(/\/today$/)
      await expectSurfaceAccent()
      const sectionLabel = page.locator("#today-triage .page-shell__eyebrow")
      await expect(sectionLabel).toBeVisible()
      const paletteAccent = await sectionLabel.evaluate(element =>
        getComputedStyle(element).getPropertyValue("--accent-text").trim(),
      )
      const accentRgb = paletteAccent.match(/[0-9a-f]{2}/gi)?.map(part => Number.parseInt(part, 16))
      expect(accentRgb).toHaveLength(3)
      await expect(sectionLabel).toHaveCSS("color", `rgb(${accentRgb?.join(", ")})`)
      await page.goBack()
      await expect(page).toHaveURL(/\/settings(?:#.*)?$/)
      await expect(picker).toHaveValue(surface)
      await page.goForward()
      await expect(page).toHaveURL(/\/today$/)
      await expectSurfaceAccent()
      await page.getByRole("link", { name: "Settings", exact: true }).first().click()
      await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("board_id") === "household")
      await expect(page.locator("#look-and-feel-settings")).toBeVisible()
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      await expect(picker).toHaveValue(surface)
      await page.reload()
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      await expectSurfaceAccent()
      const focusRgb = (await tokens()).focus.match(/[0-9a-f]{2}/g)?.map(part => Number.parseInt(part, 16))
      expect(focusRgb).toHaveLength(3)
      await picker.focus()
      await page.keyboard.press("Tab")
      const reset = page.locator("#accent-reset")
      await expect(reset).toBeFocused()
      await expect(reset).toHaveCSS("outline-color", `rgb(${focusRgb?.join(", ")})`)
      await expect(reset).toHaveCSS("outline-width", "2px")
      await page.keyboard.press("Enter")
      await saveAppearance(page)
      await expect.poll(tokens).toEqual(baseline)
      await expect(mintSwatch).toHaveAttribute("aria-pressed", String(theme === "dark"))
      await expect(picker).toHaveValue(baseline.accent)
    })
  }
});
