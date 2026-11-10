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

  for (const [locale, disableAll] of [["en", "Disable all"], ["ga", "Díchumasaigh uile"]] as const) {
    test(`Calendar and To-do actions fit at 320px in ${locale}`, async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width: 320, height: 720 })
      await context.addCookies([{ name: "meitheal-locale", value: locale, url: baseURL! }])
      await page.route("**/api/integrations/calendar/status", (route) => route.fulfill({
        json: { ok: true, calendars: [{ entity_id: "calendar.family", friendly_name: "Family calendar", state: "off" }] },
      }))
      await page.route("**/api/todo", (route) => route.fulfill({
        json: { ok: true, entities: [{ entity_id: "todo.shopping", friendly_name: "Shopping list", state: "0" }] },
      }))

      await page.goto("/settings#integration-calendar")
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      for (const id of ["cal-disable-all", "todo-disable-all"]) {
        if (id.startsWith("todo")) await page.locator('[aria-controls="integration-todo-body"]').click()
        const button = page.locator(`#${id}`)
        await expect(button).toHaveAccessibleName(disableAll)
        await button.scrollIntoViewIfNeeded()
        await expect(button).toBeInViewport({ ratio: 1 })
        const box = await button.boundingBox()
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }
    })
  }

  test("retry hydrates stored values before enabling controls", async ({ page }) => {
    let reads = 0
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      reads += 1
      if (reads === 1) return route.fulfill({ status: 503, json: {} })
      return route.fulfill({ json: { timezone: "UTC" } })
    })
    await page.goto("/settings")
    await expect(page.getByRole("alert")).toContainText("Settings could not load")
    await expect(page.locator("#settings-panels")).toHaveAttribute("inert", "")
    await page.getByRole("button", { name: "Try again" }).click()
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    await expect(page.locator("#timezone-select")).toHaveValue("UTC")
    expect(reads).toBe(2)
  })

  for (const status of [403, 503]) {
    test(`a rejected ${status} preference write restores the prior value`, async ({ page }) => {
      await page.route("**/api/settings", (route) => route.request().method() === "PUT"
        ? route.fulfill({ status, json: {} })
        : route.fulfill({ json: { timezone: "Europe/Dublin" } }))
      await openSettings(page)
      await page.locator("#timezone-select").selectOption("UTC")
      await expect(page.locator("#toast-container .toast.error")).toContainText(/could not be saved/i)
      await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
      await expect(page.locator("#timezone-select")).toHaveValue("Europe/Dublin")
      expect(await page.evaluate(() => localStorage.getItem("meitheal-timezone"))).not.toBe("UTC")
    })
  }

  test("custom field changes stop after a failed read and retain the draft", async ({ page }) => {
    await openSettings(page, "#workflow-settings")
    let reads = 0
    let writes = 0
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "GET") reads += 1
      if (route.request().method() === "PUT") writes += 1
      await route.fulfill({ status: 503, json: {} })
    })
    await page.locator("#add-custom-field").click()
    const field = page.getByRole("textbox", { name: "Field name" }).last()
    await field.fill("Local field")
    await page.locator(".custom-field-save").click()
    await expect(page.locator("#toast-container .toast.error")).toBeVisible()
    await expect(field).toHaveValue("Local field")
    expect(reads).toBe(1)
    expect(writes).toBe(0)
  })

  test("multi-key failure stops the save and identifies partial persistence", async ({ page }) => {
    const writes: string[] = []
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      const { key } = route.request().postDataJSON()
      writes.push(key)
      await route.fulfill({ status: writes.length === 2 ? 503 : 200, json: {} })
    })
    await openSettings(page, "#automation-ai-settings")
    await page.locator("#save-agent-protocols").click()
    await expect(page.locator("#toast-container .toast.error")).toContainText("Some changes were saved")
    await expect(page.locator("#save-agent-protocols")).toBeEnabled()
    await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
    expect(writes).toEqual(["agent-protocols-a2a-enabled", "agent-protocols-webmcp-enabled"])
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

  test("cancel retains focus and issues no destructive request", async ({ page }) => {
    let deletions = 0
    await page.route("**/api/settings?reset=all", async (route) => {
      deletions += 1
      await route.abort()
    })
    await openSettings(page, "#danger-zone-settings")
    const reset = page.locator("#reset-settings")
    await reset.click()
    const cancel = page.getByRole("alertdialog").getByRole("button", { name: "Cancel" })
    await expect(cancel).toBeFocused()
    await cancel.click()
    await expect(reset).toBeFocused()
    expect(deletions).toBe(0)
  })
})
