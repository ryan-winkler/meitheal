import { expect, test } from "@playwright/test"
import { calendarToday, shiftCalendarDay } from "../../apps/web/src/lib/date"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")
test.use({ serviceWorkers: "block" })

for (const { name, sectionId, task } of [
  { name: "Carried Forward", sectionId: "section-carried", task: { due_date: shiftCalendarDay(calendarToday(), -1) } },
  { name: "Suggested", sectionId: "section-suggested", task: { due_date: shiftCalendarDay(calendarToday(), 1), priority: 1 } },
  { name: "Promoted", sectionId: "section-pinned", task: { is_promoted: true } },
]) {
  test(`reopening from Completed today restores ${name} without a reload`, async ({ page, request }) => {
    const headers = await currentBoardWriteHeaders(request, "household", {})
    await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
    await page.emulateMedia({ reducedMotion: "reduce" })
    const title = `Restore completed task to ${name}`
    const created = await request.post("/api/tasks", { headers, data: { title, ...task } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      const completed = await request.put(`/api/tasks/${id}`, { headers, data: { status: "complete" } })
      expect(completed.ok()).toBe(true)
      await page.goto("/today#today-work")
      const section = page.locator(`#${sectionId}`)
      const row = section.locator(`.tli[data-id="${id}"]`)
      await expect(row).toHaveCount(0)
      const count = section.locator(".today-section__count")
      const previousCount = Number(await count.textContent())
      const disclosure = page.locator(".today-completed-tasks")
      await disclosure.locator("summary").press("Enter")
      const completion = disclosure.getByRole("link", { name: title })
      await completion.press("Enter")
      const status = page.locator("#td-status")
      await expect(status).toHaveValue("complete")
      const reopened = page.waitForResponse(response => response.request().method() === "PUT" &&
        new URL(response.url()).pathname === `/api/tasks/${id}`)
      await status.selectOption("active")
      expect((await reopened).status()).toBe(200)
      await expect(count).toHaveText(String(previousCount + 1))
      await expect(section).toBeVisible()
      await expect(completion).toHaveCount(0)
      await page.getByRole("button", { name: "Close detail" }).press("Enter")
      await expect(row.getByRole("link", { name: title })).toBeFocused()
      await expect(row).toHaveAttribute("data-work-active", "")
      if (sectionId === "section-carried") await expect(page.locator("[data-today-carried-empty]")).toBeHidden()
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers, data: {} })
    }
  })
}
