import { expect, test, type APIRequestContext } from "@playwright/test"
import { readRiceInputs, riceLensScore } from "../../apps/web/src/lib/rice-lens"

test("the shared lens reads numeric legacy fields, nested scores and zero values", () => {
  const legacy = { reach: "10", impact: 2, confidence: 50, effort: 2 }
  expect(riceLensScore(readRiceInputs(legacy)!)).toBe(500)
  expect(riceLensScore(readRiceInputs({ ...legacy, rice: { ...legacy, reach: 0 } })!)).toBe(0)
  expect(readRiceInputs({ ...legacy, effort: 0 })).toBeNull()
  expect(readRiceInputs({ ...legacy, confidence: "" })).toBeNull()
  expect(readRiceInputs({ ...legacy, impact: true })).toBeNull()
})

test.describe("Planning RICE editor", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  test.use({ serviceWorkers: "block" })

  async function create(request: APIRequestContext, title: string, payload = {}, status = "pending") {
    const response = await request.post("/api/tasks", { data: { title, status, framework_payload: JSON.stringify(payload) } })
    expect(response.status()).toBe(201)
    return (await response.json()).id as string
  }

  test("edits a legacy score in place and preserves the rest of its payload", async ({ page, request }) => {
    const legacy = { reach: "10", impact: 2, confidence: 50, effort: 2, heart: { note: "keep me" } }
    const title = "A long task " + "window".repeat(26)
    const id = await create(request, title, legacy)
    const finished = await create(request, "Completed score outside active work", legacy, "complete")
    const deferred = await create(request, "Deferred score outside active work", legacy)
    try {
      const current = await (await request.get(`/api/tasks/${deferred}`)).json()
      const defer = await request.patch(`/api/tasks/${deferred}/deferral`, {
        data: { deferred: true, updated_at: current.task_version, deferral_revision: null },
      })
      expect(defer.ok()).toBe(true)
      await page.setViewportSize({ width: 320, height: 740 })
      await page.goto("/planning#rice")
      const row = page.locator(`[data-rice-task="${id}"]`)
      const link = row.getByRole("link", { name: /Edit score/ })
      await expect(row.locator("[data-rice-score]")).toHaveText("500")
      await expect(page.locator(`[data-rice-task="${finished}"], [data-rice-task="${deferred}"]`)).toHaveCount(0)
      const navigation = page.waitForResponse(response => response.url().includes(`score=${id}`))
      await link.press("Enter")
      expect((await navigation).headers()["cache-control"]).toBe("private, no-store")
      const form = page.locator("[data-rice-editor]")
      await expect(form.getByRole("heading")).toBeFocused()
      await expect(form.getByRole("spinbutton", { name: "Reach" })).toHaveValue("10")
      expect(await form.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await form.getByRole("spinbutton", { name: "Effort" }).fill("0")
      await form.getByRole("button", { name: "Save score" }).press("Enter")
      await expect(form.locator("[data-rice-message]")).toContainText("Effort must be greater than zero")
      await form.getByRole("spinbutton", { name: "Effort" }).fill("0.5")
      await form.getByRole("spinbutton", { name: "Reach" }).fill("0")
      await expect(form.locator("output")).toHaveText("0")
      await form.getByRole("button", { name: "Save score" }).press("Enter")
      await expect(page.locator("#planning-section-rice").getByRole("status").filter({ hasText: "Score saved." })).toBeVisible()
      await expect(row.locator("[data-rice-score]")).toHaveText("0")
      await expect(link).toBeFocused()
      const saved = await (await request.get(`/api/tasks/${id}`)).json()
      expect(JSON.parse(saved.framework_payload)).toMatchObject({
        ...legacy,
        rice: { reach: 0, impact: 2, confidence: 50, effort: 0.5, score: 0 },
      })
      await page.goto("/tasks?view=table#table")
      await expect(page.locator(`#task-table tr[data-id="${id}"]`)).toHaveAttribute("data-rice", "0")
    } finally {
      for (const task of [id, deferred, finished]) {
        expect((await request.delete(`/api/tasks/${task}`, { data: {} })).status()).toBe(204)
      }
    }
  })

  test("a stale editor preserves another session's write and reloads current estimates", async ({ page, request }) => {
    const id = await create(request, "Score the greenhouse plan")
    const path = `/api/tasks/${id}`
    try {
      await page.goto("/planning#rice")
      const row = page.locator(`[data-rice-list="unscored"] [data-rice-task="${id}"]`)
      await row.getByRole("link", { name: /Edit score/ }).click()
      const form = page.locator("[data-rice-editor]")
      for (const [label, value] of [["Reach", "10"], ["Impact", "2"], ["Confidence (%)", "50"], ["Effort", "2"]] as const) {
        await form.getByRole("spinbutton", { name: label }).fill(value)
      }
      const other = { rice: { reach: 3, impact: 1, confidence: 50, effort: 1 }, heart: { note: "newer" } }
      expect((await request.patch(path, { data: { framework_payload: JSON.stringify(other) } })).ok()).toBe(true)
      await form.getByRole("button", { name: "Save score" }).press("Enter")
      await expect(form.locator("[data-rice-message]")).toContainText("This task changed")
      const reload = form.getByRole("button", { name: "Reload score" })
      await expect(reload).toBeFocused()
      await expect(form.getByRole("spinbutton", { name: "Reach" })).toHaveValue("10")
      expect(JSON.parse((await (await request.get(path)).json()).framework_payload)).toEqual(other)
      await reload.press("Enter")
      await expect(form.getByRole("spinbutton", { name: "Reach" })).toHaveValue("3")
      await expect(form.locator("output")).toHaveText("150")
    } finally {
      expect((await request.delete(path, { data: {} })).status()).toBe(204)
    }
  })
})
