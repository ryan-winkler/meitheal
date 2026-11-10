import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run settings checks")
test.describe.configure({ mode: "serial" })
const headers = { "x-hass-is-admin": "true", "x-hass-user-id": "local-protocol-tests" }

for (const protocol of ["a2a", "mcp"]) {
  test(`${protocol} setting persists and gates its endpoint`, async ({ request }) => {
    const key = `agent-protocols-${protocol}-enabled`
    const route = protocol === "a2a" ? "/api/a2a/agent-card" : "/.well-known/mcp.json"
    try {
      const saved = await request.put("/api/settings", { headers, data: { key, value: false } })
      expect(saved.ok()).toBe(true)
      expect((await request.get(route)).status()).toBe(404)
      expect(await (await request.get(`/api/settings?key=${key}`, { headers })).json()).toMatchObject({ value: false })
    } finally {
      expect((await request.put("/api/settings", { headers, data: { key, value: true } })).ok()).toBe(true)
    }
    expect((await request.get(route)).status()).toBe(200)
  })
}
