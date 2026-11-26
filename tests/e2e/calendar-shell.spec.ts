import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Calendar Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test.beforeEach(async ({ page }) => {
    await page.goto("/calendar")
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-calendar-ready", "true")
  })

  test("legacy route opens Calendar and a keyboard user can inspect a day", async ({ page }) => {
    await expect(page).toHaveURL(/\/tasks\?view=calendar#calendar$/)
    await expect(page.getByRole("region", { name: /[A-Za-z]+ \d{4}/ })).toBeVisible()
    const views = page.getByRole("navigation", { name: "Task views" })
    await expect(views.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page")

    const day = page.locator('.cal-cell[data-date]:not(.cal-other)').first()
    const drawer = page.locator("#day-drawer")
    const close = drawer.getByRole("button", { name: "Close", exact: true })
    for (const pointer of [false, true]) {
      if (pointer) await day.click()
      else await day.press("Enter")
      await expect(drawer).toHaveAttribute("aria-hidden", "false")
      await expect(close).toBeFocused()
      const target = await close.boundingBox()
      expect(target?.width).toBeGreaterThanOrEqual(44)
      expect(target?.height).toBeGreaterThanOrEqual(43.99)
      if (pointer) {
        const heading = drawer.locator("#day-drawer-title")
        await heading.click()
        await expect(page.locator("body")).toBeFocused()
        await page.keyboard.press("Tab")
        await expect(close).toBeFocused()
        await heading.click()
        await expect(page.locator("body")).toBeFocused()
      }
      await page.keyboard.press("Escape")
      await expect(drawer).toHaveAttribute("aria-hidden", "true")
      await expect(day).toBeFocused()
    }
  })

  test("Calendar renders supported years with fewer than four digits", async ({ page }) => {
    const response = await page.goto("/tasks?view=calendar&year=999&month=0#calendar")
    expect(response?.status()).toBe(200)
    const first = page.locator('.cal-cell[data-date="0999-01-01"]')
    await expect(first).toHaveAccessibleName(/1 January 999/)
    await first.press("Enter")
    await expect(page.locator("#day-drawer-close")).toBeFocused()

    const session = await page.context().newCDPSession(page)
    await session.send("Emulation.setTimezoneOverride", { timezoneId: "Pacific/Apia" })
    await page.goto("/tasks?view=calendar&year=2011&month=11#calendar")
    await page.locator('.cal-cell[data-date="2011-12-30"]').press("Enter")
    await expect(page.locator("#day-drawer-title")).toHaveText("Friday, December 30")
  })

  test("opening a day retries focus when Close is initially disabled", async ({ page }) => {
    const day = page.locator('.cal-cell[data-date]:not(.cal-other)').first()
    const drawer = page.locator("#day-drawer")
    const close = page.locator("#day-drawer-close")
    await day.evaluate(day => {
      const drawer = document.querySelector<HTMLElement>("#day-drawer")!
      const close = document.querySelector<HTMLButtonElement>("#day-drawer-close")!
      close.disabled = true
      const observer = new MutationObserver(() => {
        observer.disconnect()
        drawer.dataset.openedFromGrid = String(close.disabled && document.activeElement === day)
        requestAnimationFrame(() => { close.disabled = false })
      })
      observer.observe(drawer, { attributeFilter: ["aria-hidden"] })
    })
    await day.press("Enter")
    await expect(drawer).toHaveAttribute("aria-hidden", "false")
    await expect(drawer).toHaveAttribute("data-opened-from-grid", "true")
    await expect(close).toBeFocused()
    await day.focus()
    await page.keyboard.press("Tab")
    await expect(close).toBeFocused()
    await day.focus()
    await page.keyboard.press("Escape")
    await expect(drawer).toHaveAttribute("aria-hidden", "true")
    await expect(day).toBeFocused()
  })

  test("phone filters stay compact, accessible and marked when active", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 780 })
    const touch = await page.context().newCDPSession(page)
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
    await page.goto("/tasks?view=calendar&calView=month&year=2031&month=6#calendar")
    await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
    const days = page.locator(".calendar-grid .cal-cell")
    await days.nth(7).evaluate(cell => cell.scrollIntoView({ block: "center" }))
    await expect.poll(() => days.evaluateAll(cells => cells.slice(7, 14).map(cell => {
      const rect = cell.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      return rect.width >= 43.99 && [rect.left + 1, rect.right - 1].every(x =>
        cell.contains(document.elementFromPoint(x, y)),
      )
    }))).toEqual(Array(7).fill(true))
    await page.evaluate(() => window.scrollTo(0, 0))
    const navigation = page.locator(".calendar-navigation")
    const disclosure = navigation.getByRole("button", { name: "Filters", exact: true })
    const toolbar = page.locator("#calendar-filter-bar")
    await expect(disclosure).toHaveAttribute("aria-expanded", "false")
    await expect(toolbar).toBeHidden()
    await expect(page.getByRole("button", { name: "July 2031", exact: true })).toBeInViewport()
    await expect(disclosure).toHaveCSS("min-height", "44px")
    expect((await disclosure.boundingBox())?.height).toBeGreaterThanOrEqual(43.99)

    await disclosure.press("Enter")
    await expect(toolbar).toBeVisible()
    const search = toolbar.getByRole("textbox", { name: "Filter by text" })
    await expect(search).toBeFocused()
    await search.fill("phone calendar filter")
    await expect(page).toHaveURL(/search=phone\+calendar\+filter/)
    await page.keyboard.press("Escape")
    const active = navigation.getByRole("button", { name: "Filters Active", exact: true })
    await expect(active).toBeFocused()
    await expect(active).toHaveAttribute("aria-expanded", "false")
    await expect(toolbar).toBeHidden()

    await page.setViewportSize({ width: 1100, height: 780 })
    await expect(active).toBeHidden()
    await expect(toolbar).toBeVisible()
    await expect(search).toHaveValue("phone calendar filter")

    await page.setViewportSize({ width: 320, height: 780 })
    await active.click()
    await toolbar.getByRole("button", { name: "Toggle filter builder" }).click()
    const builder = toolbar.getByRole("region", { name: "Custom Filter Builder" })
    const addCondition = builder.getByRole("button", { name: "Condition", exact: true })
    await addCondition.click()
    await addCondition.click()
    const conditions = builder.getByRole("group", { name: "Filter condition" })
    await expect(conditions).toHaveCount(2)
    await expect(conditions.first().getByRole("combobox", { name: "Field", exact: true })).toBeVisible()
    await expect(conditions.last().getByRole("combobox", { name: "Operator", exact: true })).toBeVisible()
    expect(await conditions.last().locator("button, select, input").evaluateAll(controls => controls.every(control => {
      const rect = control.getBoundingClientRect()
      return rect.width >= 43.99 && rect.height >= 43.99 && rect.right <= innerWidth + 1
    }))).toBe(true)
    await conditions.last().getByRole("button", { name: "Remove condition" }).press("Enter")
    await expect(conditions).toHaveCount(1)
    await expect(conditions.first().getByRole("combobox", { name: "Field", exact: true })).toBeFocused()
    await conditions.first().getByRole("textbox", { name: "Value", exact: true }).fill("accessible mobile rules")
    await builder.getByRole("button", { name: "Apply Rules" }).click()
    await expect(page).toHaveURL(url => decodeURIComponent(url.searchParams.get("advancedFilter") ?? "").includes("accessible mobile rules"))
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

  test("Calendar label chips retain contrast on hover across theme modes", async ({ page }) => {
    test.slow()
    await page.setViewportSize({ width: 1440, height: 860 })
    await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" })
    await page.route("**/api/labels", route => route.fulfill({
      json: { labels: [{ title: "Review" }, { title: "Household" }] },
    }))
    await page.addInitScript(() => {
      const theme = new URLSearchParams(location.search).get("probeTheme")
      if (!theme) return
      localStorage.setItem("meitheal-theme", theme)
      if (theme === "custom") localStorage.setItem("meitheal-custom-theme-css", ":root { --bg-hover: #252526; }")
    })
    for (const theme of ["light", "dark", "knight-rider", "auto", "custom"]) {
      await page.goto(`/tasks?view=calendar&label=Review&probeTheme=${theme}#calendar`)
      const appliedTheme = theme === "custom" ? "dark" : theme === "auto" ? "knight-rider" : theme
      await expect(page.locator("html")).toHaveAttribute("data-theme", appliedTheme)
      const panel = page.locator("#calendar-filter-bar .label-filter-panel")
      await panel.locator("summary").click()
      const selected = panel.getByRole("button", { name: "Review", exact: true })
      const ordinary = panel.getByRole("button", { name: "Household", exact: true })
      await expect(selected).toHaveAttribute("aria-pressed", "true")
      await expect(ordinary).toHaveAttribute("aria-pressed", "false")
      for (const chip of [selected, ordinary]) {
        await chip.hover()
        const { violations, passes } = await new AxeBuilder({ page })
          .include("#calendar-filter-bar .label-filter__chip")
          .withRules(["color-contrast"])
          .analyze()
        expect(violations, theme).toEqual([])
        expect(passes.find(({ id }) => id === "color-contrast")?.nodes, theme).toHaveLength(3)
      }
    }
  })

  test("day drawer shows only tasks due that day with their shared status labels", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })

    const cells = page.locator(".cal-cell[data-date]:not(.cal-other)")
    const day = await cells.first().getAttribute("data-date")
    const otherDay = await cells.nth(1).getAttribute("data-date")
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(otherDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    // The month summary test reads shared month totals, so this test removes what it creates.
    const createdIds: string[] = []
    const create = async (data: Record<string, unknown>) => {
      const res = await request.post("/api/tasks", { headers, data })
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
      await expect(activeRow).toHaveAccessibleName(/Calendar active task In Progress/)
      const heading = await activeRow.locator(".day-drawer-item-title").boundingBox()
      const caption = await activeRow.locator(".day-drawer-item-meta").boundingBox()
      expect(caption!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height)
      await expect(activeRow.locator(".day-drawer-item-icon use")).toHaveAttribute("href", "#mt-icon-bolt")
      await expect(drawer.getByText("Calendar task on another day")).toHaveCount(0)
    } finally {
      for (const id of createdIds) await request.delete(`/api/tasks/${id}`, { headers, data: {} })
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

  test("editing a Calendar Event back to midnight saves a timed start", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    let id: string | undefined
    try {
      const session = await page.context().newCDPSession(page)
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Dublin" })
      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
      const cell = page.locator('.cal-cell[data-date]:not(.cal-other)').first()
      const date = await cell.getAttribute("data-date")
      await cell.press("Enter")
      await page.locator("#day-drawer-add-event").click()
      const start = page.locator("#nt-event-start")
      const end = page.locator("#nt-event-end")
      await expect(start).toHaveValue(`${date}T00:00`)
      await start.fill(`${date}T00:01`)
      await start.fill(`${date}T00:00`)
      await end.fill(`${date}T01:00`)
      const expectedStart = await start.evaluate((control: HTMLInputElement) => new Date(control.value).toISOString())
      const expectedEnd = await end.evaluate((control: HTMLInputElement) => new Date(control.value).toISOString())
      await page.locator("#new-task-title-input").fill("Calendar timed midnight start")
      const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks" &&
        response.request().method() === "POST")
      await page.locator("#submit-new-task-btn").click()
      const response = await created
      expect(response.status()).toBe(201)
      const task = await response.json()
      id = task.id
      expect(task).toMatchObject({ task_kind: "calendar_event", start_date: expectedStart, end_date: expectedEnd })
    } finally {
      if (id) await request.delete(`/api/tasks/${id}`, { headers, data: {} })
    }
  })

  test("view links preserve query string when switching routes", async ({ page }) => {
    await page.goto("/calendar?status=active&priority=1")
    await page.waitForLoadState("networkidle")

    const table = page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Table" })
    await page.getByRole("toolbar", { name: "Filter tasks" }).getByRole("textbox", { name: "Filter by text" }).fill("heating")
    await expect(page).toHaveURL(url => url.searchParams.get("search") === "heating")
    await expect.poll(() => table.evaluate(link => new URL((link as HTMLAnchorElement).href).searchParams.get("search"))).toBe("heating")
    await table.click()

    await expect(page).toHaveURL(url =>
      url.pathname === "/tasks" && url.hash === "#table" && url.searchParams.get("search") === "heating" &&
      url.searchParams.get("status") === "active" && url.searchParams.get("priority") === "1",
    )
    await expect(table).toHaveAttribute("aria-current", "page")
  })

  test("calendar summary avoids singular/plural grammar mismatches", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    // This test creates a task, so it only runs against the disposable fixture.
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

    // The calendar shows the month of the fixture's Europe/Dublin "today", which is not the
    // UTC date around midnight, so create the task on that day.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date())
    const created = await request.post("/api/tasks", { headers, data: { title: "Single calendar summary task", due_date: today } })
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
      await request.delete(`/api/tasks/${taskId}`, { headers, data: {} })
    }
  })

  test("Calendar filters apply to the month and drawer, survive month navigation, and clear together", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const day = "2031-07-08"
    const createdIds: string[] = []
    try {
      for (const [title, priority, status, task_kind] of [
        ["Calendar filter: roof inspection", 1, "active", "standard_action"],
        ["Calendar filter: roof supplies", 2, "pending", "shopping_item"],
        ["Calendar filter: roof checklist", 1, "complete", "checklist"],
      ] as const) {
        const response = await request.post("/api/tasks", { headers, data: {
          title, priority, status, task_kind, due_date: day,
          ...(status === "pending" && { framework_payload: { rice: { reach: 10, impact: 5, confidence: 100, effort: 2 } } }),
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

      await page.goto("/tasks?view=calendar&year=2031&month=6&status=pending&search=roof#calendar")
      await expect(page.locator("#calendar-shell")).toHaveAttribute("data-calendar-ready", "true")
      await expect(dayCell).toHaveAccessibleName(/1 task$/)
      await dayCell.press("Enter")
      await agenda.getByRole("button", { name: /roof supplies/ }).click()
      const detailStatus = page.locator("#td-status")
      await expect(detailStatus).toBeEnabled()
      await detailStatus.selectOption("complete")
      await expect(dayCell).toHaveAccessibleName("8 July 2031")
      await page.getByRole("button", { name: "Close detail" }).click()
      await expect(dayCell).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(agenda).toContainText("No matching tasks or local events")
    } finally {
      for (const id of createdIds) await request.delete(`/api/tasks/${id}`, { headers, data: {} })
    }
  })

  test("Calendar honors legacy Table areas and keeps today's archived work out of the agenda", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const day = "2031-07-08"
    const response = await request.post("/api/areas", { headers, data: { name: "Calendar legacy area" } })
    expect(response.status(), await response.text()).toBe(201)
    const { id: areaId } = await response.json()
    const ids: string[] = []
    try {
      for (const draft of [
        { title: "Calendar active in the legacy area", area_id: areaId, status: "active" },
        { title: "Calendar completed in the legacy area", area_id: areaId, status: "complete" },
        { title: "Calendar active outside the legacy area", status: "active" },
      ]) {
        const task = await request.post("/api/tasks", { headers, data: { ...draft, due_date: day } })
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

      const allTypes = "standard_action,shopping_item,checklist,routine_instance,calendar_event,quick_capture"
      await page.goto(`/tasks?view=calendar&year=2031&month=6&area=&types=${allTypes}#calendar`)
      await expect(page.locator('#calendar-filter-bar [data-type][aria-pressed="true"]')).toHaveCount(6)
      await expect(page.getByRole("button", { name: "Clear All", exact: true })).toBeHidden()
      await cell.press("Enter")
      await expect(agenda.getByText("Calendar completed in the legacy area")).toBeVisible()

      await page.goto("/today")
      await page.getByRole("button", { name: "Archive completed", exact: true }).click()
      const submitted = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks/clear-completed")
      await page.getByRole("button", { name: "Archive", exact: true }).click()
      const archive = await submitted
      expect(archive.status()).toBe(200)
      await page.goto("/tasks?view=calendar&year=2031&month=6&area=#calendar")
      await expect(cell).toHaveAccessibleName(/2 tasks$/)
      await cell.press("Enter")
      await expect(agenda.getByText("Calendar active in the legacy area")).toBeVisible()
      await expect(agenda.getByText("Calendar active outside the legacy area")).toBeVisible()
      await expect(agenda.getByText("Calendar completed in the legacy area")).toHaveCount(0)
      const unfilteredApi = await request.get(`/api/tasks?due_date=${day}`)
      expect((await unfilteredApi.json()).tasks.filter((task: { status: string }) => task.status === "archived"))
        .toEqual([expect.objectContaining({ id: ids[1], status: "archived" })])
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers, data: {} })
      await request.delete(`/api/areas/${areaId}`, { headers, data: {} })
    }
  })
})
