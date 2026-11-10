import { expect, test, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

async function waitForSettingsShell(page: Page): Promise<void> {
  await expect(page.locator("#settings-shell")).toBeVisible()
  await expect(page.locator("[data-settings-shell-section]").first()).toBeVisible()
}

async function openSettingsSearch(page: Page) {
  await page.getByRole("button", { name: "Search settings…", exact: true }).click()
  const search = page.getByRole("dialog", { name: "Universal Search" })
  await expect(search.getByRole("tab", { name: "Settings", selected: true })).toBeVisible()
  return search
}

test.describe("Settings Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings")
    await waitForSettingsShell(page)
  })

  test("search jumps directly to matching anchors", async ({ page }) => {
    const search = await openSettingsSearch(page)
    const searchInput = search.getByRole("searchbox")

    await searchInput.fill("theme")
    await expect(search.locator(".search-hub-item.is-selected .search-hub-item-title")).toHaveText("Theme")

    await searchInput.press("Enter")

    await expect(page).toHaveURL(/#theme-select$/)
    await expect(page.locator("#theme-select")).toBeVisible()
    await expect(page.locator('[data-settings-nav="personal-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    )
  })

  test("desktop quick jumps keep section navigation in sync", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    const quickJump = page.getByRole("navigation", { name: "Settings quick navigation" })
      .getByRole("link", { name: "App & PWA", exact: true })
    const navCard = page.locator('[data-settings-nav="app-pwa-settings"]').first()

    await expect(quickJump).toHaveAttribute("href", "#app-pwa-settings")
    await quickJump.click()

    await expect(page).toHaveURL(/#app-pwa-settings$/)
    await expect(quickJump).toHaveAttribute("aria-current", "location")
    await expect(navCard).toHaveAttribute("aria-current", "location")
    await expect(page.locator("#app-pwa-settings")).toBeVisible()
  })

  test("section picker stays open through queued scroll and dismisses when the page moves", async ({ page }) => {
    const picker = page.getByRole("button", { name: "Settings — switch section" })
    const menu = page.getByRole("menu", { name: "Settings sections" })

    const opened = await picker.evaluate(async (button) => {
      const trigger = button as HTMLButtonElement
      const scrolled = new Promise<void>((resolve) => {
        window.addEventListener("scroll", () => resolve(), { once: true })
      })
      // Open before the browser dispatches the scroll event.
      window.scrollBy({ top: 6, behavior: "instant" })
      trigger.click()
      const expanded = trigger.getAttribute("aria-expanded")
      await scrolled
      return expanded
    })

    expect(opened).toBe("true")
    await expect(picker).toHaveAttribute("aria-expanded", "true")
    await expect(menu).toBeVisible()

    await page.evaluate(() => window.scrollBy({ top: 100, behavior: "instant" }))

    await expect(picker).toHaveAttribute("aria-expanded", "false")
    await expect(menu).toBeHidden()

    await picker.click()
    await menu.getByRole("menuitem", { name: "App & PWA", exact: true }).press("Enter")
    await expect(page).toHaveURL(/#app-pwa-settings$/)
  })

  test("dismissing Settings search resets the query and restores launcher focus", async ({ page }) => {
    const search = await openSettingsSearch(page)
    const searchInput = search.getByRole("searchbox")

    await searchInput.fill("companion")
    await expect(search.getByRole("button", { name: /Companion App Links/ })).toBeVisible()

    await searchInput.press("Escape")

    await expect(search).toBeHidden()
    await expect(page.getByRole("button", { name: "Search settings…", exact: true })).toBeFocused()
    await openSettingsSearch(page)
    await expect(searchInput).toHaveValue("")
  })

  test("keyboard search navigation highlights results before jumping", async ({ page }) => {
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

  test("webhooks callout uses the canonical automation and ai section id", async ({ page }) => {
    await page.goto("/settings#integrations-settings")
    await waitForSettingsShell(page)

    await page.locator('[aria-controls="integration-webhooks-body"]').click()

    const calloutLink = page.locator("#integration-webhooks-body .callout-link")
    await expect(calloutLink).toHaveAttribute("href", "#automation-ai-settings")

    await calloutLink.click()

    await expect(page).toHaveURL(/#automation-ai-settings$/)
    await expect(page.locator('[data-settings-nav="automation-ai-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    )
  })

  test("app and pwa section exposes companion url handler and x-callback targets", async ({
    page,
  }) => {
    await page.goto("/settings#app-pwa-settings")
    await waitForSettingsShell(page)

    await expect(page.locator("#app-pwa-settings")).toBeVisible()
    await expect(page.locator('[data-companion-link="app-pwa-settings"]')).toHaveAttribute(
      "href",
      /homeassistant:\/\/navigate.*\/settings#app-pwa-settings/,
    )
    await expect(page.locator("[data-companion-xcallback-preview]")).toContainText(
      "homeassistant://x-callback-url/navigate?path=",
    )
    await expect(page.locator("[data-companion-xcallback-preview]")).toContainText(
      "%2Fsettings%23app-pwa-settings",
    )
  })

  test("hash deep links keep the target section addressable", async ({ page }) => {
    await page.goto("/settings#danger-zone-settings")
    await waitForSettingsShell(page)

    await expect(page).toHaveURL(/#danger-zone-settings$/)
    await expect(page.locator("#danger-zone-settings")).toBeVisible()
    await expect(page.locator("#reset-settings")).toBeVisible()
  })

  test("mobile nav works as a compact quick-jump surface", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto("/settings")
    await waitForSettingsShell(page)

    const mobileNavLink = page.locator(
      '[data-settings-nav="app-pwa-settings"][data-settings-nav-variant="mobile"]',
    )

    await expect(mobileNavLink).toBeVisible()
    const box = await mobileNavLink.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)

    await mobileNavLink.click()

    await expect(page).toHaveURL(/#app-pwa-settings$/)
    await expect(page.locator("#app-pwa-settings")).toBeVisible()
  })
})
