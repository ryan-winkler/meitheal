import { expect, test, type Locator, type Response } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable App server")
test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

function isCatalog(response: Response) {
  return new URL(response.url()).pathname === "/api/plugins" && response.request().method() === "GET"
}

function getContrast(text: Locator) {
  return text.evaluate(element => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const paint = canvas.getContext("2d")!
    const layers = []
    for (let layer: Element | null = element; layer; layer = layer.parentElement) {
      layers.unshift(getComputedStyle(layer).backgroundColor)
    }
    for (const color of ["white", ...layers]) {
      paint.fillStyle = color
      paint.fillRect(0, 0, 1, 1)
    }
    const background = paint.getImageData(0, 0, 1, 1).data
    paint.fillStyle = getComputedStyle(element).color
    paint.fillRect(0, 0, 1, 1)
    const foreground = paint.getImageData(0, 0, 1, 1).data
    const luminance = (pixel: Uint8ClampedArray) => [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
      const channel = pixel[index] / 255
      return sum + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    }, 0)
    const values = [luminance(background), luminance(foreground)]
    return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05)
  })
}

test("disabled connectors are opt-in and their security disclosures retain keyboard focus on refresh", async ({ page }) => {
  const catalog = page.waitForResponse(isCatalog)
  await page.goto("/settings#plugins-settings")
  expect((await catalog).ok()).toBe(true)
  const panel = page.getByRole("region", { name: "Plugin Health", exact: true })
  await expect(page.locator("#plugins-settings")).not.toContainText(/Elephant|Goldfish|\bEGM\b/i)
  const showDisabled = panel.getByRole("checkbox", { name: "Show disabled plugins", exact: true })
  const rows = panel.locator("[data-plugin-health-id]")
  await expect(panel.getByText("No plugins are enabled.", { exact: true })).toBeVisible()
  await expect(showDisabled).not.toBeChecked()
  await expect(rows).toHaveCount(0)

  await showDisabled.press("Space")
  await expect(showDisabled).toBeChecked()
  await expect(showDisabled).toBeFocused()
  const gitea = rows.filter({ hasText: "Gitea Issues" })
  await expect(rows.filter({ hasText: "GitHub Issues" })).toBeVisible()
  await expect(gitea.getByText("Disabled", { exact: true })).toHaveCount(1)
  await expect(gitea).not.toContainText(/Compliant|Elephant|Goldfish|EGM/)
  const securityChecks = gitea.locator("details")
  const disclosure = securityChecks.locator("summary")
  await expect(disclosure).toContainText("Security checks")
  await expect(securityChecks).not.toHaveAttribute("open", "")

  await disclosure.press("Enter")
  await expect(securityChecks).toHaveAttribute("open", "")
  await expect(disclosure).toBeFocused()
  await expect(disclosure).toHaveCSS("outline-style", "solid")
  await expect(disclosure.locator("svg")).toHaveCSS("transition-property", "none")
  await expect(gitea.getByText(/SHA-256/)).toBeVisible()
  await expect(gitea.locator('[data-check-status="warn"]').filter({ hasText: "server URL" })).toBeVisible()

  // Keep the summary focused while the catalog refreshes, as it would on a quiet update.
  await disclosure.evaluate(node => { node.dataset.testBeforeRefresh = "true" })
  const refreshed = page.waitForResponse(isCatalog)
  await page.locator("#plugins-refresh-btn").evaluate(button => (button as HTMLButtonElement).click())
  expect((await refreshed).ok()).toBe(true)
  await expect(disclosure).not.toHaveAttribute("data-test-before-refresh", "true")
  await expect(securityChecks).toHaveAttribute("open", "")
  await expect(disclosure).toBeFocused()
  await disclosure.press("Space")
  await expect(securityChecks).not.toHaveAttribute("open", "")
  await showDisabled.press("Space")
  await expect(rows).toHaveCount(0)
})

test("a failed catalog read leaves an actionable status and Refresh can recover", async ({ page }) => {
  await page.route("**/api/plugins", route => route.fulfill({ status: 503, json: { detail: "Plugin catalog temporarily unavailable." } }), { times: 1 })
  await page.goto("/settings#plugins-settings")
  const panel = page.getByRole("region", { name: "Plugin Health", exact: true })
  await expect(panel.getByRole("status")).toHaveText("Plugin catalog temporarily unavailable.")
  const showDisabled = panel.getByRole("checkbox", { name: "Show disabled plugins", exact: true })
  await expect(showDisabled).toBeDisabled()

  await page.locator("#plugins-refresh-btn").click()
  await expect(panel.getByRole("status")).toHaveText("No plugins are enabled.")
  await expect(showDisabled).toBeEnabled()
})

for (const [theme, width] of [["velvet", 320], ["catppuccin-latte", 1440]] as const) {
  test(`Plugin Health status remains readable in ${theme} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.addInitScript(mode => localStorage.setItem("meitheal-theme", mode), theme)
    await page.goto("/settings#plugins-settings")
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    const panel = page.getByRole("region", { name: "Plugin Health", exact: true })
    await panel.getByRole("checkbox", { name: "Show disabled plugins", exact: true }).check()
    const github = panel.locator("[data-plugin-health-id]").filter({ hasText: "GitHub Issues" })
    const disclosure = github.locator("summary")
    await disclosure.press("Enter")
    await expect(github.locator("details")).toHaveAttribute("open", "")
    const outcome = disclosure.getByText(/\d+ of \d+ passed/)
    await expect(outcome).toBeVisible()

    const overflow = await panel.evaluate(element => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    expect((await disclosure.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    expect(await getContrast(outcome)).toBeGreaterThanOrEqual(4.5)
    expect(await getContrast(github.getByText("Disabled", { exact: true }))).toBeGreaterThanOrEqual(4.5)
    expect(await getContrast(github.locator('[data-check-status="pass"] svg').first())).toBeGreaterThanOrEqual(3)
  })
}
