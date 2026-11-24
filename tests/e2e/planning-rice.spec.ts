import { expect, test, type APIRequestContext } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { parseRiceInputs, readRiceAssessment, readRiceInputs, riceLensScore } from "../../apps/web/src/lib/rice-lens"
import { evaluateFrameworkFormula, evaluateFrameworkFormulaDecimal } from "@meitheal/domain-strategy"
import { taskDetailPath, ticketIdFromPath } from "../../apps/web/src/lib/task-page-url"

test("ticket paths preserve comment targets and scoring uses percent-normalized RICE", () => {
  expect(taskDetailPath("task one", 17)).toBe("/tickets/task%20one?comment=17")
  expect(ticketIdFromPath("/api/hassio_ingress/example/tickets/task%20one", "/api/hassio_ingress/example")).toBe("task one")
  expect(riceLensScore(readRiceInputs({ rice: { reach: 100, impact: 2, confidence: 80, effort: 4 } })!)).toBe(40)
  const values = { reach: 10, impact: 2, confidence: 80, effort: 0.5 }
  expect(riceLensScore(readRiceInputs({ rice: values })!)).toBe(32)
  expect(evaluateFrameworkFormulaDecimal("(reach * impact * (confidence / 100)) / effort", values)).toBe(32)
  expect(evaluateFrameworkFormula("(business_value + time_criticality + risk_reduction) / job_size", { business_value: 8, time_criticality: 4, risk_reduction: 3, job_size: 3 })).toBe(5)
  expect(evaluateFrameworkFormula("reach / effort", { reach: 10, effort: 0 })).toBeNull()
  expect(evaluateFrameworkFormula("globalThis.alert(1)", {})).toBeNull()
})

test("the shared lens validates decimal/zero inputs, rejects ambiguous types, and surfaces legacy fractions without mutating", () => {
  const legacy = { reach: "10", impact: 2, confidence: 50, effort: 2 }
  expect(riceLensScore(readRiceInputs(legacy)!)).toBe(5)
  expect(readRiceInputs({ reach: "0x10", impact: 2, confidence: true, effort: 1 })).toBeNull()
  expect(readRiceInputs({ ...legacy, rice: { ...legacy, reach: 0 } })).toEqual({ reach: 0, impact: 2, confidence: 50, effort: 2 })
  expect(riceLensScore(readRiceInputs({ ...legacy, rice: { ...legacy, reach: 0 } })!)).toBe(0)
  expect(riceLensScore(readRiceInputs({ ...legacy, reach: 0 })!)).toBe(0)
  expect(riceLensScore(readRiceInputs({ ...legacy, confidence: 0 })!)).toBe(0)
  expect(readRiceInputs({ ...legacy, effort: 0 })).toBeNull()
  expect(readRiceInputs({ ...legacy, confidence: "" })).toBeNull()
  expect(readRiceInputs({ ...legacy, confidence: false })).toBeNull()
  expect(readRiceInputs({ rice: { ...legacy, impact: true } })).toBeNull()
  expect(parseRiceInputs({ ...legacy, impact: true })).toBeNull()
  expect(parseRiceInputs({ ...legacy, impact: -1 })).toBeNull()

  const ambiguousPayload = { rice: { reach: 10, impact: 2, confidence: 0.8, effort: 2 } }
  expect(readRiceInputs(ambiguousPayload)).toBeNull()
  expect(readRiceAssessment(ambiguousPayload)).toEqual({
    status: "legacy_ambiguous",
    inputs: { reach: 10, impact: 2, confidence: 0.8, effort: 2 },
    legacyConfidence: 0.8,
    suggestedPercent: 80,
  })
  const disambiguatedPayload = { rice: { reach: 10, impact: 2, confidence: 0.8, confidence_unit: "percent", effort: 2 } }
  expect(readRiceAssessment(disambiguatedPayload).status).toBe("scored")
})

