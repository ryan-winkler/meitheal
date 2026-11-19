import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")

test("Dashboard Focus Queue selects open work before applying its row limit", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", {})
  const ids: string[] = []
  try {
    for (let index = 0; index < 15; index++) {
      const task = await request.post("/api/tasks", { headers, data: { title: `Cancelled inspection ${index}`, priority: 1 } })
      expect(task.status()).toBe(201)
      const { id } = await task.json()
      ids.push(id)
      const closed = await request.put(`/api/tasks/${id}`, { headers, data: { status: "cancelled" } })
      expect(closed.ok()).toBe(true)
    }
    const task = await request.post("/api/tasks", { headers, data: { title: "Open inspection", status: "pending", priority: 3 } })
    expect(task.status()).toBe(201)
    const { id } = await task.json()
    ids.push(id)
    await page.goto("/")
    const queue = page.locator("#my-open-list")
    await expect(queue.locator(`[data-id="${id}"]`)).toContainText("Open inspection")
    await expect(queue.getByText(/Cancelled inspection/)).toHaveCount(0)
    await expect(page.locator("#my-open-count")).toHaveText("1 open task")
    await expect(page.locator("#dashboard-stat-open-count")).toHaveText("1")
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers, data: {} })
  }
})
