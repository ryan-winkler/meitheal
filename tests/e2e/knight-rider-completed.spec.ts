import { expect, test } from "@playwright/test"
import { calendarToday, shiftCalendarDay } from "../../apps/web/src/lib/date"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")
test.use({ serviceWorkers: "block" })

test("Knight Rider keeps the completed Today state and saved theme truthful", async ({ page, request }, testInfo) => {
  const saved = await request.put("/api/settings", { data: { key: "theme", value: "knight-rider" } })
  expect(saved.ok()).toBe(true)
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.goto("/today#today-work")
  const main = page.locator("#page-shell")
  await expect(main).toHaveCSS("max-width", "960px")
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/)
  const empty = page.locator("#today-due-list .empty-state")
  await expect(empty.getByRole("heading")).toHaveText("Nothing due today")
  await expect(empty).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await empty.getByRole("button", { name: "Add a task" }).click()
  await expect(page.locator("#new-task-title-input")).toBeFocused()

  const create = await request.post("/api/tasks", { data: {
    title: "Put the spare valves away", due_date: shiftCalendarDay(calendarToday(), -1), is_favorite: 1,
  } })
  expect(create.status()).toBe(201)
  const { id } = await create.json()
  const complete = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
  expect(complete.ok()).toBe(true)
  await page.reload()
  await expect(empty.getByRole("heading")).toHaveText("Today’s tasks are complete")
  const disclosure = page.locator(".today-completed-tasks")
  await disclosure.locator("summary").click()
  const completedLink = disclosure.getByRole("link", { name: "Put the spare valves away" })
  await expect(completedLink).toHaveCSS("text-decoration-line", "line-through")
  await empty.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath("knight-rider-completed.png"), animations: "disabled" })
  await page.setViewportSize({ width: 320, height: 840 })
  expect((await completedLink.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect((await disclosure.getByRole("button", { name: "Archive completed" }).boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await completedLink.click({ position: { x: 8, y: 22 } })
  await expect(page.locator("#td-title")).toHaveValue("Put the spare valves away")
  await page.keyboard.press("Escape")
  await page.setViewportSize({ width: 1440, height: 900 })

  await page.goto("/settings#look-and-feel-settings")
  const select = page.locator("#theme-select")
  await expect(select).toHaveValue("knight-rider")
  await page.route("**/api/settings", route => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 503 })
    return route.continue()
  })
  const rejectedTheme = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/settings" && response.request().method() === "PUT")
  await select.selectOption("light")
  expect((await rejectedTheme).status()).toBe(503)
  await expect(select).toHaveValue("knight-rider")
  await expect(page.locator("html")).toHaveAttribute("data-theme", "knight-rider")
  expect(await page.evaluate(() => localStorage.getItem("meitheal-theme"))).toBe("knight-rider")
  const persisted = await request.get("/api/settings?key=theme")
  expect((await persisted.json()).value).toBe("knight-rider")
  await page.unroute("**/api/settings")

  await page.goto("/today#today-work")
  await disclosure.locator("summary").click()
  await disclosure.getByRole("button", { name: "Archive completed", exact: true }).click()
  const archived = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks/clear-completed")
  await page.getByRole("button", { name: "Archive", exact: true }).click()
  expect(await (await archived).json()).toMatchObject({ ok: true, cleared: 1 })
  await expect(disclosure).toBeHidden()
  await expect(page.locator("#clear-completed-btn")).toBeVisible()
  await page.goto("/")
  for (const section of ["#dashboard-open", "#dashboard-momentum", "#dashboard-recent"]) {
    await expect(page.locator(section).getByText("Put the spare valves away")).toHaveCount(0)
  }
  await expect(page.locator("#dashboard-stat-open-count")).toHaveText("0")
  await expect(page.locator("#stat-overdue .stat-value")).toHaveText("0")
  await request.delete(`/api/tasks/${id}`, { data: {} })
})

