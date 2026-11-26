import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block" })

test("Table keeps a saved group move when the row order is rejected", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const ids: string[] = []
  try {
    for (const [title, priority] of [["Move row partial source", 2], ["Move row partial destination", 3]] as const) {
      const response = await request.post("/api/tasks", { headers, data: { title, priority } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }

    await page.route("**/api/tasks/reorder", route => route.fulfill({ status: 503, json: { error: "Unavailable" } }))
    await page.goto("/tasks?view=table&search=Move+row+partial&groupBy=priority#table")
    await expect(page.locator("#table-shell")).toHaveAttribute("data-table-ready", "true")
    const row = page.locator(`.table-row[data-id="${ids[0]}"]`)
    const handle = row.locator(".table-row-drag-handle")
    const isAfterTarget = await row.evaluate((element, otherId) =>
      Boolean(element.compareDocumentPosition(document.querySelector(`.table-row[data-id="${otherId}"]`)!) & Node.DOCUMENT_POSITION_PRECEDING),
    ids[1])
    const refreshed = page.waitForResponse(response => new URL(response.url()).searchParams.has("tableRefresh"))
    await handle.press(isAfterTarget ? "Alt+ArrowUp" : "Alt+ArrowDown")

    await expect(page.getByText("Group saved. Could not save row order.", { exact: true })).toBeVisible()
    expect((await refreshed).ok()).toBeTruthy()
    await expect(row).toHaveAttribute("data-priority", "3")
    await expect(page.locator('.group-header-row[data-group-key="2"]')).toHaveCount(0)
    await expect(page.locator('.group-header-row[data-group-key="3"] .group-count')).toHaveText("2")
    await expect(handle).toBeFocused()
    expect(await (await request.get(`/api/tasks/${ids[0]}`)).json()).toMatchObject({ priority: 3 })
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})
