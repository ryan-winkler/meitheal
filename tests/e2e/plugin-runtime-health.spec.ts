import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable App server")
test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

test("Plugin Health retains browser entry and initialization failures across a catalog refresh", async ({ page, request }) => {
  const fixtures = [
    { id: "entry-error-fixture", message: "Entry fixture failed", pluginJs: 'throw new Error("Entry fixture failed")' },
    { id: "init-error-fixture", message: "Initialization fixture failed", pluginJs: 'MeithealPlugin.onInit(async () => { throw new Error("Initialization fixture failed") })' },
  ] as const

  try {
    for (const { id, message, pluginJs } of fixtures) {
      const installed = await request.post("/api/plugins", { data: {
        action: "install_bundle",
        bundle: {
          manifest: {
            id,
            name: `${id} plugin`,
            version: "1.0.0",
            minMeithealVersion: "0.0.1",
            type: "extension",
            description: message,
            author: "Fixture",
            license: "AGPL-3.0-only",
            entry: "plugin.js",
            permissions: [],
            allowedHosts: [],
            dataSharing: { outbound: false, destinations: [], dataTypes: [], summary: "Local only." },
          },
          pluginJs,
        },
      } })
      expect(installed.status(), await installed.text()).toBe(201)
      const enabled = await request.patch(`/api/plugins/${id}`, { data: { enabled: true } })
      expect(enabled.status(), await enabled.text()).toBe(200)
    }

    await page.goto("/settings#plugins-settings")
    const assertFailure = async ({ id, message }: (typeof fixtures)[number]) => {
      const row = page.locator(`[data-plugin-health-id="${id}"]`)
      await expect(row.getByText("Runtime Error", { exact: true })).toBeVisible()
      await expect(row.getByText(`Error: ${message}`, { exact: true })).toBeVisible()
    }
    await assertFailure(fixtures[1])
    await assertFailure(fixtures[0])

    const catalog = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === "/api/plugins" && !url.searchParams.has("runtime") && response.request().method() === "GET"
    })
    await page.locator("#plugins-refresh-btn").click()
    expect((await catalog).ok()).toBe(true)
    for (const fixture of fixtures) await assertFailure(fixture)
  } finally {
    for (const { id } of fixtures) await request.delete(`/api/plugins/${id}`)
  }
})
