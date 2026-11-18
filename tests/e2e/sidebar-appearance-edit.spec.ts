import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

const configuredOrigin = process.env.E2E_BASE_URL ? new URL(process.env.E2E_BASE_URL) : null
const localFixture = configuredOrigin && ["127.0.0.1", "localhost", "[::1]"].includes(configuredOrigin.hostname)
test.skip(shouldSkipBrowserSpecs() || !localFixture, "Requires a disposable loopback Meitheal server")
test.use({
  serviceWorkers: "block", trace: "retain-on-failure",
  ...(localFixture ? { extraHTTPHeaders: { origin: configuredOrigin.origin } } : {}),
})

for (const change of ["navbar", "font"] as const) {
  test(`a second-tab ${change} preference preserves the focused Area draft without saving`, async ({ page, context, request }) => {
    await page.setViewportSize({ width: 2200, height: 1000 })
    await page.addInitScript(() => {
      localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "sidebar", sidebar: "hover" }))
    })
    const name = `Appearance draft ${crypto.randomUUID().slice(0, 8)}`
    const created = await request.post("/api/areas", { data: { name } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    let peer
    try {
      await page.goto("/today")
      peer = await context.newPage()
      await peer.goto("/today")
      await page.bringToFront()
      await page.locator('#sidebar a[data-page="boards"]').focus()
      await expect(page.locator("body")).not.toHaveClass(/sidebar-collapsed/)
      const boards = page.locator("[data-sidebar-boards-toggle]")
      if (await boards.getAttribute("aria-expanded") !== "true") await boards.click()
      const areas = page.locator("#sidebar-areas-group")
      if (!(await areas.evaluate(element => (element as HTMLDetailsElement).open))) await areas.locator(":scope > summary").click()
      const trigger = page.locator(`[data-area-menu="${id}"]`)
      await trigger.focus()
      await trigger.press("Enter")
      await page.locator("body > #area-menu-dropdown").getByRole("button", { name: "Rename", exact: true }).press("Enter")
      const input = page.locator(`[data-area-group="${id}"] .stree__inline-input`)
      await input.fill(name + " must not save")
      const retained = await input.elementHandle()
      expect(retained).not.toBeNull()
      const writes: string[] = []
      page.on("request", request => {
        if (["POST", "PUT"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/areas")) writes.push(request.method())
      })
      // A genuine storage event from another same-origin tab, while this editor owns focus.
      await peer.evaluate(change => {
        localStorage.setItem("meitheal-appearance", JSON.stringify({
          navigation: change === "navbar" ? "navbar" : "sidebar",
          sidebar: "hover", font: change === "font" ? "serif" : "sans",
        }))
      }, change)
      await expect(page.locator("html")).toHaveAttribute(change === "navbar" ? "data-appearance-navigation" : "data-appearance-font", change === "navbar" ? "navbar" : "serif")
      await page.waitForTimeout(250)
      expect(await retained!.evaluate(element => element.isConnected)).toBe(true)
      await expect(input).toBeVisible()
      await expect(input).toBeFocused()
      expect(writes).toEqual([])
      expect((await (await request.get(`/api/areas/${id}`)).json()).name).toBe(name)
      await input.press("Escape")
      await expect(input).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.waitForTimeout(250)
      expect(writes).toEqual([])
      expect((await (await request.get(`/api/areas/${id}`)).json()).name).toBe(name)
    } finally {
      await peer?.close()
      expect((await request.delete(`/api/areas/${id}`, { data: {} })).status()).toBe(200)
    }
  })
}