test("Today reflects task detail completion and reopening without a reload", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Schedule the heating service"
  const response = await request.post("/api/tasks", { data: { title, status: "active", due_date: calendarToday() } })
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  try {
    await page.goto("/today#today-work")
    const item = page.locator(`#today-due-list .tli[data-id="${id}"]`)
    const focus = page.locator(`.focus-card[data-id="${id}"]`)
    const done = page.locator("#td-toggle-done")
    const completed = page.locator(".today-completed-tasks")
    await expect(item).toHaveAttribute("data-work-active", "")
    await expect(focus).toBeVisible()
    await focus.getByRole("link", { name: title }).press("Enter")
    await expect(page.locator("#td-title")).toHaveValue(title)
    await expect(done).toBeEnabled()
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route(`**/api/tasks/${id}`, async route => {
      await pending
      await route.continue()
    }, { times: 1 })
    try {
      await done.press("Enter")
      await expect(done).toHaveAttribute("aria-disabled", "true")
      await expect(done).toBeFocused()
    } finally {
      release()
    }
    await expect(item.locator(".tli__checkbox")).toBeChecked()
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.locator("#today-filter-status")).toBeFocused()
    await expect(item).not.toHaveAttribute("data-work-active", "")
    await expect(focus).toBeHidden()
    await expect(completed.locator("summary")).toHaveText("Completed today (1)")

    await item.getByRole("link", { name: title }).click()
    const status = page.locator("#td-status")
    await expect(status).toHaveValue("complete")
    await expect(status).toBeEnabled()
    await page.route(`**/api/tasks/${id}`, route => route.fulfill({ status: 503 }), { times: 1 })
    await status.selectOption("active")
    await expect(status).toHaveValue("complete")
    await expect(item).not.toHaveAttribute("data-work-active", "")
    await status.selectOption("active")
    await expect(item).toHaveAttribute("data-work-active", "")
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(focus).toBeVisible()
    await expect(completed).toBeHidden()
  } finally {
    await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})

test("docked Details shares the Today status lock and reflects a row save", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  const title = "Check the boiler schedule"
  const response = await request.post("/api/tasks", { data: { title, status: "active", due_date: calendarToday() } })
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  let release = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  try {
    await page.goto("/today#today-work")
    const item = page.locator(`#today-due-list .tli[data-id="${id}"]`)
    await item.getByRole("link", { name: title }).click()
    const status = page.locator("#td-status")
    const done = page.locator("#td-toggle-done")
    await expect(status).toHaveValue("active")
    await expect(status).toBeEnabled()
    await page.route(`**/api/tasks/${id}`, async route => {
      if (route.request().method() !== "PUT") return route.continue()
      writes++
      await pending
      await route.continue()
    })
    await item.locator(".tli__checkbox").click()
    await expect.poll(() => writes).toBe(1)
    await status.selectOption("pending")
    await expect(status).toHaveValue("active")
    await expect(page.getByText("A status change is still saving.")).toBeVisible()
    expect(writes).toBe(1)
    release()
    await expect(status).toHaveValue("complete")
    await expect(done).toHaveText("Mark as Undone")
  } finally {
    release()
    await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})

