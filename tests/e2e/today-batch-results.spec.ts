import { expect, test } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.use({ serviceWorkers: "block", reducedMotion: "reduce" })
test.skip(shouldSkipBrowserSpecs(), "Requires a disposable Meitheal server")

for (const action of ["complete", "snooze", "delete"] as const) {
  test(`Today batch ${action} refreshes saved changes and retries only the remaining task`, async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const title = `Today batch ${action} ${crypto.randomUUID()}`
    const today = new Date().toISOString().slice(0, 10)
    const ids: string[] = []
    const refusal = deferred<void>()

    async function isSaved(id: string) {
      const result = await request.get(`/api/tasks/${id}`)
      if (action === "delete") return result.status() === 404
      const task = await result.json()
      return action === "complete" ? task.status === "complete" : task.due_date > today
    }

    try {
      for (const suffix of ["saved", "retry"]) {
        const result = await request.post("/api/tasks", { headers, data: { title: `${title} ${suffix}`, due_date: today } })
        expect(result.status(), await result.text()).toBe(201)
        ids.push((await result.json()).id)
      }
      const [savedId, retryId] = ids
      if (!savedId || !retryId) throw new Error("Expected two fixture tasks")
      const method = action === "delete" ? "DELETE" : "PUT"
      const attempted: string[] = []
      let refuse = true
      await page.route("**/api/tasks/*", async route => {
        const id = new URL(route.request().url()).pathname.split("/").at(-1)
        if (route.request().method() !== method || !id || !ids.includes(id)) return route.continue()
        attempted.push(id)
        if (id === retryId && refuse) {
          await refusal.promise
          return route.fulfill({ status: 503, json: { error: "Fixture refused task change" } })
        }
        return route.continue()
      })

      await page.goto(`/today?search=${encodeURIComponent(title)}#today-work`, { waitUntil: "domcontentloaded" })
      await page.locator("#batch-mode-toggle").click()
      let deniedDeleteBodyCancelled = false
      if (action === "delete") {
        await page.exposeFunction("recordDeniedDeleteCancellation", () => { deniedDeleteBodyCancelled = true })
        await page.evaluate(id => {
          const fetchPage = window.fetch.bind(window)
          window.fetch = async (input, init) => {
            const response = await fetchPage(input, init)
            if (init?.method !== "DELETE" || !String(input).endsWith(`/api/tasks/${id}`) || response.status !== 503) return response
            await response.body?.cancel()
            const body = new ReadableStream({
              cancel() {
                void (window as Window & { recordDeniedDeleteCancellation?: () => Promise<void> }).recordDeniedDeleteCancellation?.()
              },
            })
            return new Response(body, { status: 503 })
          }
        }, retryId)
      }
      const savedRow = page.locator(`#today-due-list .tli[data-id="${savedId}"]`)
      const retryRow = page.locator(`#today-due-list .tli[data-id="${retryId}"]`)
      const checkbox = (row: typeof savedRow) => row.getByRole("checkbox", { name: "Select for batch action" })
      await checkbox(savedRow).check()
      await checkbox(retryRow).check()
      const bar = page.locator("#batch-action-bar")
      const actionButton = bar.locator(`button[value="${action}"]`)
      const dueCount = page.locator('[data-today-count="dueToday"]')
      const initialCount = Number(await dueCount.textContent())

      const apply = async () => {
        await actionButton.press("Enter")
        if (action === "delete") await page.getByRole("alertdialog").getByRole("button", { name: "Delete All" }).click()
      }

      await apply()
      await expect.poll(() => isSaved(savedId)).toBe(true)
      await expect.poll(() => attempted.length).toBe(2)
      await expect(bar.locator('button[value="snooze"]')).toBeDisabled()
      await actionButton.evaluate(button => (button as HTMLButtonElement).click())
      refusal.resolve()
      expect(await isSaved(retryId)).toBe(false)
      if (action === "delete") await expect.poll(() => deniedDeleteBodyCancelled).toBe(true)
      await expect(savedRow).toHaveCount(0)
      await expect(dueCount).toHaveText(String(initialCount - 1))
      await expect(checkbox(retryRow)).toBeChecked()
      await expect(bar).toContainText("1 selected")
      await expect(actionButton).toBeFocused()
      await expect(page.getByRole("alert").filter({ hasText: "Saved changes for 1 of 2 tasks." })).toBeVisible()

      refuse = false
      await apply()
      await expect.poll(() => isSaved(retryId)).toBe(true)
      await expect(retryRow).toHaveCount(0)
      expect(attempted.slice(0, 2).sort()).toEqual([savedId, retryId].sort())
      expect(attempted.slice(2)).toEqual([retryId])
    } finally {
      refusal.resolve()
      for (const id of ids) {
        const removed = await request.delete(`/api/tasks/${id}`, { headers, data: {} })
        expect([204, 404]).toContain(removed.status())
      }
    }
  })
}
