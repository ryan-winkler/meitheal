import { expect, test, type Route } from "@playwright/test"
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
    await expect(disclosure).toBeVisible()
    await disclosure.locator("summary").press("Enter")
    const completed = disclosure.getByRole("link", { name: title })
    await expect(completed).toBeVisible()
    await completed.press("Enter")
    const status = page.locator("#td-status")
    await expect(status).toHaveValue("complete")
    await expect(status).toBeEnabled()
    const dueSaved = page.waitForResponse(response => response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/tasks/${id}` && response.request().postDataJSON()?.due_date === tomorrow)
    await page.locator("#td-due-date").fill(tomorrow)
    expect((await dueSaved).status()).toBe(200)
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

test("reopening a due favorite keeps its original Focus Stack card", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Review a favorite due today"
  const today = calendarToday()
  const created = await request.post("/api/tasks", {
    data: { title, due_date: today, priority: 1, is_favorite: true },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  try {
    await page.goto("/today#today-focus")
    const focusCard = page.locator(`.focus-card[data-id="${id}"]`)
    const favorite = page.locator(`#today-pinned-list .tli[data-id="${id}"]`)
    const disclosure = page.locator(".today-completed-tasks")
    const completed = disclosure.getByRole("link", { name: title })
    const status = page.locator("#td-status")

    await expect(focusCard).toBeVisible()
    await expect(page.locator(`#today-due-list .tli[data-id="${id}"]`)).toHaveCount(0)

    for (const offset of [0, -1, 1]) {
      await favorite.getByRole("checkbox", { name: `Complete ${title}` }).press("Space")
      await expect(focusCard).toBeHidden()
      await expect(disclosure).toBeVisible()
      if (await disclosure.getAttribute("open") === null) await disclosure.locator("summary").press("Enter")
      await expect(completed).toBeVisible()
      await completed.press("Enter")
      await expect(status).toHaveValue("complete")
      await expect(status).toBeEnabled()
      const dueDate = shiftCalendarDay(today, offset)
      let captureRefresh!: (route: Route) => void
      const refresh = new Promise<Route>(resolve => { captureRefresh = resolve })
      if (offset) {
        const saved = page.waitForResponse(response => response.request().method() === "PUT" &&
          new URL(response.url()).pathname === `/api/tasks/${id}` && response.request().postDataJSON()?.due_date === dueDate)
        await page.locator("#td-due-date").fill(dueDate)
        expect((await saved).status()).toBe(200)
      }
      await page.route(url => url.searchParams.has("todayRefresh"), captureRefresh, { times: 1 })

      // Wait for the refreshed Today row to replace the immediate status update.
      await favorite.evaluate(row => row.setAttribute("data-before-reopen", ""))
      await status.selectOption("active")
      const pending = await refresh
      try {
        await expect(focusCard).toBeHidden()
      } finally {
        if (offset > 0) await pending.abort()
        else await pending.continue()
      }
      if (offset > 0) {
        await expect(page.getByText("Couldn’t refresh Today’s tasks. Reload Today to see the saved changes.")).toBeVisible()
        await expect(focusCard).toBeHidden()
        await expect(status).not.toHaveAttribute("aria-disabled", "true")
        await status.selectOption("pending")
      }
      await expect(page.locator("#today-pinned-list [data-before-reopen]")).toHaveCount(0)
      await expect(favorite).toHaveAttribute("data-due", dueDate)
      if (offset > 0) await expect(focusCard).toBeHidden()
      else {
        await expect(focusCard).toBeVisible()
        await expect(focusCard.locator(".focus-card__due")).toHaveText(offset < 0 ? "Overdue" : "Due today")
        if (offset < 0) await expect(focusCard).toHaveClass(/focus-card--overdue/)
      }
      await page.getByRole("button", { name: "Close detail" }).press("Enter")
    }
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
