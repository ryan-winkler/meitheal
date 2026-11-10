import { expect, test } from "@playwright/test"
import { POST } from "../../apps/web/src/pages/api/import/settings"

test("rejects unknown rule task types before importing settings or replacing rules", async () => {
  const request = new Request("http://localhost/api/import/settings", {
    method: "POST",
    body: JSON.stringify({
      _version: 2,
      settings: { theme: "light" },
      rules: [{ name: "Fixture rule", taskTypes: ["unknown"] }],
    }),
  })

  const response = await POST({ request, locals: { hassIsAdmin: true } } as Parameters<typeof POST>[0])

  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: "Invalid task types in imported rules" })
})
