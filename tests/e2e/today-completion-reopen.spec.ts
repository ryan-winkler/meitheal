import { expect, test } from "@playwright/test"
import { calendarToday } from "../../apps/web/src/lib/date"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")
test.use({ serviceWorkers: "block" })

test("reopening a completed Today task restores its due row and focus", async ({ page, request }) => {
  const boardHeaders = await currentBoardWriteHeaders(request, "household", {})
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Reopen a due task from Completed today"
  const created = await request.post("/api/tasks", { headers: boardHeaders, data: { title, due_date: calendarToday() } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  try {
    const finished = await request.put(`/api/tasks/${id}`, { headers: boardHeaders, data: { status: "complete" } })
    expect(finished.ok()).toBe(true)
    await page.goto("/today#today-work")
    const due = page.locator(`#today-due-list .tli[data-id="${id}"]`)
    await expect(due).toHaveCount(0)
    const dueCount = page.locator("#today-due-list-count")
    const previousDueCount = Number(await dueCount.textContent())
    const completed = page.locator(".today-completed-tasks")
    await completed.locator("summary").press("Enter")
    await completed.getByRole("link", { name: title }).press("Enter")
    const status = page.locator("#td-status")
    await expect(status).toHaveValue("complete")
    const statusSaved = page.waitForResponse(response =>
      response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/tasks/${id}`)
    await status.selectOption("active")
    expect((await statusSaved).status()).toBe(200)
    await expect(due).toHaveAttribute("data-work-active", "")
    await expect(due).toHaveAttribute("draggable", "true")
    await expect(due.getByRole("checkbox", { name: `Complete ${title}` })).not.toBeChecked()
    await expect(dueCount).toHaveText(String(previousDueCount + 1))
    await expect(completed.getByRole("link", { name: title })).toHaveCount(0)
    await page.getByRole("button", { name: "Close detail" }).press("Enter")
    await expect(due.getByRole("link", { name: title })).toBeFocused()
    await expect(page).toHaveURL(url => url.pathname === "/today" && url.hash === "#today-work")
  } finally {
    await request.delete(`/api/tasks/${id}`, { headers: boardHeaders })
  }
})