test("Unscheduled and Refresh Today keep their route with Details docked", async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  const title = "Check the unscheduled work"
  const response = await request.post("/api/tasks", { data: { title } })
  expect(response.status()).toBe(201)
  const { id } = await response.json()
  try {
    await page.goto("/today?unscheduledPage=1#today-work")
    const row = page.locator(`#today-unscheduled-list .tli[data-id="${id}"]`)
    await row.getByRole("link", { name: title }).click()
    await expect(page).toHaveURL(/\/tickets\//)
    const status = page.locator("#td-status")
    await expect(status).toBeEnabled()
    const done = page.locator("#td-toggle-done")
    await done.click()
    await expect(status).toHaveValue("complete")
    await expect(row).toHaveCount(0)
    await expect(page).toHaveURL(/\/tickets\//)
    await expect(page.locator("#today-unscheduled-retry")).toBeHidden()

    await done.click()
    await expect(status).toHaveValue("pending")
    await expect(row).toBeVisible()
    await expect(page).toHaveURL(/\/tickets\//)

    const unscheduled = page.locator("#section-unscheduled .today-section__toggle")
    await unscheduled.click()
    await expect(unscheduled).toHaveAttribute("aria-expanded", "false")
    await page.locator("#td-close").click()
    await expect(page).toHaveURL(url => url.pathname === "/today" && !url.searchParams.has("unscheduledPage"))
    await expect(page.locator("#task-detail-overlay")).toBeHidden()

    await unscheduled.click()
    await row.getByRole("link", { name: title }).click()
    await expect(status).toBeEnabled()
    await unscheduled.click()
    await page.evaluate(() => history.back())
    await expect(page).toHaveURL(url => url.pathname === "/today" && !url.searchParams.has("unscheduledPage"))
    await expect(page.locator("#task-detail-overlay")).toBeHidden()

    await unscheduled.click()
    await row.getByRole("link", { name: title }).click()
    await expect(status).toBeEnabled()
    await page.route(url => url.pathname === "/api/tasks/today-counts", route => route.fulfill({ status: 409 }))
    await status.selectOption("active")
    const refresh = page.getByRole("button", { name: "Refresh Today" })
    await expect(refresh).toBeVisible()
    await refresh.click()
    await expect(page).toHaveURL(url => url.pathname === "/today" && url.searchParams.get("unscheduledPage") === "1")
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
  } finally {
    await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})

test("Today holds the displayed date and counts together after rollover", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.clock.install()
  await page.goto("/today#today-work")
  const date = await page.locator(".today-summary__date time").getAttribute("datetime")
  const count = page.locator('[data-today-count="completedToday"]')
  const originalCount = await count.textContent()
  await page.route(url => url.pathname === "/api/tasks/today-counts", route => route.fulfill({
    status: 409, json: { error: "Today has changed. Refresh the view." },
  }))
  const refresh = page.waitForRequest(request => new URL(request.url()).pathname === "/api/tasks/today-counts")
  await page.clock.fastForward(30_100)
  const scope = new URL((await refresh).url()).searchParams
  expect(scope.get("expected_day")).toBe(date)
  expect(scope.get("expected_timezone")).toBe(await page.locator("#page-shell").getAttribute("data-today-timezone"))
  await expect(page.getByRole("button", { name: "Refresh Today" })).toBeVisible()
  await expect(page.locator("#clear-completed-btn")).toHaveAttribute("aria-disabled", "true")
  await expect(count).toHaveText(originalCount!)
  await expect(page.locator(".today-summary__date time")).toHaveAttribute("datetime", date!)
  const documentRequest = page.waitForResponse(response => response.request().resourceType() === "document" &&
    new URL(response.url()).pathname === "/today")
  await page.getByRole("button", { name: "Refresh Today" }).click()
  expect((await documentRequest).ok()).toBe(true)
  await expect(page).toHaveURL(/\/today#today-work$/)
  await expect(page.getByRole("button", { name: "Refresh Today" })).toBeHidden()
})

test("Today keeps focus on a completion during polling and recovers when it disappears", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 840 })
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.clock.install()
  const first = { id: "completed-poll-one", title: "Finished kitchen task" }
  const second = { id: "completed-poll-two", title: "Finished workshop task" }
  let completedTasks = [first]
  await page.route(url => url.pathname === "/api/tasks/today-counts", route => route.fulfill({ json: {
    completedTasks, completedToday: completedTasks.length, dueToday: 0,
    remaining: 0, carriedForward: 0, completionPercent: 100,
  } }))
  await page.goto("/today#today-work")
  const disclosure = page.locator(".today-completed-tasks")
  const summary = disclosure.locator("summary")
  await page.clock.fastForward(30_100)
  await expect(summary).toHaveText("Completed today (1)")
  await summary.focus()
  await page.keyboard.press("Enter")
  const focused = disclosure.getByRole("link", { name: first.title })
  expect((await focused.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await focused.focus()

  completedTasks = [second, first]
  await page.clock.fastForward(30_100)
  await expect(summary).toHaveText("Completed today (2)")
  await expect(focused).toBeFocused()

  completedTasks = [second]
  await page.clock.fastForward(30_100)
  await expect(summary).toHaveText("Completed today (1)")
  await expect(focused).toHaveCount(0)
  await expect(summary).toBeFocused()

  completedTasks = []
  await page.clock.fastForward(30_100)
  await expect(disclosure).toBeHidden()
  await expect(page.locator("#clear-completed-btn")).toBeFocused()
})

test("keyboard completion keeps a focus target when the Active filter removes a row", async ({ page, request }) => {
  const due_date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", dateStyle: "short" }).format(new Date())
  const tasks = []
  for (const title of ["Replace the pump filter before the spring irrigation check", "Replace the pump filter before the autumn irrigation check"]) {
    const response = await request.post("/api/tasks", { data: { title, due_date, status: "active" } })
    expect(response.status(), await response.text()).toBe(201)
    const { id } = await response.json()
    tasks.push(String(id))
  }
  let release: (() => void) | undefined
  try {
    await page.goto("/today?status=active#today-work")
    await expect(page.getByRole("combobox", { name: "Filter by status" })).toHaveValue("active")
    const [first, other] = tasks.map(id => page.locator(`#today-due-list .tli[data-id="${id}"]`))
    const checkbox = first!.locator(".tli__checkbox")
    await page.route(`**/api/tasks/${tasks[0]}`, async route => {
      if (route.request().method() === "PUT") await new Promise<void>(resolve => { release = resolve })
      await route.continue()
    })
    await checkbox.focus()
    await page.keyboard.press("Space")
    await expect(checkbox).toBeFocused()
    await expect(checkbox).toHaveAttribute("aria-disabled", "true")
    await expect.poll(() => Boolean(release)).toBe(true)
    release?.()
    await expect(first!).toBeHidden()
    await expect(other!.locator(".tli__checkbox")).toBeFocused()
  } finally {
    release?.()
    for (const id of tasks) await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})

test("Today keeps the newer Tab position after a pending task completion", async ({ page, request }) => {
  const ids: string[] = []
  let release: (() => void) | undefined
  try {
    for (const title of ["Close the first inspection", "Open the second inspection"]) {
      const response = await request.post("/api/tasks", { data: { title, due_date: calendarToday(), status: "active" } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    await page.route(`**/api/tasks/${ids[0]}`, async route => {
      if (route.request().method() === "PUT") await new Promise<void>(resolve => { release = resolve })
      await route.continue()
    })
    await page.goto("/today#today-work")
    const item = page.locator(`#today-due-list .tli[data-id="${ids[0]}"]`)
    const checkbox = item.locator(".tli__checkbox")
    await checkbox.press("Space")
    await expect(checkbox).toHaveAttribute("aria-disabled", "true")
    await page.keyboard.press("Tab")
    const detail = item.getByRole("link", { name: "Close the first inspection" })
    await expect(detail).toBeFocused()
    await expect.poll(() => Boolean(release)).toBe(true)
    release?.()
    await expect(checkbox).not.toHaveAttribute("aria-disabled")
    await expect(detail).toBeFocused()
  } finally {
    release?.()
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})


test("reopening a completed Today task restores its due row and focus", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Reopen a due task from Completed today"
  const created = await request.post("/api/tasks", { data: { title, due_date: calendarToday() } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  try {
    const finished = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
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
    await status.selectOption("active")
    await expect(due).toHaveAttribute("data-work-active", "")
    await expect(due).toHaveAttribute("draggable", "true")
    await expect(due.getByRole("checkbox", { name: `Complete ${title}` })).not.toBeChecked()
    await expect(dueCount).toHaveText(String(previousDueCount + 1))
    await expect(completed.getByRole("link", { name: title })).toHaveCount(0)
    await page.getByRole("button", { name: "Close detail" }).press("Enter")
    await expect(due.getByRole("link", { name: title })).toBeFocused()
    await expect(page).toHaveURL(url => url.pathname === "/today" && url.hash === "#today-work")
  } finally {
    await request.delete(`/api/tasks/${id}`)
  }
})

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
    for (const id of ids) await request.delete(`/api/tasks/${id}`)
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
      await request.delete(`/api/tasks/${id}`)
    }
  })
}