test.describe("Planning RICE editor", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  test.use({ serviceWorkers: "block" })

  async function create(request: APIRequestContext, headers: Record<string, string>, title: string, payload = {}, status = "pending") {
    const response = await request.post("/api/tasks", { headers, data: { title, status, framework_payload: JSON.stringify(payload) } })
    expect(response.status()).toBe(201)
    return (await response.json()).id as string
  }

  test("edits an existing percent or legacy fraction score without mutating before Save", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const legacy = { rice: { reach: 10, impact: 2, confidence: 0.8, effort: 2 }, heart: { note: "keep me" } }
    const title = "A long task " + "window".repeat(26)
    const id = await create(request, headers, title, legacy)
    const finished = await create(request, headers, "Completed score outside active work", { rice: { reach: 16, impact: 2, confidence: 100, effort: 1 } }, "complete")
    const deferred = await create(request, headers, "Deferred score outside active work", { rice: { reach: 16, impact: 2, confidence: 100, effort: 1 } })
    try {
      const current = await (await request.get(`/api/tasks/${deferred}`)).json()
      const defer = await request.patch(`/api/tasks/${deferred}/deferral`, {
        headers,
        data: { deferred: true, updated_at: current.task_version, deferral_revision: null },
      })
      expect(defer.ok()).toBe(true)
      await page.setViewportSize({ width: 320, height: 740 })
      await page.goto("/planning#rice")
      const row = page.locator(`[data-rice-task="${id}"]`)
      const link = row.getByRole("link", { name: /Edit score/ })
      await expect(row.locator("[data-rice-legacy-badge]")).toBeVisible()
      await expect(page.locator(`[data-rice-task="${finished}"], [data-rice-task="${deferred}"]`)).toHaveCount(0)
      const navigation = page.waitForResponse(response => response.url().includes(`score=${id}`))
      await link.press("Enter")
      expect((await navigation).headers()["cache-control"]).toBe("private, no-store")
      // Opening an ambiguous score must not mutate stored framework_payload.
      expect(JSON.parse((await (await request.get(`/api/tasks/${id}`)).json()).framework_payload)).toEqual(legacy)
      const form = page.locator("[data-rice-editor]")
      await expect(form.getByRole("heading")).toBeFocused()
      await expect(form.getByRole("spinbutton", { name: "Reach" })).toHaveValue("10")
      await expect(form.getByRole("spinbutton", { name: "Confidence (%)" })).toHaveValue("0.8")
      await form.getByRole("button", { name: "Convert to 80%" }).click()
      await expect(form.getByRole("spinbutton", { name: "Confidence (%)" })).toHaveValue("80")
      await expect(form.locator("output")).toHaveText("8")
      expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await form.getByRole("spinbutton", { name: "Effort" }).fill("0")
      await form.getByRole("button", { name: "Save score" }).press("Enter")
      await expect(form.locator("[data-rice-message]")).toContainText("Effort must be greater than zero")
      await form.getByRole("spinbutton", { name: "Effort" }).fill("0.5")
      await form.getByRole("spinbutton", { name: "Reach" }).fill("0")
      await expect(form.locator("output")).toHaveText("0")
      let delayedShell = 0
      await page.route(/\/_astro\/ParentPageShell\..*\.js$/, async route => {
        delayedShell++
        // Let the score list initialize before the shell reveals its RICE section.
        await new Promise(resolve => setTimeout(resolve, 400))
        await route.continue()
      })
      await form.getByRole("button", { name: "Save score" }).press("Enter")
      await expect(page.locator("#planning-section-rice").getByRole("status").filter({ hasText: "Score saved." })).toBeVisible()
      await expect(row.locator("[data-rice-score]")).toHaveText("0")
      await expect(link).toBeFocused()
      expect(delayedShell).toBe(1)
      await expect(page).toHaveURL(/\/planning#rice$/)
      const saved = await (await request.get(`/api/tasks/${id}`)).json()
      expect(JSON.parse(saved.framework_payload)).toMatchObject({
        heart: legacy.heart,
        rice: { reach: 0, impact: 2, confidence: 80, confidence_unit: "percent", effort: 0.5, score: 0 },
      })
      await page.goto("/tasks?view=table#table")
      await expect(page.locator(`#task-table tr[data-id="${id}"]`)).toHaveAttribute("data-rice", "0")
    } finally {
      for (const task of [id, deferred, finished]) {
        expect((await request.delete(`/api/tasks/${task}`, { headers, data: {} })).status()).toBe(204)
      }
    }
  })

  test("a stale editor preserves another session's write and reloads current estimates", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const id = await create(request, headers, "Score the greenhouse plan")
    const path = `/api/tasks/${id}`
    try {
      await page.goto("/planning#rice")
      const row = page.locator(`[data-rice-list="unscored"] [data-rice-task="${id}"]`)
      await row.getByRole("link", { name: /Edit score/ }).click()
      const form = page.locator("[data-rice-editor]")
      for (const [label, value] of [["Reach", "10"], ["Impact", "2"], ["Confidence (%)", "50"], ["Effort", "2"]] as const) {
        await form.getByRole("spinbutton", { name: label }).fill(value)
      }
      const other = { rice: { reach: 3, impact: 1, confidence: 50, effort: 1, confidence_unit: "percent" }, heart: { note: "newer" } }
      expect((await request.patch(path, { headers, data: { framework_payload: JSON.stringify(other) } })).ok()).toBe(true)
      await form.getByRole("button", { name: "Save score" }).press("Enter")
      await expect(form.locator("[data-rice-message]")).toContainText("This task changed")
      const reload = form.getByRole("button", { name: "Reload score" })
      await expect(reload).toBeFocused()
      await expect(form.getByRole("spinbutton", { name: "Reach" })).toHaveValue("10")
      expect(JSON.parse((await (await request.get(path)).json()).framework_payload)).toEqual(other)
      await reload.press("Enter")
      await expect(form.getByRole("spinbutton", { name: "Reach" })).toHaveValue("3")
      await expect(form.locator("output")).toHaveText("1.5")
    } finally {
      expect((await request.delete(path, { headers, data: {} })).status()).toBe(204)
    }
  })
})
