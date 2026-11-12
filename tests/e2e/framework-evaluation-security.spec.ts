import { expect, test, type APIRequestContext } from "@playwright/test"
import { deferred } from "./_helpers"

test.use({ serviceWorkers: "block" })

test.skip(!process.env.E2E_BASE_URL, "Requires a disposable App server")

async function create(request: APIRequestContext) {
  const response = await request.post("/api/tasks", { data: { title: "Framework review fixture" } })
  expect(response.status()).toBe(201)
  return (await response.json()).id as string
}

test("API rejects unsupported formulas and HTML-shaped numeric bounds", async ({ request }) => {
  const config = { id: "rejected-formula", name: "Rejected formula", version: "1", source: "user", archetype: "formula", formula: "impact", badgeThresholds: [], fields: [{ key: "impact", label: "Impact", type: "number", min: 0, max: 10 }] }
  for (const data of [
    { ...config, formula: "impact ** 2" },
    { ...config, fields: [{ ...config.fields[0], min: '0" data-fixture="invalid-bound' }] },
  ]) {
    expect((await request.post("/api/frameworks", { data })).status()).toBe(400)
  }
  for (const fields of ["x", {}, null, [null]]) {
    expect((await request.post("/api/frameworks", { data: { ...config, fields } })).status()).toBe(400)
  }
  expect((await request.get("/api/frameworks/rejected-formula")).status()).toBe(404)
})

test("malformed Assist scores cannot replace estimates or introduce undeclared payload keys", async ({ page, request }) => {
  const id = await create(request)
  let suggestion: unknown = "unexpected string"
  await page.route("**/api/ha/assist", route => route.fulfill({ json: { speech: JSON.stringify({ scores: { rice: suggestion }, justification: "Fixture response" }) } }))
  try {
    await page.goto(`/tickets/${id}`)
    await expect(page.getByLabel("Scoring framework", { exact: true })).toBeEnabled()
    await page.getByLabel("Scoring framework", { exact: true }).selectOption("rice")
    for (const [name, value] of Object.entries({ Reach: "10", Impact: "2", Confidence: "80", Effort: "0.5" })) await page.getByRole("spinbutton", { name, exact: true }).fill(value)
    for (const [value, expected] of [
      ["unexpected string", "Assist returned no usable estimates"],
      [[99], "Assist returned no usable estimates"],
      [{ reach: { nested: true }, unexpected: 99, impact: 4 }, "Fixture response"],
      [{ reach: "not a number", confidence: 101, effort: 0 }, "Assist returned no usable estimates"],
    ] as const) {
      suggestion = value
      await page.locator("#se-ask-ai").click()
      await expect(page.locator("#se-status")).toContainText(expected)
      await expect(page.getByRole("spinbutton", { name: "Reach", exact: true })).toHaveValue("10")
    }
    await expect(page.getByRole("spinbutton", { name: "Impact", exact: true })).toHaveValue("4")
    await page.getByRole("button", { name: "Save score", exact: true }).click()
    await expect(page.locator("#se-status")).toHaveText("Evaluation saved.")
    const stored = JSON.parse((await (await request.get(`/api/tasks/${id}`)).json()).framework_payload).rice
    expect(stored).toMatchObject({ reach: 10, impact: 4, confidence: 80, effort: 0.5 })
    expect(stored).not.toHaveProperty("0")
    expect(stored).not.toHaveProperty("unexpected")
  } finally { expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204) }
})

test("switching tickets during Assist resets the reused action and ignores the aborted reply", async ({ page, request }) => {
  const first = await create(request)
  const second = await create(request)
  const started = deferred<void>()
  const release = deferred<void>()
  let calls = 0
  await page.route("**/api/ha/assist", async route => {
    const attempt = ++calls
    if (attempt === 1) { started.resolve(); await release.promise }
    await route.fulfill({ json: { speech: JSON.stringify({ scores: { rice: { impact: attempt } }, justification: `Fixture ticket ${attempt}` }) } }).catch(() => {})
  })
  try {
    await page.goto(`/tickets/${first}`)
    await expect(page.getByLabel("Scoring framework", { exact: true })).toBeEnabled()
    await page.locator("#se-ask-ai").click()
    await started.promise
    await expect(page.locator("#se-ask-ai")).toBeDisabled()
    await page.evaluate(id => window.openTaskDetail?.(id), second)
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/tickets/${second}`)
    await expect(page.getByLabel("Scoring framework", { exact: true })).toBeEnabled()
    await expect(page.locator("#se-ask-ai")).toBeEnabled()
    release.resolve()
    await page.locator("#se-ask-ai").click()
    await expect(page.locator("#se-status")).toHaveText("Fixture ticket 2")
  } finally {
    release.resolve()
    for (const id of [first, second]) expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204)
  }
})
