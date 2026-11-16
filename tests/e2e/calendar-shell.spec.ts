import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Calendar Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test.beforeEach(async ({ page }) => {
    await page.goto("/calendar")
    await page.waitForLoadState("networkidle")
  })

  test("legacy route opens Calendar and a keyboard user can inspect a day", async ({ page }) => {
    await expect(page).toHaveURL(/\/tasks\?view=calendar#calendar$/)
    await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible()
    const views = page.getByRole("navigation", { name: "Task views" })
    await expect(views.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page")

    await page.locator('.cal-cell[data-date]:not(.cal-other)').first().press("Enter")

    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
    await expect(page.locator("#day-drawer-close")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "true")
    await expect(page.locator('.cal-cell[data-date]:not(.cal-other)').first()).toBeFocused()
  })

  test("phone filters stay compact, accessible and marked when active", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 })
    await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
    const disclosure = page.getByRole("button", { name: "Filters", exact: true })
    const toolbar = page.locator("#calendar-filter-bar")
    await expect(disclosure).toHaveAttribute("aria-expanded", "false")
    await expect(toolbar).toBeHidden()
    await expect(page.getByRole("heading", { name: "July 2031" })).toBeInViewport()
    expect((await disclosure.boundingBox())?.height).toBeGreaterThanOrEqual(44)

    await disclosure.press("Enter")
    await expect(toolbar).toBeVisible()
    await page.keyboard.press("Tab")
    const search = toolbar.getByRole("textbox", { name: "Filter by text" })
    await expect(search).toBeFocused()
    await search.fill("phone calendar filter")
    await expect(page).toHaveURL(/search=phone\+calendar\+filter/)
    await page.keyboard.press("Escape")
    const active = page.getByRole("button", { name: "Filters Active" })
    await expect(active).toBeFocused()
    await expect(active).toHaveAttribute("aria-expanded", "false")
    await expect(toolbar).toBeHidden()

    await page.setViewportSize({ width: 1100, height: 780 })
    await expect(active).toBeHidden()
    await expect(toolbar).toBeVisible()
    await expect(search).toHaveValue("phone calendar filter")
  })

  test("day controls announce the visible number and retain contrast in the built-in light and dark themes", async ({ page }) => {
    const firstDay = page.locator('.cal-cell[data-date$="-01"]')
    const monthStart = new Date(`${await firstDay.getAttribute("data-date")}T12:00:00Z`)
    const month = monthStart.toLocaleDateString("en-US", {
      month: "long", year: "numeric", timeZone: "UTC",
    })
    await expect(firstDay).toHaveAccessibleName(new RegExp(`^1 ${month}`))
    await expect(page.locator(".cal-cell.cal-today")).toHaveAttribute("aria-current", "date")

    for (const theme of ["light", "dark", "knight-rider"]) {
      await page.evaluate(value => localStorage.setItem("meitheal-theme", value), theme)
      await page.reload()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      for (const width of [320, 1440]) {
        await page.setViewportSize({ width, height: 860 })
        const { violations } = await new AxeBuilder({ page })
          .include(".calendar-grid")
          .include(".cal-today-btn")
          .withRules(["color-contrast", "label-content-name-mismatch"])
          .analyze()
        expect(violations.map(({ id, nodes }) => [id, nodes.map(({ target }) => target)]), `${width}px ${theme}`).toEqual([])
      }
    }
  })

  test("day drawer shows only tasks due that day with their shared status labels", async ({ page, request }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

    const cells = page.locator(".cal-cell[data-date]:not(.cal-other)")
    const day = await cells.first().getAttribute("data-date")
    const otherDay = await cells.nth(1).getAttribute("data-date")
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(otherDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // The month summary test reads shared month totals, so this test removes what it creates.
    const createdIds: string[] = []
    const create = async (data: Record<string, unknown>) => {
      const res = await request.post("/api/tasks", { data })
      expect(res.status(), await res.text()).toBe(201)
      createdIds.push((await res.json()).id as string)
    }
    try {
      await create({ title: "Calendar completed task", status: "complete", due_date: day })
      await create({ title: "Calendar active task", status: "active", due_date: day })
      await create({ title: "Calendar task on another day", status: "pending", due_date: otherDay })

      await page.reload()
      await expect(cells.first()).toHaveAccessibleName(/1 task$/)
      await expect(cells.nth(1)).toHaveAccessibleName(/1 task$/)
      await cells.first().press("Enter")

      const drawer = page.locator("#day-drawer-tasks")
      const completeRow = drawer.locator("[data-task-id]").filter({ hasText: "Calendar completed task" })
      await expect(completeRow).toContainText("Done")
      await expect(completeRow.locator(".day-drawer-item-icon use")).toHaveAttribute("href", "#mt-icon-checkbox")
      const activeRow = drawer.locator("[data-task-id]").filter({ hasText: "Calendar active task" })
      await expect(activeRow).toContainText("In Progress")
      await expect(activeRow.locator(".day-drawer-item-icon use")).toHaveAttribute("href", "#mt-icon-bolt")
      await expect(drawer.getByText("Calendar task on another day")).toHaveCount(0)
    } finally {
      for (const id of createdIds) await request.delete(`/api/tasks/${id}`, { data: {} })
    }
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.getByRole("button", { name: "Search Meitheal…" }).click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("day drawer add-task handoff opens the shared task modal", async ({ page }) => {
    await page.locator('.cal-cell[data-date]:not(.cal-other)').first().click()

    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
    await page.locator("#day-drawer-add-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
    const date = await page.locator('.cal-cell[data-date]:not(.cal-other)').first().getAttribute("data-date")
    await expect(page.locator("#nt-contextual-due")).toHaveValue(date ?? "")
    await page.keyboard.press("Escape")
    await expect(page.locator("#new-task-overlay")).toBeHidden()
    await page.locator('.cal-cell[data-date]:not(.cal-other)').first().press("Enter")
    await page.locator("#day-drawer-add-event").click()
    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#nt-event-start")).toHaveValue(new RegExp(`^${date}T`))
  })

  test("view links preserve query string when switching routes", async ({ page }) => {
    await page.goto("/calendar?status=active&priority=1")
    await page.waitForLoadState("networkidle")

    const table = page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Table" })
    await table.click()

    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1&view=table#table$/)
    await expect(table).toHaveAttribute("aria-current", "page")
  })

  test("calendar summary avoids singular/plural grammar mismatches", async ({ page, request }) => {
    // This test creates a task, so it only runs against the disposable fixture.
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

    // The calendar shows the month of the fixture's Europe/Dublin "today", which is not the
    // UTC date around midnight, so create the task on that day.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date())
    const created = await request.post("/api/tasks", { data: { title: "Single calendar summary task", due_date: today } })
    expect(created.status(), await created.text()).toBe(201)
    const taskId = (await created.json()).id as string
    try {
      await page.goto("/calendar")
      await page.waitForLoadState("networkidle")
      const summaryText = await page.locator("#calendar-signal-summary").innerText()
      // The fixture starts empty, so the month holds exactly this one task on one day.
      expect(summaryText).toMatch(/\b1 item across 1 day\b/)
      expect(summaryText).not.toMatch(/\b1 items\b/)
      expect(summaryText).not.toMatch(/\b1 days\b/)
      expect(summaryText).not.toMatch(/\b1 synced events\b/)
    } finally {
      await request.delete(`/api/tasks/${taskId}`, { data: {} })
    }
  })

  test("Calendar filters apply to the month and drawer, survive month navigation, and clear together", async ({ page, request }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const day = "2031-07-08"
    const createdIds: string[] = []
    try {
      for (const [title, priority, status, task_kind] of [
        ["Calendar filter: roof inspection", 1, "active", "standard_action"],
        ["Calendar filter: roof supplies", 2, "pending", "shopping_item"],
        ["Calendar filter: roof checklist", 1, "complete", "checklist"],
      ] as const) {
        const response = await request.post("/api/tasks", { data: {
          title, priority, status, task_kind, due_date: day,
          ...(status === "pending" && { framework_payload: JSON.stringify({ rice: { reach: 10, impact: 5, confidence: 1, effort: 2 } }) }),
        } })
        expect(response.status(), await response.text()).toBe(201)
        createdIds.push((await response.json()).id)
      }

      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
      const filterBar = page.getByRole("toolbar", { name: "Filter tasks" })
      const search = filterBar.getByRole("textbox", { name: "Filter by text" })
      const status = filterBar.getByRole("combobox", { name: "Filter by status" })
      const priority = filterBar.getByRole("combobox", { name: "Filter by priority" })
      const shopping = filterBar.getByRole("button", { name: "Shopping", exact: true })
      const dayCell = page.locator(`.cal-cell[data-date="${day}"]`)
      await expect(dayCell).toHaveAccessibleName(/2 tasks$/)
      await search.fill("roof")
      await page.waitForURL(/search=roof/)
      await expect(dayCell).toHaveAccessibleName(/2 tasks$/)
      await dayCell.press("Enter")
      const agenda = page.locator("#day-drawer-tasks")
      await expect(agenda.getByRole("button", { name: /roof inspection/ })).toBeVisible()
      await expect(agenda.getByRole("button", { name: /roof supplies/ })).toBeVisible()
      await expect(agenda.getByText(/roof checklist/)).toHaveCount(0)
      await page.keyboard.press("Escape")
      await shopping.click()
      await priority.selectOption("1")
      await status.selectOption("active")
      await expect(page).toHaveURL(/status=active/)
      await expect(dayCell).toHaveAccessibleName(/1 task$/)

      await dayCell.press("Enter")
      await expect(agenda.getByRole("button", { name: /roof inspection/ })).toBeVisible()
      await expect(agenda.getByText(/roof supplies|roof checklist/)).toHaveCount(0)
      await page.keyboard.press("Escape")
      await expect(dayCell).toBeFocused()

      await status.selectOption("complete")
      await expect(page).toHaveURL(/status=complete/)
      await expect(dayCell).toHaveAccessibleName(/1 task$/)
      await page.getByRole("link", { name: "Next month" }).click()
      await expect(page.getByRole("heading", { name: "August 2031" })).toBeVisible()
      await expect(search).toHaveValue("roof")
      await expect(status).toHaveValue("complete")
      await expect(shopping).toHaveAttribute("aria-pressed", "false")
      await expect(page.getByText("No tasks match these filters this month.")).toBeVisible()
      await page.getByRole("link", { name: "Previous month" }).click()
      await dayCell.press("Enter")
      await expect(agenda.getByRole("button", { name: /roof checklist/ })).toBeVisible()
      await expect(agenda.getByText(/roof inspection|roof supplies/)).toHaveCount(0)
      await page.keyboard.press("Escape")
      await filterBar.getByRole("button", { name: "Clear all active filters" }).click()
      await expect(search).toBeFocused()
      await expect(dayCell).toHaveAccessibleName(/2 tasks$/)
      await expect(status).toHaveValue("")
      await expect(shopping).toHaveAttribute("aria-pressed", "true")
      await expect(page).not.toHaveURL(/(?:search|status|priority|types)=/)

      const nested = { id: "root", logic: "AND", conditions: [
        { id: "inner", logic: "AND", conditions: [{ id: "rice", field: "rice", operator: "greaterThan", value: 20 }] },
      ] }
      const nestedQuery = new URLSearchParams({ view: "calendar", year: "2031", month: "6", advancedFilter: JSON.stringify(nested) })
      await page.goto(`/tasks?${nestedQuery}#calendar`)
      await expect(dayCell).toHaveAccessibleName(/1 task$/)
      await dayCell.press("Enter")
      await expect(agenda.getByRole("button", { name: /roof supplies/ })).toBeVisible()
      await expect(agenda.getByText(/roof checklist|roof inspection/)).toHaveCount(0)
    } finally {
      for (const id of createdIds) await request.delete(`/api/tasks/${id}`, { data: {} })
    }
  })

  test("Calendar honors legacy Table areas and keeps today's archived work out of the agenda", async ({ page, request }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const day = "2031-07-08"
    const response = await request.post("/api/areas", { data: { name: "Calendar legacy area" } })
    expect(response.status(), await response.text()).toBe(201)
    const { id: areaId } = await response.json()
    const ids: string[] = []
    try {
      for (const draft of [
        { title: "Calendar active in the legacy area", area_id: areaId, status: "active" },
        { title: "Calendar completed in the legacy area", area_id: areaId, status: "complete" },
        { title: "Calendar active outside the legacy area", status: "active" },
      ]) {
        const task = await request.post("/api/tasks", { data: { ...draft, due_date: day } })
        expect(task.status(), await task.text()).toBe(201)
        ids.push((await task.json()).id)
      }

      await page.goto(`/tasks?view=table&area_id=${areaId}&year=2031&month=6#table`)
      await page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Calendar" }).click()
      const cell = page.locator(`.cal-cell[data-date="${day}"]`)
      const agenda = page.locator("#day-drawer-tasks")
      await expect(page.locator("[data-area-label]")).toHaveText("Calendar legacy area")
      await expect(cell).toHaveAccessibleName(/1 task$/)
      await cell.press("Enter")
      await expect(agenda.getByText("Calendar active in the legacy area")).toBeVisible()
      await expect(agenda.getByText("Calendar active outside the legacy area")).toHaveCount(0)

      await page.goto("/today")
      await page.getByRole("button", { name: "Archive completed", exact: true }).click()
      const submitted = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks/clear-completed")
      await page.getByRole("button", { name: "Archive", exact: true }).click()
      const archive = await submitted
      expect(archive.status(), await archive.text()).toBe(200)
      expect(await archive.json()).toMatchObject({ ok: true, cleared: 1 })
      await page.goto("/tasks?view=calendar&year=2031&month=6&area=#calendar")
      await expect(cell).toHaveAccessibleName(/2 tasks$/)
      await cell.press("Enter")
      await expect(agenda.getByText("Calendar active in the legacy area")).toBeVisible()
      await expect(agenda.getByText("Calendar active outside the legacy area")).toBeVisible()
      await expect(agenda.getByText("Calendar completed in the legacy area")).toHaveCount(0)
      const unfilteredApi = await request.get(`/api/tasks?due_date=${day}`)
      expect((await unfilteredApi.json()).tasks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: ids[1], status: "archived" }),
      ]))
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { data: {} })
      await request.delete(`/api/areas/${areaId}`, { data: {} })
    }
  })

  test("Calendar keeps its applied results after a failed filter refresh and offers retry", async ({ page }) => {
    const month = page.locator("[data-calendar-month]")
    const search = page.getByRole("textbox", { name: "Filter by text" })
    let fail = true
    await page.route(url => url.searchParams.has("calendarRefresh"), route => fail
      ? route.fulfill({ status: 503, body: "Calendar service unavailable" })
      : route.continue())

    await search.fill("temporarily unavailable")
    await expect(page.getByText("Couldn’t apply calendar changes. The previous results are still shown.")).toBeVisible()
    await expect(month).toBeVisible()
    await expect(month).not.toHaveAttribute("aria-busy")
    await expect(page).not.toHaveURL(/search=/)

    fail = false
    const backgroundRefresh = page.waitForResponse(response => new URL(response.url()).searchParams.has("calendarRefresh"))
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "created" } })))
    expect((await backgroundRefresh).status()).toBe(200)
    await expect(month).not.toHaveAttribute("aria-busy")
    await expect(page).not.toHaveURL(/search=/)
    await page.getByRole("button", { name: "Retry calendar" }).click()
    await expect(page).toHaveURL(/search=temporarily\+unavailable/)
    await expect(page.getByText("No tasks match these filters this month.")).toBeVisible()
    await expect(page.getByRole("link", { name: "Today", exact: true }).and(page.locator(".cal-today-btn"))).toBeFocused()

    fail = true
    await search.fill("orchard")
    await expect(page.getByRole("button", { name: "Retry calendar" })).toBeVisible()
    fail = false
    await page.getByRole("link", { name: "Next month" }).click()
    await expect(page).toHaveURL(/search=temporarily\+unavailable/)
    await expect(search).toHaveValue("temporarily unavailable")
  })

  test("pending and failed Calendar refreshes retain accepted Area and Events states", async ({ page, request }) => {
    const created = await request.post("/api/areas", { data: { name: "Remembered workshop" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    let release = () => {}
    const hold = new Promise<void>(resolve => { release = resolve })
    let held = false
    let fail = false
    await page.evaluate(areaId => localStorage.setItem("meitheal-selected-area", JSON.stringify({
      areaId, areaName: "Remembered workshop", areaIcon: "folder",
    })), id)
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      const params = new URL(route.request().url()).searchParams
      if (fail) return route.fulfill({ status: 503 })
      if (!held && params.get("area") === id) {
        held = true
        await hold
      }
      return route.continue()
    })
    try {
      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
      await expect.poll(() => held).toBe(true)
      const trigger = page.locator("#area-selector-trigger")
      await expect(trigger).toContainText("All Areas")
      await page.getByRole("combobox", { name: "Filter by priority" }).selectOption("3")
      await expect(page).toHaveURL(url => url.searchParams.get("area") === id && url.searchParams.get("priority") === "3")
      await expect(trigger).toContainText("Remembered workshop")
      release()

      fail = true
      await trigger.click()
      await page.locator('#area-selector-dropdown [data-area-id=""]').click()
      const retry = page.getByRole("button", { name: "Retry calendar" })
      await expect(retry).toBeVisible()
      await expect(trigger).toContainText("Remembered workshop")
      await expect(page.locator(`#area-selector-dropdown [data-area-id="${id}"]`)).toHaveAttribute("aria-selected", "true")
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meitheal-selected-area") ?? "{}").areaId)).toBe(id)

      const events = page.getByRole("toolbar", { name: "Filter tasks" }).getByRole("button", { name: "Events", exact: true })
      await events.click()
      await expect(retry).toBeVisible()
      await expect(events).toHaveAttribute("aria-pressed", "true")
      await expect(page).toHaveURL(url => url.searchParams.get("area") === id && !url.searchParams.has("types"))

      fail = false
      await retry.click()
      await expect(events).toHaveAttribute("aria-pressed", "false")
      await expect(page).toHaveURL(url => url.searchParams.get("area") === id && url.searchParams.has("types"))

      fail = true
      await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({ json: { entities: ["calendar.household"] } }))
      await page.route("**/api/ha/events?*", route => route.fulfill({ json: { events: [
        { summary: "Available despite Area failure", start: "2031-07-08", end: "2031-07-09" },
      ] } }))
      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
      await expect(retry).toBeVisible()
      await expect(trigger).toContainText("All Areas")
      await expect(page.locator('.cal-cell[data-date="2031-07-08"] .cal-inline-ha')).toContainText("Available despite Area failure")
    } finally {
      release()
      await request.delete(`/api/areas/${id}`)
    }
  })

  test("Calendar keeps the previous Area when a filter change exceeds its URL limit", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const created = await request.post("/api/areas", { headers, data: { name: "Extra calendar area" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      const labels = Array.from({ length: 27 }, (_, index) => String(index).padStart(2, "0") + "x".repeat(497))
      const params = new URLSearchParams({ view: "calendar", area: "", search: "search-with-room-to-shorten-".repeat(4) })
      params.set("labels", [...labels, ""].join(","))
      const lastLabelLength = 13_990 - ("/tasks?".length + params.toString().length)
      params.set("labels", [...labels, "y".repeat(lastLabelLength)].join(","))
      const route = "/tasks?" + params + "#calendar"
      await page.goto(route)
      const trigger = page.locator("#area-selector-trigger")
      const all = page.locator('#area-selector-dropdown [data-area-id=""]')
      await expect(trigger).toContainText("All Areas")
      await trigger.click()
      await page.locator(`#area-selector-dropdown [data-area-id="${id}"]`).click()
      await expect(page.locator("[data-calendar-status]")).toContainText("The previous results are still shown.")
      await expect(page).toHaveURL(url => url.searchParams.get("area") === "")
      await expect(trigger).toContainText("All Areas")
      await expect(all).toHaveAttribute("aria-selected", "true")
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meitheal-selected-area") ?? "{}").areaId)).toBe("")

      const filters = page.getByRole("toolbar", { name: "Filter tasks" })
      const eventType = filters.getByRole("button", { name: "Events", exact: true })
      const priority = filters.getByRole("combobox", { name: "Filter by priority" })
      await eventType.click()
      await expect(eventType).toHaveAttribute("aria-pressed", "true")
      await priority.selectOption("3")
      await expect(priority).toHaveValue("")
      await expect(page).toHaveURL(route)

      await filters.getByRole("textbox", { name: "Filter by text" }).fill("")
      await expect(page).toHaveURL(url => !url.searchParams.has("search") && url.searchParams.get("area") === "")
      await expect(trigger).toContainText("All Areas")
      await expect(all).toHaveAttribute("aria-selected", "true")

      await page.evaluate(areaId => localStorage.setItem("meitheal-selected-area", JSON.stringify({
        areaId, areaName: "Extra calendar area", areaIcon: "folder",
      })), id)
      params.delete("area")
      await page.goto("/tasks?" + params + "#calendar")
      await expect(page.locator("[data-calendar-status]")).toContainText("The previous results are still shown.")
      await expect(trigger).toContainText("All Areas")
      await expect(all).toHaveAttribute("aria-selected", "true")
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meitheal-selected-area") ?? "{}").areaId)).toBe(id)
    } finally {
      await request.delete(`/api/areas/${id}`, { headers })
    }
  })

  test("month navigation retains a filter while the calendar is still loading", async ({ page }) => {
    let releaseRequest = () => {}
    const pending = new Promise<void>(resolve => { releaseRequest = resolve })
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      await pending
      await route.abort().catch(() => {})
    })
    try {
      await page.getByRole("textbox", { name: "Filter by text" }).fill("roof")
      await expect(page.getByText("Loading calendar…")).toBeVisible()
      await page.getByRole("link", { name: "Next month" }).click()
      await expect(page).toHaveURL(/[?&]search=roof(?:&|#)/)
      await expect(page.getByRole("textbox", { name: "Filter by text" })).toHaveValue("roof")
    } finally {
      releaseRequest()
    }
  })

  test("Events toggles connected calendar previews and agenda without clearing task filters", async ({ page }) => {
    const day = "2031-07-08"
    await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({ json: { entities: ["calendar.household"] } }))
    await page.route("**/api/ha/events?*", route => route.fulfill({
      json: { events: [{ summary: "Household calendar preview", start: day, end: "2031-07-09" }] },
    }))
    await page.goto("/tasks?view=calendar&year=2031&month=6&search=roof#calendar")
    const during = page.locator(`.cal-cell[data-date="${day}"]`)
    const types = page.getByRole("toolbar", { name: "Filter tasks" })

    await expect(during.getByText("Household calendar preview")).toBeVisible()
    await during.press("Enter")
    await expect(page.getByRole("heading", { name: "Connected Calendar Events" })).toBeVisible()
    await expect(page.locator("#day-drawer-events")).toContainText("Household calendar preview")
    await page.keyboard.press("Escape")
    await types.getByRole("button", { name: "Events", exact: true }).click()
    await expect(during.getByText("Household calendar preview")).toHaveCount(0)
    await expect(types.getByRole("textbox", { name: "Filter by text" })).toHaveValue("roof")
    await during.press("Enter")
    await expect(page.getByRole("heading", { name: "Connected Calendar Events" })).toHaveCount(0)
    await expect(page.locator("#day-drawer-tasks")).toContainText("No tasks or events scheduled")

    await page.keyboard.press("Escape")
    await page.goto("/tasks?view=calendar&year=2031&month=6&types=calendar_event#calendar")
    await expect(during.getByText("Household calendar preview")).toBeVisible()
    const events = types.getByRole("button", { name: "Events", exact: true })
    await events.click()
    await expect(events).toHaveAttribute("aria-pressed", "false")
    await expect(during.getByText("Household calendar preview")).toHaveCount(0)
  })

  test("month and day feed timeouts preserve available events and report a fully unavailable day", async ({ page }) => {
    test.slow()
    const day = "2031-07-08"
    let allFail = false
    const waiting = new Set<() => void>()
    await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({
      json: { entities: ["calendar.household", "calendar.garden"] },
    }))
    // An intercepted response never reaches fetch. Wait for the real AbortSignal deadline.
    await page.route("**/api/ha/events?*", async route => {
      const params = new URL(route.request().url()).searchParams
      if (params.get("entity_id") === "calendar.garden" || (allFail && params.get("start") === "2031-07-07T00:00:00Z")) {
        await new Promise<void>(resolve => waiting.add(resolve))
        await route.abort().catch(() => {})
        return
      }
      await route.fulfill({ json: { events: [{ summary: "Household feed result", start: day, end: "2031-07-09" }] } })
    })
    try {
      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
      const cell = page.locator(`.cal-cell[data-date="${day}"]`)
      const events = page.locator("#day-drawer-events")
      await cell.press("Enter")
      await expect(events).toContainText("Some connected calendar events couldn’t load.", { timeout: 15_000 })
      await expect(events).toContainText("Household feed result")
      await expect(cell.getByText("Household feed result")).toBeVisible()
      await page.keyboard.press("Escape")
      allFail = true
      await cell.press("Enter")
      await expect(events).toHaveText("Connected calendar events couldn’t load.", { timeout: 15_000 })
    } finally {
      for (const resolve of waiting) resolve()
    }
  })

  test("Calendar includes the whole household day when the live Core calendar uses UTC", async ({ page, request }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const { timezone: previousTimezone } = await (await request.get("/api/settings")).json()
    const day = "2031-07-08"
    const events = [
      { summary: "UTC event on preceding household day", start: "2031-07-08T06:00:00Z", end: "2031-07-08T06:30:00Z" },
      { summary: "Household all-day event", start: day, end: "2031-07-09" },
      { summary: "Next UTC date on selected household day", start: "2031-07-09T01:00:00Z", end: "2031-07-09T02:00:00Z" },
      { summary: "UTC event on following household day", start: "2031-07-09T07:00:00Z", end: "2031-07-09T08:00:00Z" },
    ]
    const bounds: string[] = []
    await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({
      json: { entities: ["calendar.household"] },
    }))
    await page.route("**/api/ha/events?*", route => {
      const params = new URL(route.request().url()).searchParams
      const start = params.get("start") ?? ""
      const end = params.get("end") ?? ""
      bounds.push(`${start}/${end}`)
      // A Core calendar set to UTC can only return events that overlap the provider query.
      return route.fulfill({ json: { events: events.filter(event =>
        Date.parse(event.start) < Date.parse(end) && Date.parse(event.end) > Date.parse(start)) } })
    })
    try {
      const configured = await request.put("/api/settings", { data: { key: "timezone", value: "America/Los_Angeles" } })
      expect(configured.status()).toBe(200)
      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
      await expect(page.locator("#calendar-shell")).toHaveAttribute("data-timezone", "America/Los_Angeles")
      const selected = page.locator(`.cal-cell[data-date="${day}"]`)
      const following = page.locator('.cal-cell[data-date="2031-07-09"]')
      const connected = page.locator("#day-drawer-events")
      await expect(selected.getByText("Next UTC date on selected household day")).toBeVisible()
      await expect(selected.getByText("Household all-day event")).toBeVisible()
      await expect(selected.getByText("UTC event on preceding household day")).toHaveCount(0)
      await selected.press("Enter")
      await expect(connected.getByText("Next UTC date on selected household day")).toBeVisible()
      await expect(connected.getByText("Household all-day event")).toBeVisible()
      await expect(connected.getByText("UTC event on preceding household day")).toHaveCount(0)
      await expect(connected.getByText("UTC event on following household day")).toHaveCount(0)
      await page.keyboard.press("Escape")
      await following.press("Enter")
      await expect(connected.getByText("UTC event on following household day")).toBeVisible()
      await expect(connected.getByText("Household all-day event")).toHaveCount(0)
      await expect(connected.getByText("Next UTC date on selected household day")).toHaveCount(0)
      expect(bounds).toEqual(expect.arrayContaining([
        "2031-06-30T00:00:00Z/2031-08-02T00:00:00Z",
        "2031-07-07T00:00:00Z/2031-07-10T00:00:00Z",
        "2031-07-08T00:00:00Z/2031-07-11T00:00:00Z",
      ]))

      const timezoneChange = await request.put("/api/settings", { data: { key: "timezone", value: "UTC" } })
      expect(timezoneChange.status()).toBe(200)
      await page.keyboard.press("Escape")
      await page.getByRole("textbox", { name: "Filter by text" }).fill("yard")
      await expect(page.locator("#calendar-shell")).toHaveAttribute("data-timezone", "UTC")
      await expect(following.getByText("Next UTC date on selected household day")).toBeVisible()
      await following.press("Enter")
      await expect(connected.getByText("Next UTC date on selected household day")).toBeVisible()
    } finally {
      await request.put("/api/settings", { data: { key: "timezone", value: previousTimezone ?? "Europe/Dublin" } })
    }
  })

  test("a pending filter refresh preserves focus in and out of the day drawer", async ({ page }) => {
    const day = "2031-07-08"
    await page.route("**/api/calendar/agenda", route => route.fulfill({ json: {
      total: 1,
      tasks: [{ id: "agenda-focus", title: "Agenda focus item", status: "active" }],
    } }))
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      await pending
      await route.continue()
    })
    try {
      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
      await page.getByRole("combobox", { name: "Filter by priority" }).selectOption("3")
      await expect(page.getByText("Loading calendar…")).toBeVisible()
      const cell = page.locator(`.cal-cell[data-date="${day}"]`)
      await cell.press("Enter")
      const task = page.getByRole("button", { name: /Agenda focus item/ })
      await task.focus()
      release()
      await expect(page).toHaveURL(url => url.searchParams.get("priority") === "3")
      await expect(task).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(cell).toBeFocused()
    } finally {
      release()
    }
  })

  test("large day agenda loads another page with the same filters and restores keyboard focus", async ({ page }) => {
    const day = "2031-07-08"
    const filtersByPage: Array<string | null> = []
    await page.route("**/api/calendar/agenda", route => {
      const { date, offset, limit, filters } = route.request().postDataJSON()
      expect(date).toBe(day)
      filtersByPage.push(new URLSearchParams(filters).get("search"))
      return route.fulfill({ json: {
        total: 101,
        tasks: Array.from({ length: Math.min(limit, 101 - offset) }, (_, index) => ({
          id: String(offset + index + 1), status: "active", title: `Fitted roof task ${offset + index + 1}`,
        })),
      } })
    })
    await page.goto("/tasks?view=calendar&year=2031&month=6&search=roof#calendar")
    await page.locator(`.cal-cell[data-date="${day}"]`).press("Enter")
    const drawer = page.locator("#day-drawer-tasks")
    await expect(drawer.getByRole("button")).toHaveCount(100)
    await page.getByRole("button", { name: "Load more tasks (1 remaining)" }).press("Enter")
    await expect(drawer.getByRole("button")).toHaveCount(101)
    await expect(drawer.getByRole("button", { name: /Fitted roof task 101/ })).toBeFocused()
    expect(filtersByPage).toEqual(["roof", "roof"])
  })

  test("calendar task counts bucket timed UTC due dates in household timezone", async ({ page, request }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

    const beforeSettings = await (await request.get("/api/settings")).json()
    const prevTz = typeof beforeSettings.timezone === "string" ? beforeSettings.timezone : "Europe/Dublin"
    let taskId: string | undefined
    try {
      expect((await request.put("/api/settings", {
        data: { key: "timezone", value: "America/Los_Angeles" },
      })).status()).toBe(200)

      const created = await request.post("/api/tasks", {
        data: { title: "LA Evening Timed Task", status: "pending", due_date: "2027-06-16T02:00:00Z" },
      })
      expect(created.status(), await created.text()).toBe(201)
      taskId = (await created.json()).id

      await page.goto("/tasks?view=calendar&year=2027&month=5#calendar")
      await page.waitForLoadState("networkidle")

      await expect(page.locator('.cal-cell[data-date="2027-06-15"]')).toHaveAccessibleName(/1 task$/)
      await expect(page.locator('.cal-cell[data-date="2027-06-16"]')).not.toHaveAccessibleName(/\btasks?$/)

      await page.locator('.cal-cell[data-date="2027-06-15"]').click()
      await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
      await expect(page.locator("#day-drawer-tasks")).toContainText("LA Evening Timed Task")
      await page.locator("#day-drawer-close").click()
      await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "true")

      await page.locator('.cal-cell[data-date="2027-06-16"]').click()
      await expect(page.locator("#day-drawer-tasks")).toContainText("No tasks or events scheduled")
      await expect(page.locator("#day-drawer-tasks").getByText("LA Evening Timed Task")).toHaveCount(0)
    } finally {
      await request.put("/api/settings", { data: { key: "timezone", value: prevTz } })
      if (taskId) {
        await request.delete(`/api/tasks/${taskId}`, { data: {} })
      }
    }
  })
})
