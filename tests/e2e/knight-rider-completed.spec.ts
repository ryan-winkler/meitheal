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
  await expect(disclosure.getByRole("link", { name: "Put the spare valves away" })).toHaveCSS("text-decoration-line", "line-through")
  await empty.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath("knight-rider-completed.png"), animations: "disabled" })

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
  await request.delete(`/api/tasks/${id}`)
})

test("Today holds the displayed date and counts together after rollover", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.clock.install()
  await page.goto("/today")
  const date = await page.locator(".today-summary__date time").getAttribute("datetime")
  const count = page.locator('[data-today-count="completedToday"]')
  const originalCount = await count.textContent()
  await page.route(url => url.pathname === "/api/tasks/today-counts", route => route.fulfill({
    status: 409, json: { error: "Today has changed. Refresh the view." },
  }))
  const refresh = page.waitForRequest(request => new URL(request.url()).pathname === "/api/tasks/today-counts")
  await page.clock.fastForward(30_100)
  expect(new URL((await refresh).url()).searchParams.get("expected_day")).toBe(date)
  await expect(page.getByRole("button", { name: "Refresh Today" })).toBeVisible()
  await expect(page.locator("#clear-completed-btn")).toHaveAttribute("aria-disabled", "true")
  await expect(count).toHaveText(originalCount!)
  await expect(page.locator(".today-summary__date time")).toHaveAttribute("datetime", date!)
})

test("Today keeps focus on a completion during polling and recovers when it disappears", async ({ page }) => {
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
    for (const id of tasks) await request.delete(`/api/tasks/${id}`)
  }
})
