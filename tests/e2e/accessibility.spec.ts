import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

for (const theme of ["light", "dark"]) {
  test(`dashboard accessibility in ${theme} theme`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.addInitScript((value) => localStorage.setItem("meitheal-theme", value), theme)
    await page.goto("/")
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    await expect(page.getByRole("link", { name: "Meitheal Home", exact: true })).toBeVisible()

    await page.locator(".main-content").evaluate(async (content) => {
      await document.fonts.ready
      await Promise.allSettled(content.getAnimations().map((animation) => animation.finished))
    })
    const { violations } = await new AxeBuilder({ page }).analyze()
    expect(violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }))).toEqual([])
  })

  test(`completed dashboard cards remain readable in ${theme} theme`, async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = { origin: new URL(baseURL!).origin }
    const created = await request.post("/api/tasks", {
      headers, data: { title: "Checked the air filter", status: "complete" },
    })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)
      await page.goto("/")
      const card = page.locator(`.bento-card[data-id="${id}"]`)
      await expect(card).toContainText("Checked the air filter")
      await card.evaluate(() => document.fonts.ready.then(() => undefined))
      const results = await new AxeBuilder({ page }).include(`.bento-card[data-id="${id}"]`)
        .withRules(["color-contrast"]).analyze()
      expect(results.violations).toEqual([])
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })
}

test("dashboard section links and ownership filter use native navigation semantics", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/")

  const quickLinks = page.locator("#dashboard-bar-tabs a:visible")
  await expect(quickLinks.nth(1)).toBeVisible()
  await quickLinks.first().focus()
  await page.keyboard.press("Tab")
  await expect(quickLinks.nth(1)).toBeFocused()
  await expect(page.getByRole("combobox", { name: "Filter open work by assignee" })).toBeVisible()

  const results = await new AxeBuilder({ page })
    .include("#dashboard-bar")
    .include("#my-open-tasks-card")
    .withRules(["aria-allowed-attr", "select-name"])
    .analyze()
  expect(results.violations).toEqual([])
})

test("Settings navigation and fields have valid semantics at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/settings#workflow-settings")

  await expect(page.locator("#settings-directory")).toBeHidden()
  await page.getByRole("button", { name: "Sections", exact: true }).click()
  const workflow = page.locator('[data-settings-nav="workflow-settings"]')
  await expect(workflow).toBeVisible()
  await expect(workflow).toHaveAttribute("aria-current", "location")
  await expect(page.getByRole("checkbox", { name: "Show Dashboard in sidebar" })).toBeVisible()
  await expect(page.getByRole("combobox", { name: "Sprint field type" })).toBeVisible()

  const results = await new AxeBuilder({ page })
    .include("#settings-shell")
    .withRules(["aria-allowed-attr", "aria-required-children", "aria-hidden-focus", "label", "select-name"])
    .analyze()
  expect(results.violations).toEqual([])
})

test("integration cards hide collapsed controls from focus and use native button activation", async ({ page }) => {
  await page.goto("/settings#integrations-settings")

  const card = page.locator("#integration-webhooks")
  const toggle = card.locator('[aria-controls="integration-webhooks-body"]')
  const endpoint = card.locator("#webhook-endpoint")
  const help = card.locator('[data-explainer="webhooks"]')
  const dialog = page.locator("#integration-explainer-dialog")

  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(card.locator("#integration-webhooks-body")).toHaveAttribute("inert", "")
  await toggle.focus()
  await endpoint.evaluate((element) => element.focus())
  await expect(toggle).toBeFocused()

  await toggle.press("Enter")
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await endpoint.focus()
  await expect(endpoint).toBeFocused()

  await toggle.press("Space")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(toggle).toBeFocused()

  await help.press("Enter")
  await expect(dialog).toBeVisible()
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(help).toBeFocused()
})

test("configured integrations open with the disclosure state and controls in sync", async ({ page }) => {
  await page.route("**/api/settings", async (route) => {
    await route.fulfill({ json: { webhook_endpoint: "https://example.invalid/webhook" } })
  })
  await page.goto("/settings#integrations-settings")

  const toggle = page.locator('[aria-controls="integration-webhooks-body"]')
  const endpoint = page.getByRole("textbox", { name: "Endpoint URL", exact: true })
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(endpoint).toHaveValue("https://example.invalid/webhook")
  await endpoint.focus()
  await expect(endpoint).toBeFocused()
})
