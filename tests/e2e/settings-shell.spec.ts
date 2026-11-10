import { expect, test, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

const sections = [
  ["personal-settings", "Personal"],
  ["workflow-settings", "Workflow"],
  ["rules-lenses-settings", "Rules & Lenses"],
  ["automation-ai-settings", "Automation & AI"],
  ["integrations-settings", "Integrations"],
  ["app-pwa-settings", "App & PWA"],
  ["danger-zone-settings", "Danger Zone"],
] as const

async function openSettings(page: Page, fragment = ""): Promise<void> {
  await page.goto(`/settings${fragment}`)
  await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
  await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible()
}

async function openSettingsSearch(page: Page) {
  await page.getByRole("button", { name: "Search settings", exact: true }).click()
  const search = page.getByRole("dialog", { name: "Universal Search" })
  await expect(search.getByRole("tab", { name: "Settings", selected: true })).toBeVisible()
  return search
}

test.describe("Settings Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test("all sections use durable links and report the current location", async ({ page }) => {
    await openSettings(page)
    const directory = page.getByRole("navigation", { name: "Sections" })
    for (const [id, label] of sections) {
      const link = directory.getByRole("link", { name: label, exact: true })
      await expect(link).toHaveAttribute("href", `#${id}`)
      await link.click()
      await expect(page).toHaveURL(new RegExp(`#${id}$`))
      await expect(page.getByRole("heading", { name: label, exact: true, level: 2 })).toBeFocused()
      await expect(link).toHaveAttribute("aria-current", "location")
      await expect(page.locator("[data-settings-shell-section]:visible")).toHaveCount(1)
    }
    await page.goBack()
    await expect(directory.getByRole("link", { name: "App & PWA" })).toHaveAttribute("aria-current", "location")
    await page.goForward()
    await expect(directory.getByRole("link", { name: "Danger Zone" })).toHaveAttribute("aria-current", "location")
  })

  test("search jumps directly to matching anchors", async ({ page }) => {
    await openSettings(page)
    const search = await openSettingsSearch(page)
    const searchInput = search.getByRole("searchbox")

    await searchInput.fill("theme")
    await expect(search.locator(".search-hub-item.is-selected .search-hub-item-title")).toHaveText("Theme")

    await searchInput.press("Enter")

    await expect(page).toHaveURL(/#theme-select$/)
    await expect(page.locator("#theme-select")).toBeFocused()
    await expect(page.locator('[data-settings-nav="personal-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    )
  })

  test("dismissing Settings search resets the query and restores launcher focus", async ({ page }) => {
    await openSettings(page)
    const search = await openSettingsSearch(page)
    const searchInput = search.getByRole("searchbox")

    await searchInput.fill("companion")
    await expect(search.getByRole("button", { name: /Companion App Links/ })).toBeVisible()

    await searchInput.press("Escape")

    await expect(search).toBeHidden()
    await expect(page.getByRole("button", { name: "Search settings", exact: true })).toBeFocused()
    await openSettingsSearch(page)
    await expect(searchInput).toHaveValue("")
  })

  test("keyboard search navigation highlights results before jumping", async ({ page }) => {
    await openSettings(page)
    const search = await openSettingsSearch(page)
    const searchInput = search.getByRole("searchbox")
    const results = search.locator(".search-hub-item")

    await searchInput.fill("companion")
    await expect(results.first()).toContainText("Companion App Links")
    await expect(results.first()).toHaveClass(/is-selected/)

    await searchInput.press("ArrowDown")
    await expect(results.nth(1)).toHaveClass(/is-selected/)
    await searchInput.press("ArrowUp")
    await expect(results.first()).toHaveClass(/is-selected/)

    await searchInput.press("Enter")

    await expect(page).toHaveURL(/#pwa-companion-open$/)
    await expect(page.locator('[data-settings-nav="app-pwa-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    )
  })

  test("the desktop directory can collapse and reopen", async ({ page }) => {
    await openSettings(page)
    const toggle = page.getByRole("button", { name: "Sections" })
    const directory = page.getByRole("navigation", { name: "Sections" })
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(directory).toBeHidden()
    await expect(page.getByRole("heading", { name: "Personal", exact: true })).toBeVisible()
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(directory.getByRole("link")).toHaveCount(7)
  })

  test("search opens the destination integration and focuses its control", async ({ page }) => {
    await openSettings(page)
    await page.keyboard.press("/")
    const input = page.locator("#search-hub-input")
    await expect(input).toBeFocused()
    await input.fill("Calendar Sync")
    await page.locator("#search-hub-results").getByRole("button", { name: /Calendar Sync/i }).first().click()
    await expect(page).toHaveURL(/#integration-calendar$/)
    const toggle = page.locator('[aria-controls="integration-calendar-body"]')
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(toggle).toBeFocused()
    await toggle.press("Space")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator("#integration-calendar-body")).toHaveAttribute("inert", "")
    await page.keyboard.press("Tab")
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("#integration-calendar-body")))).toBe(false)
  })

  test("mobile sections are usable with the keyboard at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await openSettings(page, "#danger-zone-settings")
    const picker = page.getByRole("button", { name: "Sections", exact: false })
    await page.evaluate(() => window.scrollTo(0, 240))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
    await expect(picker).toBeInViewport()
    await picker.focus()
    await picker.press("Enter")
    const directory = page.getByRole("navigation", { name: "Sections" })
    await expect(directory.getByRole("link")).toHaveCount(7)
    await page.keyboard.press("Tab")
    await expect(page.getByRole("button", { name: "Search settings" })).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(directory.getByRole("link", { name: "Personal" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(picker).toBeFocused()
    await expect(directory).toBeHidden()
    await picker.press("Enter")
    await directory.getByRole("link", { name: "App & PWA" }).press("Enter")
    await expect(page.getByRole("heading", { name: "App & PWA", exact: true })).toBeFocused()
    await expect(picker).toBeInViewport()
  })

  test("Webhooks links to Automation & AI and App & PWA preserves Companion handoff", async ({ page }) => {
    await openSettings(page, "#integrations-settings")
    await page.locator('[aria-controls="integration-webhooks-body"]').click()
    await page.locator("#integration-webhooks-body .callout-link").click()
    await expect(page).toHaveURL(/#automation-ai-settings$/)
    await expect(page.getByRole("heading", { name: "Automation & AI", exact: true })).toBeFocused()
    await page.locator('[data-settings-nav="app-pwa-settings"]').click()
    await expect(page.locator('[data-companion-link="app-pwa-settings"]')).toHaveAttribute("href", /homeassistant:\/\/navigate.*\/settings#app-pwa-settings/)
    await expect(page.locator("[data-companion-xcallback-preview]")).toContainText("%2Fsettings%23app-pwa-settings")
  })
})
