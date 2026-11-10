import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL for disposable local API/browser acceptance")

test("Today quick capture honors the persisted NLP flag in its submitted task", async ({ page, request }) => {
  const headers = { "x-hass-is-admin": "true", "x-hass-user-id": "nlp-local-test" }
  const original = await (await request.get("/api/settings?key=feature_nlp_parser", { headers })).json()
  try {
    for (const enabled of [false, true]) {
      expect((await request.put("/api/settings", { headers, data: { key: "feature_nlp_parser", value: enabled } })).ok()).toBe(true)
      await page.goto("/today")
      await expect(page.locator("#quick-add-input")).toBeVisible()
      await expect.poll(() => page.evaluate(() => window.__featureFlags?.nlp_parser)).toBe(enabled)
      await page.route("**/api/tasks", async route => {
        if (route.request().method() === "POST") await route.fulfill({ status: 201, json: { id: "nlp-payload-fixture" } })
        else await route.continue()
      })
      await page.locator("#quick-add-input").fill("Capture fixture tomorrow p1 #household @ryan")
      const submitted = page.waitForRequest(req => req.method() === "POST" && new URL(req.url()).pathname === "/api/tasks")
      await page.locator("#quick-add-form button[type=submit]").click()
      const payload = (await submitted).postDataJSON()
      if (enabled) {
        expect(payload).toMatchObject({ title: "Capture fixture", priority: 1, labels: '["household"]', assigned_to: "ryan" })
      } else {
        expect(payload.title).toBe("Capture fixture tomorrow p1 #household @ryan")
        expect(payload).not.toHaveProperty("priority")
        expect(payload).not.toHaveProperty("labels")
        expect(payload).not.toHaveProperty("assigned_to")
      }
      await page.unroute("**/api/tasks")
    }
  } finally {
    await request.put("/api/settings", { headers, data: { key: "feature_nlp_parser", value: original.value ?? true } })
  }
})
