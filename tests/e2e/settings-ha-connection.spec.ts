import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Route } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

test("standalone status describes the live probe and keeps credential configuration", async ({ page, request }) => {
  const response = await request.get("/api/ha/connection")
  expect(response.ok()).toBe(true)
  expect(response.headers()["cache-control"]).toBe("no-store")
  expect(await response.json()).toEqual({
    connected: false,
    mode: "standalone",
    message: "No Supervisor connection in standalone mode",
  })

  await page.goto("/settings#integration-ha")
  const card = page.locator("#integration-ha")
  await expect(card.getByRole("status")).toContainText("Running standalone")
  await expect(card.getByRole("status")).toContainText("no Supervisor connection")
  await expect(card.locator("#ha-info-panel")).toBeHidden()
  await card.locator("#ha-advanced-section > summary").click()
  await card.getByLabel("HA URL", { exact: true }).fill("http://ha-fixture.invalid:8123")
  await card.getByLabel("Long-Lived Access Token", { exact: true }).fill("synthetic-settings-credential")
  await card.getByRole("button", { name: /Save/ }).click()
  await expect(page.locator("#toast-container .toast.success")).toBeVisible()

  const url = await request.get("/api/settings?key=ha_url")
  expect((await url.json()).value).toBe("http://ha-fixture.invalid:8123")
  const token = await request.get("/api/settings?key=ha_token")
  expect(await token.json()).toMatchObject({ configured: true, value: "••••••••" })
  await expect(card.getByRole("status")).toContainText("Running standalone")
})

for (const theme of ["light", "dark"]) {
  test(`Home Assistant status remains truthful and retryable in ${theme} theme`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 })
    await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)
    const connected = {
      connected: true,
      mode: "ha-addon",
      version: "2026.11.1",
      location_name: "<img src=x onerror=alert(1)>",
      time_zone: "Europe/Dublin",
    }
    const heldResponse = deferred<void>()
    const respondConnected = (route: Route) => route.fulfill({ json: connected })
    let respond = respondConnected
    let requests = 0
    await page.route("**/api/ha/connection", route => {
      requests += 1
      return respond(route)
    })

    await page.goto("/settings#integration-ha")
    const card = page.locator("#integration-ha")
    const status = card.getByRole("status")
    const retry = card.getByRole("button", { name: "Test Connection" })
    const info = card.locator("#ha-info-panel")
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    await expect(status).toContainText("Home Assistant connected")
    await expect(info.getByText(connected.location_name, { exact: true })).toBeVisible()
    await expect(info.locator("img")).toHaveCount(0)
    // The existing Grocy and Node-RED probes also read the live connection on entry.
    await expect.poll(() => requests).toBe(3)
    const initialRequests = requests
    respond = async route => {
      await heldResponse.promise
      return route.fulfill({ status: 503, json: { message: "Temporarily unavailable" } })
    }

    await retry.press("Enter")
    try {
      await expect(status).toContainText("Checking Home Assistant")
      await expect(retry).toHaveAttribute("aria-busy", "true")
      await expect(retry).toBeFocused()
      await expect(info).toBeHidden()
      await expect.poll(() => requests).toBe(initialRequests + 1)
      await retry.dispatchEvent("click")
      expect(requests).toBe(initialRequests + 1)
    } finally {
      heldResponse.resolve()
    }

    await expect(status).toContainText("Could not check Home Assistant")
    await expect(retry).toBeEnabled()
    await expect(retry).toBeFocused()
    respond = route => route.fulfill({ json: { connected: false, mode: "ha-addon", message: "INVALID_AUTH" } })
    await retry.press("Enter")
    await expect(status).toContainText("Home Assistant access denied")
    await expect(status).toContainText("Core API access")
    const a11y = await new AxeBuilder({ page }).include("#integration-ha").withRules(["color-contrast", "nested-interactive"]).analyze()
    expect(a11y.violations).toEqual([])
    respond = route => route.fulfill({ json: { connected: false, mode: "ha-addon", message: "CANNOT_CONNECT" } })
    await retry.press("Enter")
    await expect(status).toContainText("Home Assistant disconnected")
    await expect(status).toContainText("App logs")
    respond = respondConnected
    await retry.press("Enter")
    await expect(status).toContainText("Home Assistant connected")
    await expect(info.getByText("2026.11.1")).toBeVisible()
    expect(requests).toBe(initialRequests + 4)
  })
}

test("the Home Assistant status has Gaeilge copy", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
  await page.goto("/settings#integration-ha")
  await expect(page.locator("#ha-connection-status")).toContainText("Ag rith go neamhspleách")
  await expect(page.locator("#ha-connection-badge")).toHaveText("Neamhspleách")
})
