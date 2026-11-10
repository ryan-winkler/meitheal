import { expect, test } from "@playwright/test"
import { evaluateFrameworkFormula, isFrameworkFormulaSupported } from "../../apps/web/src/lib/framework-score"
import { deferred } from "./_helpers"

test("formula syntax errors are distinct from invalid estimates without changing arithmetic", () => {
  const fields = ["impact", "effort"]
  for (const formula of ["impact ** 2", "Math.max(impact, effort)", "impact ^ 2", "impact +", "unknown / effort", ""]) {
    expect(isFrameworkFormulaSupported(formula, fields), formula).toBe(false)
  }
  for (const formula of ["impact / effort", "impact / (effort - 1)", "-impact + .5 * (effort + 2)"]) {
    expect(isFrameworkFormulaSupported(formula, fields), formula).toBe(true)
  }
  expect(evaluateFrameworkFormula("-impact + .5 * (effort + 2)", { impact: 2, effort: 3 })).toBe(1)
  expect(evaluateFrameworkFormula("impact / effort", { impact: 2, effort: 0 })).toBeNull()
  expect(evaluateFrameworkFormula("impact / effort", { impact: 2, effort: "" })).toBeNull()
})

test.describe("Ticket scoring review regressions", () => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  test.use({ serviceWorkers: "block" })
  test.setTimeout(60_000)

  test("unsupported saved formulas show a formula error and untrusted bounds cannot create attributes", async ({ page, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const config = {
      id: "unsupported-score-test", name: "Unsupported score test", version: "1.0.0", archetype: "formula", source: "user",
      formula: "impact ** 2", badgeThresholds: [],
      fields: [{ key: "impact", label: "Custom impact", type: "number", min: '0" onfocus="window.scoringInjected=true', max: '10" oninput="window.scoringInjected=true' }],
    }
    const framework = await request.post("/api/frameworks", { headers: { origin }, data: config })
    expect(framework.status(), await framework.text()).toBe(400)
    // Simulate a legacy stored record; new writes reject this configuration.
    await page.route("**/api/frameworks", route => route.fulfill({ json: { data: [config] } }))
    const created = await request.post("/api/tasks", { headers: { origin }, data: {
      title: "Unsupported scoring formula", framework_payload: JSON.stringify({ [config.id]: { impact: 2 } }),
    } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      await page.goto(`/tickets/${id}`)
      const input = page.getByRole("spinbutton", { name: "Custom impact", exact: true })
      await expect(input).toHaveValue("2")
      await expect(input).toHaveAttribute("min", config.fields[0].min)
      await expect(input).toHaveAttribute("max", config.fields[0].max)
      await expect(input).not.toHaveAttribute("onfocus")
      await expect(input).not.toHaveAttribute("oninput")
      await input.focus()
      await input.fill("3")
      await expect(page.locator("#se-live-result")).toContainText(/formula.*unsupported|unsupported.*formula/)
      await page.getByRole("button", { name: "Save score", exact: true }).click()
      await expect(page.locator("#se-status")).toContainText(/formula.*unsupported|unsupported.*formula/)
      expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).scoringInjected)).toBeUndefined()
      const stored = await (await request.get(`/api/tasks/${id}`)).json()
      expect(JSON.parse(stored.framework_payload)[config.id]).toEqual({ impact: 2 })
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers: { origin }, data: {} })
      await request.delete(`/api/frameworks/${config.id}`, { headers: { origin }, data: {} })
    }
  })

  test("legacy timestamp responses retain the normalized concurrency guard", async ({ page, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const created = await request.post("/api/tasks", { headers: { origin }, data: { title: "Legacy score concurrency" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    const path = `/api/tasks/${id}`
    try {
      await page.goto(`/tickets/${id}`)
      await expect(page.getByLabel("Scoring framework", { exact: true })).toBeEnabled()
      for (const [field, value] of Object.entries({ Reach: "10", Impact: "2", Confidence: "80", Effort: "0.5" })) {
        await page.getByRole("spinbutton", { name: field, exact: true }).fill(value)
      }
      let version: number | undefined
      let submittedVersion: unknown
      const concurrent = { heart: { note: "Concurrent evaluation" } }
      await page.route(`**${path}`, async route => {
        if (route.request().method() === "GET") {
          const response = await route.fetch()
          const task = await response.json()
          version = task.task_version
          const changed = await request.patch(path, { headers: { origin }, data: { framework_payload: JSON.stringify(concurrent) } })
          expect(changed.ok()).toBe(true)
          await route.fulfill({ response, json: { ...task, updated_at: "2024-01-02T03:04:05.000Z" } })
        } else {
          if (route.request().method() === "PUT") submittedVersion = route.request().postDataJSON().updated_at
          await route.continue()
        }
      })
      await page.getByRole("button", { name: "Save score", exact: true }).click()
      await expect(page.locator("#se-status")).toContainText("Your estimates are still here")
      expect(Number.isSafeInteger(version)).toBe(true)
      expect(submittedVersion).toBe(version)
      const stored = await (await request.get(path)).json()
      expect(JSON.parse(stored.framework_payload)).toEqual(concurrent)
      await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("0.5")
    } finally { await request.delete(path, { headers: { origin }, data: {} }) }
  })

  test("partial Assist suggestions preserve edits made before and during the request and across framework switches", async ({ page, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const created = await request.post("/api/tasks", { headers: { origin }, data: { title: "Partial Assist scoring" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      await page.goto(`/tickets/${id}`)
      const chooser = page.getByLabel("Scoring framework", { exact: true })
      await expect(chooser).toBeEnabled()
      for (const [field, value] of Object.entries({ Reach: "10", Impact: "2", Confidence: "80", Effort: "0.5" })) {
        await page.getByRole("spinbutton", { name: field, exact: true }).fill(value)
      }
      const assist = page.getByRole("button", { name: "Auto-score with Assist", exact: true })
      let started = deferred<void>()
      let release = deferred<void>()
      await page.route("**/api/ha/assist", async route => {
        started.resolve()
        await release.promise
        await route.fulfill({ json: { speech: JSON.stringify({ scores: { rice: { impact: 3 } }, justification: "Partial suggestion" }) } })
      })
      await assist.click()
      await started.promise
      await page.getByRole("spinbutton", { name: "Effort", exact: true }).fill("4")
      release.resolve()
      await expect(page.locator("#se-status")).toHaveText("Partial suggestion")
      await expect(page.getByRole("spinbutton", { name: "Impact", exact: true })).toHaveValue("3")
      await expect(page.getByRole("spinbutton", { name: "Reach", exact: true })).toHaveValue("10")
      await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("4")
      started = deferred<void>()
      release = deferred<void>()
      await assist.click()
      await started.promise
      await chooser.selectOption("ice")
      await page.getByRole("spinbutton", { name: "Ease", exact: true }).fill("9")
      release.resolve()
      await expect(page.locator("#se-status")).toHaveText("Partial suggestion")
      await expect(chooser).toHaveValue("ice")
      await expect(page.getByRole("spinbutton", { name: "Ease", exact: true })).toHaveValue("9")
      await chooser.selectOption("rice")
      await expect(page.getByRole("spinbutton", { name: "Impact", exact: true })).toHaveValue("3")
      await expect(page.getByRole("spinbutton", { name: "Effort", exact: true })).toHaveValue("4")
    } finally { await request.delete(`/api/tasks/${id}`, { headers: { origin }, data: {} }) }
  })
})
