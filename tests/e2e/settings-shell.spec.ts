import { expect, test, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

async function waitForSettingsShell(page: Page): Promise<void> {
  await expect(page.locator("#settings-shell")).toBeVisible()
  await expect(page.locator("[data-settings-shell-section]").first()).toBeVisible()
}

test.describe("Settings Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/settings")
    await waitForSettingsShell(page)
  })

  test("search jumps directly to matching anchors", async ({ page }) => {
    const searchInput = page.locator("#settings-search-input")

    await searchInput.fill("theme")
    await expect(
      page.locator("#settings-search-results .settings-search-results__item").first(),
    ).toContainText("Theme")

    await searchInput.press("Enter")

    await expect(page).toHaveURL(/#theme-select$/)
    await expect(page.locator('[data-settings-nav="personal-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    )
  })

  test("summary cards are clickable quick jumps that sync with section nav", async ({ page }) => {
    const summaryCard = page.locator('[data-settings-summary="app-pwa-settings"]').first()
    const navCard = page.locator('[data-settings-nav="app-pwa-settings"]').first()

    await expect(summaryCard).toHaveAttribute("href", "#app-pwa-settings")

    await summaryCard.click()

    await expect(page).toHaveURL(/#app-pwa-settings$/)
    await expect(summaryCard).toHaveAttribute("aria-current", "location")
    await expect(navCard).toHaveAttribute("aria-current", "location")
    await expect(page.locator("#app-pwa-settings")).toBeVisible()
  })

  test("search clear resets results and removes muted section state", async ({ page }) => {
    const searchInput = page.locator("#settings-search-input")
    const clearButton = page.locator("#settings-search-clear")
    const workflowSection = page.locator("#workflow-settings")

    await searchInput.fill("companion")

    await expect(clearButton).toBeVisible()
    await expect(page.locator("#settings-search-results")).toBeVisible()
    await expect(workflowSection).toHaveClass(/settings-shell__section--muted/)

    await clearButton.click()

    await expect(searchInput).toHaveValue("")
    await expect(page.locator("#settings-search-results")).toBeHidden()
    await expect(workflowSection).not.toHaveClass(/settings-shell__section--muted/)
  })

  test("keyboard search navigation highlights results before jumping", async ({ page }) => {
    const searchInput = page.locator("#settings-search-input")

    await searchInput.fill("companion")
    await searchInput.press("ArrowDown")

    await expect(
      page.locator("#settings-search-results .settings-search-results__item").first(),
    ).toHaveClass(/is-active/)

    await searchInput.press("Enter")

    await expect(page).toHaveURL(/#(app-pwa-settings|pwa-companion-open)$/)
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
