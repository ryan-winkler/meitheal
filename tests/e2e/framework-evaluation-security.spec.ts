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
    { ...config, fields: [{ ...config.fields[0], min: '0" autofocus onfocus="alert(1)' }] },
  ]) {
    expect((await request.post("/api/frameworks", { data })).status()).toBe(400)
  }
  for (const fields of ["x", {}, null, [null]]) {
    expect((await request.post("/api/frameworks", { data: { ...config, fields } })).status()).toBe(400)
  }
  expect((await request.get("/api/frameworks/rejected-formula")).status()).toBe(404)
})

test("legacy framework bounds cannot create attributes and unsupported formulas explain the failure", async ({ page, request }) => {
  const id = await create(request)
  const injected = '0" autofocus onfocus="window.frameworkInjected=true'
  await page.route("**/api/frameworks", route => route.fulfill({ json: { data: [{
    id: "legacy-unsafe", name: "Legacy framework", version: "1", archetype: "formula", formula: "impact ** 2",
    fields: [{ key: "impact", label: "Legacy impact", type: "number", min: injected, max: injected }],
  }] } }))
  try {
    await page.goto(`/tickets/${id}`)
    const chooser = page.getByLabel("Scoring framework", { exact: true })
    await expect(chooser).toBeEnabled()
    await expect(chooser.locator('option[value="legacy-unsafe"]')).toHaveCount(1)
    await chooser.selectOption("legacy-unsafe")
    const input = page.getByRole("spinbutton", { name: "Legacy impact" })
    await expect(input).toHaveAttribute("min", injected)
    await expect(input).not.toHaveAttribute("onfocus")
    await expect(input).not.toHaveAttribute("autofocus")
    await input.fill("2")
    await input.focus()
    expect(await page.evaluate(() => (window as unknown as { frameworkInjected?: boolean }).frameworkInjected)).toBeUndefined()
    await expect(page.locator("#se-live-result")).toContainText("framework formula is unsupported")
    await page.getByRole("button", { name: "Save score", exact: true }).click()
    await expect(page.locator("#se-status")).toContainText("Edit the framework formula")
  } finally { expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204) }
})

test("evaluation sends the normalized version and retains estimates after a conflict", async ({ page, request }) => {
  const id = await create(request)
  const task = await (await request.get(`/api/tasks/${id}`)).json()
  let guard: unknown
  await page.route(`**/api/tasks/${id}`, async route => {
    if (route.request().method() === "GET") {
      const response = await route.fetch()
      return route.fulfill({ response, json: { ...await response.json(), updated_at: new Date(task.updated_at).toISOString() } })
    }
    if (route.request().method() === "PUT") {
      guard = route.request().postDataJSON().updated_at
      return route.fulfill({ status: 409, json: { error: "Task version conflict" } })
    }
    return route.continue()
  })
  try {
    await page.goto(`/tickets/${id}`)
    await expect(page.getByLabel("Scoring framework", { exact: true })).toBeEnabled()
    await page.getByLabel("Scoring framework", { exact: true }).selectOption("rice")
    for (const [name, value] of Object.entries({ Reach: "10", Impact: "2", Confidence: "80", Effort: "0.5" })) {
      await page.getByRole("spinbutton", { name, exact: true }).fill(value)
    }
    await page.getByRole("button", { name: "Save score", exact: true }).click()
    await expect(page.locator("#se-status")).toContainText("Your estimates are still here")
    expect(guard).toBe(task.task_version)
    await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("0.5")
  } finally { expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204) }
})

test("partial Assist scores preserve estimates while another framework is selected", async ({ page, request }) => {
  const id = await create(request)
  const started = deferred<void>()
  const release = deferred<void>()
  await page.route("**/api/ha/assist", async route => {
    started.resolve()
    await release.promise
    return route.fulfill({ json: { speech: JSON.stringify({ scores: { rice: { impact: 4 } }, justification: "Fixture suggestion" }) } })
  })
  try {
    await page.goto(`/tickets/${id}`)
    const chooser = page.getByLabel("Scoring framework", { exact: true })
    await expect(chooser).toBeEnabled()
    await chooser.selectOption("rice")
    for (const [name, value] of Object.entries({ Reach: "10", Impact: "2", Confidence: "80", Effort: "0.5" })) await page.getByRole("spinbutton", { name, exact: true }).fill(value)
    await page.locator("#se-ask-ai").click()
    await started.promise
    await chooser.selectOption("ice")
    await page.getByRole("spinbutton", { name: "Ease", exact: true }).fill("9")
    release.resolve()
    await expect(page.locator("#se-status")).toHaveText("Fixture suggestion")
    await expect(chooser).toHaveValue("ice")
    await expect(page.getByRole("spinbutton", { name: "Ease", exact: true })).toHaveValue("9")
    await chooser.selectOption("rice")
    await expect(page.getByRole("spinbutton", { name: "Reach", exact: true })).toHaveValue("10")
    await expect(page.getByRole("spinbutton", { name: "Impact", exact: true })).toHaveValue("4")
    await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("0.5")
  } finally { release.resolve(); expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204) }
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
    for (const value of ["unexpected string", [99], { reach: { nested: true }, unexpected: 99, impact: 4 }]) {
      suggestion = value
      await page.locator("#se-ask-ai").click()
      await expect(page.locator("#se-status")).toHaveText("Fixture response")
      await expect(page.getByRole("spinbutton", { name: "Reach", exact: true })).toHaveValue("10")
    }
    await expect(page.getByRole("spinbutton", { name: "Impact", exact: true })).toHaveValue("4")
    await page.getByRole("button", { name: "Save score", exact: true }).click()
    await expect(page.locator("#se-status")).toHaveText("Evaluation saved.")
    const stored = JSON.parse((await (await request.get(`/api/tasks/${id}`)).json()).framework_payload).rice
    expect(stored.reach).toBe(10)
    expect(stored).not.toHaveProperty("0")
    expect(stored).not.toHaveProperty("unexpected")
  } finally { expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204) }
})
