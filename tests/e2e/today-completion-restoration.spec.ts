import { expect, test } from "@playwright/test"
import { calendarToday, shiftCalendarDay } from "../../apps/web/src/lib/date"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")
test.use({ serviceWorkers: "block" })

test("reopening from Completed today restores a due task evicted from the preview", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  const title = "Restore a due task after preview eviction"
  const ids: string[] = []
  async function completeTask(taskTitle: string) {
    const created = await request.post("/api/tasks", { data: { title: taskTitle, due_date: calendarToday() } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    ids.push(id)
    const completed = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
    expect(completed.ok()).toBe(true)
    return id
  }
  try {
    const id = await completeTask(title)
    for (let i = 1; i < 20; i++) await completeTask(`Newer completion ${i}`)
    await page.goto("/today#today-work")
    const disclosure = page.locator(".today-completed-tasks")
    await disclosure.locator("summary").press("Enter")
    const completedLink = disclosure.getByRole("link", { name: title })
    const due = page.locator(`#today-due-list .tli[data-id="${id}"]`)
    await expect(due).toHaveCount(0)
    await completedLink.press("Enter")
    await expect(page.locator("#td-title")).toHaveValue(title)

    await completeTask("Completion that displaces the first")
    await page.clock.fastForward(30_100)
    await expect(disclosure.locator("summary")).toHaveText("Completed today (21)")
    await expect(completedLink).toHaveCount(0)
    await page.getByRole("button", { name: "Mark as Undone" }).click()
    await expect(due.getByRole("checkbox", { name: `Complete ${title}` })).not.toBeChecked()
    await page.getByRole("button", { name: "Close detail" }).press("Enter")
    await expect(due.getByRole("link", { name: title })).toBeFocused()
  } finally {
    for (const id of ids) {
      const deleted = await request.delete(`/api/tasks/${id}`, { data: {} })
      expect(deleted.status()).toBe(204)
    }
  }
})

test("reopening from Completed today moves a rescheduled task out of its old list", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Review tomorrow’s inspection"
  const tomorrow = shiftCalendarDay(calendarToday(), 1)
  const created = await request.post("/api/tasks", { data: { title, due_date: calendarToday(), priority: 2 } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  try {
    await page.goto("/today#today-work")
    const due = page.locator(`#today-due-list .tli[data-id="${id}"]`)
    const checked = due.getByRole("checkbox", { name: `Complete ${title}` })
    const dueCount = page.locator("#today-due-list-count")
    await expect(due).toHaveAttribute("draggable", "true")
    const remaining = Number(await dueCount.textContent()) - 1
    await checked.press("Space")
    await expect(checked).toBeChecked()
    const disclosure = page.locator(".today-completed-tasks")
    await disclosure.locator("summary").press("Enter")
    await disclosure.getByRole("link", { name: title }).press("Enter")
    const status = page.locator("#td-status")
    await expect(status).toHaveValue("complete")
    await expect(status).toBeEnabled()
    const dueSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/tasks/${id}` && response.request().postDataJSON()?.due_date === tomorrow)
    await page.locator("#td-due-date").fill(tomorrow)
    expect((await dueSaved).ok()).toBe(true)
    await status.selectOption("active")

    const suggested = page.locator(`#today-suggested-list .tli[data-id="${id}"]`)
    await expect(suggested).toHaveAttribute("data-due", tomorrow)
    await expect(suggested).toHaveAttribute("data-work-active", "")
    await expect(due).toHaveCount(0)
    await expect(dueCount).toHaveText(String(remaining))
    if (remaining === 0) await expect(page.locator("[data-today-due-empty]")).toBeVisible()
    await expect(page.locator(`.focus-card[data-id="${id}"]`)).toBeHidden()
    await expect(disclosure.getByRole("link", { name: title })).toHaveCount(0)
    await page.getByRole("button", { name: "Close detail" }).press("Enter")
    await expect(suggested.getByRole("link", { name: title })).toBeFocused()
  } finally {
    await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})

for (const { name, sectionId, task } of [
  { name: "Carried Forward", sectionId: "section-carried", task: { due_date: shiftCalendarDay(calendarToday(), -1) } },
  { name: "Suggested", sectionId: "section-suggested", task: { due_date: shiftCalendarDay(calendarToday(), 1), priority: 1 } },
  { name: "Shared favorites", sectionId: "section-pinned", task: { is_favorite: true } },
  { name: "Unscheduled", sectionId: "section-unscheduled", task: {} },
]) {
  test(`reopening from Completed today restores ${name} without a reload`, async ({ page, request }) => {
    await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
    await page.emulateMedia({ reducedMotion: "reduce" })
    const title = `Restore completed task to ${name}`
    const created = await request.post("/api/tasks", { data: { title, ...task } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      const completed = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
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
      await status.selectOption("active")
      await expect(count).toHaveText(String(previousCount + 1))
      await expect(section).toBeVisible()
      await expect(completion).toHaveCount(0)
      await page.getByRole("button", { name: "Close detail" }).press("Enter")
      if (sectionId === "section-unscheduled") {
        await section.getByRole("button", { name: /^Unscheduled/ }).click()
      } else {
        await expect(row.getByRole("link", { name: title })).toBeFocused()
      }
      await expect(row).toHaveAttribute("data-work-active", "")
      if (sectionId === "section-carried") await expect(page.locator("[data-today-carried-empty]")).toBeHidden()
    } finally {
      await request.delete(`/api/tasks/${id}`, { data: {} })
    }
  })
}
