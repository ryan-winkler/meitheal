import { expect, test, type Locator, type Page } from "@playwright/test"
import { SETTINGS_SECTIONS } from "../../apps/web/src/lib/settings-registry"
import { shouldSkipBrowserSpecs } from "./_helpers"

async function openSettings(page: Page, fragment = "personal-settings") {
  await page.goto(`/settings#${fragment}`)
  await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
}

async function contrastAgainst(element: Locator, surface: string): Promise<number> {
  return element.evaluate((node, surface) => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d")!
    const luminance = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(channel => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }
    const foreground = luminance(getComputedStyle(node).color)
    const background = luminance(getComputedStyle(node.closest(surface)!).backgroundColor)
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
  }, surface)
}

test.describe("Tabler Settings recovery", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

  test("outline directory keeps canonical section links, theme choices and mobile keyboard navigation", async ({ page }) => {
    await openSettings(page)
    expect((await page.locator("#theme-select option").allTextContents()).sort()).toEqual(["Auto (System)", "Light", "Dark", "Custom"].sort())
    const directory = page.getByRole("navigation", { name: "Sections", exact: true })
    for (const section of SETTINGS_SECTIONS) {
      const link = directory.getByRole("link", { name: section.label, exact: true })
      await expect(link).toHaveAttribute("href", `#${section.id}`)
      await expect(link.locator("svg")).toHaveCount(1)
      await expect(link.locator("svg")).toHaveAttribute("aria-hidden", "true")
      expect(await link.locator("svg :is(path, rect, circle, line)").count()).toBeGreaterThan(0)
      await link.press("Enter")
      await expect(page).toHaveURL(new RegExp(`#${section.id}$`))
      await expect(link).toHaveAttribute("aria-current", "location")
      await expect(page.getByRole("heading", { name: section.label, exact: true, level: 2 })).toBeFocused()
    }
    await page.setViewportSize({ width: 320, height: 740 })
    await page.locator("#settings-sections-toggle").press("Enter")
    await expect(directory).toBeVisible()
    await directory.getByRole("link", { name: "Integrations", exact: true }).press("Enter")
    await expect(page.getByRole("heading", { name: "Integrations", exact: true, level: 2 })).toBeFocused()
    await expect(directory).toBeHidden()
  })

  test("integration outline and help controls remain labeled, separate and readable in Light and Dark", async ({ page }) => {
    await openSettings(page)
    for (const theme of ["light", "dark"]) {
      await page.locator("#theme-select").selectOption(theme)
      await page.locator('[data-settings-nav="integrations-settings"]').press("Enter")
      for (const id of ["ha", "calendar", "todo", "grocy", "n8n", "webhooks"]) {
        const card = page.locator(`#integration-${id}`)
        const heading = card.locator(".integration-card__header")
        const help = card.locator(`.info-btn[data-explainer="${id}"]`)
        await expect(heading.locator(".integration-card__icon svg")).toHaveAttribute("aria-hidden", "true")
        await expect(heading.locator("button")).toHaveCount(0)
        await expect(help).toHaveAttribute("aria-label", /\S+/)
        await expect(help.locator("svg")).toHaveAttribute("aria-hidden", "true")
        const size = await help.boundingBox()
        expect(size!.width).toBeGreaterThanOrEqual(44)
        expect(size!.height).toBeGreaterThanOrEqual(44)
        expect(await contrastAgainst(help, ".integration-card__heading")).toBeGreaterThanOrEqual(3)
      }
      const card = page.locator("#integration-ha")
      const heading = card.locator(".integration-card__header")
      await heading.press("Enter")
      await expect(heading).toHaveAttribute("aria-expanded", "true")
      const help = card.locator('.info-btn[data-explainer="ha"]')
      await help.press("Enter")
      const dialog = page.locator("#integration-explainer-dialog")
      await expect(dialog).toBeVisible()
      await expect(dialog.locator("#explainer-title")).not.toBeEmpty()
      await page.keyboard.press("Escape")
      await expect(dialog).toBeHidden()
      await expect(help).toBeFocused()
      await expect(heading).toHaveAttribute("aria-expanded", "true")
      await heading.press("Enter")
      await page.locator('[data-settings-nav="app-pwa-settings"]').press("Enter")
      const security = page.getByRole("link", { name: "Report a security vulnerability privately", exact: true })
      await expect(security).toHaveAttribute("href", "mailto:info@coolockvillage.ie")
      expect(await security.evaluate(element => getComputedStyle(element).textDecorationLine)).toContain("underline")
      expect(await contrastAgainst(security, "#local-feedback")).toBeGreaterThanOrEqual(4.5)
      await page.locator('[data-settings-nav="personal-settings"]').press("Enter")
    }
  })

  test("disclosures announce their subtitle once and cards use the shared inset", async ({ page }) => {
    await openSettings(page, "rules-lenses-settings")
    const disclosure = page.locator("#ai-scope-disclosure")
    const summary = disclosure.locator(":scope > summary")
    const subtitle = await summary.locator("small").innerText()
    await expect(disclosure.getByText(subtitle, { exact: true })).toHaveCount(1)
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await summary.evaluate(element => getComputedStyle(element).paddingInlineStart)).toBe("16px")
    await summary.press("Space")
    await expect(disclosure).toHaveAttribute("open", "")
    await expect(summary).toBeFocused()
    await summary.press("Space")
    await expect(disclosure).not.toHaveAttribute("open", "")
    const card = page.locator(".settings-panel-card:visible").first()
    expect(await card.evaluate(element => getComputedStyle(element).paddingInlineStart)).toBe("16px")
    await page.addStyleTag({ content: ":root { --settings-inset: 20px; }" })
    expect(await card.evaluate(element => getComputedStyle(element).paddingInlineStart)).toBe("20px")
  })
})
