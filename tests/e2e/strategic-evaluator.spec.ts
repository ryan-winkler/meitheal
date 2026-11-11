import { expect, test } from "@playwright/test"
import { evaluateFrameworkFormula, isFrameworkFormulaSupported } from "@meitheal/domain-strategy"
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
  expect(evaluateFrameworkFormula("impact + verified", { impact: 2, verified: true })).toBe(3)
  expect(evaluateFrameworkFormula("impact + verified", { impact: 2, verified: false })).toBe(2)
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
      fields: [{ key: "impact", label: "Custom impact", type: "number", min: '0" data-fixture-min="unexpected', max: '10" data-fixture-max="unexpected' }],
    }
    const framework = await request.post("/api/frameworks", { headers: { origin }, data: config })
    expect(framework.status(), await framework.text()).toBe(400)
    const invalidFormula = { ...config, id: "legacy-formula-type", formula: { expression: "impact" },
      fields: [{ key: "impact", label: "Custom impact", type: "number", min: 0 }] }
    const invalidOptions = { ...config, id: "legacy-options", formula: "impact",
      fields: [{ key: "impact", label: "Custom impact", type: "number", min: 0, options: "legacy" }] }
    // Simulate legacy stored records; new writes reject these configurations.
    await page.route("**/api/frameworks", route => route.fulfill({ json: { data: [config, invalidFormula, invalidOptions] } }))
    const created = await request.post("/api/tasks", { headers: { origin }, data: {
      title: "Unsupported scoring formula", framework_payload: JSON.stringify({ [config.id]: { impact: 2 } }),
    } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      await page.goto(`/tickets/${id}`)
      const input = page.getByRole("spinbutton", { name: "Custom impact", exact: true })
      await expect(input).toHaveValue("2")
      await expect(input).not.toHaveAttribute("min")
      await expect(input).not.toHaveAttribute("max")
      await expect(input).not.toHaveAttribute("data-fixture-min")
      await expect(input).not.toHaveAttribute("data-fixture-max")
      await input.focus()
      await input.fill("3")
      await expect(page.locator("#se-live-result")).toContainText("unsupported scoring settings")
      await page.getByRole("button", { name: "Save score", exact: true }).click()
      await expect(page.locator("#se-status")).toContainText("correct its formula, bounds, or options")
      const stored = await (await request.get(`/api/tasks/${id}`)).json()
      expect(JSON.parse(stored.framework_payload)[config.id]).toEqual({ impact: 2 })
      for (const legacy of [invalidFormula, invalidOptions]) {
        await page.getByLabel("Scoring framework", { exact: true }).selectOption(legacy.id)
        await expect(input).toBeVisible()
        await expect(page.locator("#se-live-result")).toContainText("unsupported scoring settings")
      }
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

  test("saving merges an unrelated evaluation and retains inactive drafts, then refuses a competing same-framework save", async ({ page, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const rice = { reach: 10, impact: 2, confidence: 80, effort: 2 }
    const created = await request.post("/api/tasks", { headers: { origin }, data: {
      title: "Scoring merge fixture", framework_payload: JSON.stringify({ rice }),
    } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    const path = `/api/tasks/${id}`
    const read = async () => (await request.get(path)).json()
    const write = async (payload: unknown) => {
      expect((await request.patch(path, { headers: { origin }, data: { framework_payload: JSON.stringify(payload) } })).ok()).toBe(true)
    }
    const writes: unknown[] = []
    await page.route(`**${path}`, async route => {
      if (route.request().method() === "PUT") writes.push(route.request().postDataJSON().updated_at)
      await route.continue()
    })
    try {
      await page.goto(`/tickets/${id}`)
      const chooser = page.getByLabel("Scoring framework", { exact: true })
      await expect(chooser).toBeEnabled()
      // The fallback can bind before Astro delivers the first page-load event.
      expect(await page.evaluate(() => {
        const attach = window.attachStrategicLens
        document.dispatchEvent(new Event("astro:page-load"))
        return attach === window.attachStrategicLens
      })).toBe(true)
      await chooser.selectOption("ice")
      const ease = page.getByRole("spinbutton", { name: "Ease", exact: true })
      await ease.fill("9")
      await chooser.selectOption("rice")
      const effort = page.getByRole("spinbutton", { name: "Effort", exact: true })
      await effort.fill("4")

      const heart = { note: "Unrelated evaluation" }
      await write({ rice: { effort: 2, confidence: 80, impact: 2, reach: 10 }, heart })
      const latestVersion = (await read()).task_version
      const save = page.getByRole("button", { name: "Save score", exact: true })
      await save.click()
      await expect(page.locator("#se-status")).toHaveText("Evaluation saved.")
      expect(writes).toEqual([latestVersion])
      const saved = JSON.parse((await read()).framework_payload)
      expect(saved).toMatchObject({ rice: { effort: 4 }, heart })
      expect(saved).not.toHaveProperty("ice")
      await chooser.selectOption("ice")
      await expect(ease).toHaveValue("9")
      await chooser.selectOption("rice")

      const concurrent = { ...saved, rice: { ...saved.rice, effort: 7 } }
      await write(concurrent)
      await effort.fill("5")
      await save.click()
      await expect(page.locator("#se-status")).toContainText("saved evaluation changed")
      await expect(effort).toHaveValue("5")
      expect(writes).toEqual([latestVersion])
      expect(JSON.parse((await read()).framework_payload)).toEqual(concurrent)
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
        await route.fulfill({ json: { speech: JSON.stringify({ scores: { rice: { impact: 3, effort: 8, confidence: 33 } }, justification: "Partial suggestion" }) } })
      })
      // A late call with an ended modal session must leave this active ticket intact.
      await page.evaluate(async () => {
        const lifetime = new AbortController()
        lifetime.abort()
        await window.attachStrategicLens?.("stale-ticket", "task", "{}", {}, { signal: lifetime.signal, save: async () => false })
      })
      await expect(chooser).toBeEnabled()
      await expect(page.getByRole("spinbutton", { name: "Reach", exact: true })).toHaveValue("10")
      await assist.click()
      await started.promise
      const effort = page.getByRole("spinbutton", { name: "Effort", exact: true })
      const confidence = page.getByRole("spinbutton", { name: "Confidence", exact: true })
      await confidence.fill("85")
      await confidence.fill("80")
      await effort.fill("4")
      release.resolve()
      await expect(page.locator("#se-status")).toHaveText("Partial suggestion")
      await expect(page.getByRole("spinbutton", { name: "Impact", exact: true })).toHaveValue("3")
      await expect(page.getByRole("spinbutton", { name: "Reach", exact: true })).toHaveValue("10")
      await expect(effort).toHaveValue("4")
      await expect(confidence).toHaveValue("80")
      await expect(effort).toBeFocused()
      started = deferred<void>()
      release = deferred<void>()
      await assist.click()
      await started.promise
      await effort.fill("5")
      await chooser.selectOption("ice")
      await page.getByRole("spinbutton", { name: "Ease", exact: true }).fill("9")
      release.resolve()
      await expect(page.locator("#se-status")).toHaveText("Partial suggestion")
      await expect(chooser).toHaveValue("ice")
      await expect(page.getByRole("spinbutton", { name: "Ease", exact: true })).toHaveValue("9")
      await chooser.selectOption("rice")
      await expect(page.getByRole("spinbutton", { name: "Impact", exact: true })).toHaveValue("3")
      await expect(effort).toHaveValue("5")

      started = deferred<void>()
      release = deferred<void>()
      await assist.click()
      await started.promise
      await page.getByRole("button", { name: "Save score", exact: true }).click()
      await expect(page.locator("#se-status")).toHaveText("Evaluation saved.")
      release.resolve()
      await expect(assist).toBeEnabled()
      await expect(effort).toHaveValue("5")
      const saved = await (await request.get(`/api/tasks/${id}`)).json()
      expect(JSON.parse(saved.framework_payload).rice.effort).toBe(5)
    } finally { await request.delete(`/api/tasks/${id}`, { headers: { origin }, data: {} }) }
  })
})
