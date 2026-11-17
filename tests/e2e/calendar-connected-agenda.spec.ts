import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Connected Calendar and paged agenda", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test.beforeEach(async ({ page }) => {
    await page.goto("/calendar")
    await page.waitForLoadState("networkidle")
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
    const event = page.locator("#day-drawer-events .day-drawer-item")
    const heading = await event.locator(".day-drawer-item-title").boundingBox()
    const caption = await event.locator(".day-drawer-item-meta").boundingBox()
    expect(caption!.y).toBeGreaterThanOrEqual(heading!.y + heading!.height)
    await page.keyboard.press("Escape")
    await types.getByRole("button", { name: "Events", exact: true }).click()
    await expect(during.getByText("Household calendar preview")).toHaveCount(0)
    await expect(types.getByRole("textbox", { name: "Filter by text" })).toHaveValue("roof")
    await during.press("Enter")
    await expect(page.getByRole("heading", { name: "Connected Calendar Events" })).toHaveCount(0)
    await expect(page.getByRole("heading", { name: "Scheduled items", exact: true })).toBeVisible()
    await expect(page.locator("#day-drawer-tasks")).toContainText("No matching tasks or local events")

    await page.keyboard.press("Escape")
    await page.goto("/tasks?view=calendar&year=2031&month=6&types=calendar_event#calendar")
    await expect(during.getByText("Household calendar preview")).toBeVisible()
    const events = types.getByRole("button", { name: "Events", exact: true })
    await expect(events).toHaveCSS("box-shadow", /1px inset$/)
    await events.click()
    await expect(events).toHaveAttribute("aria-pressed", "false")
    await page.mouse.move(0, 0)
    await expect(events).toHaveCSS("opacity", "1")
    await expect(events).toHaveCSS("box-shadow", "none")
    await expect(during.getByText("Household calendar preview")).toHaveCount(0)
  })

  test("open Calendar reads current connected sources when the day or filters change", async ({ page }) => {
    const day = "2031-07-08"
    let configured = ["calendar.household"]
    await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({ json: { entities: configured } }))
    await page.route("**/api/ha/events?*", route => route.fulfill({
      json: { events: [{ summary: "Household calendar preview", start: day, end: "2031-07-09" }] },
    }))
    await page.route("**/api/calendar/agenda", route => route.fulfill({ json: { tasks: [], total: 0, linkedEvents: [] } }))
    await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
    const cell = page.locator(`.cal-cell[data-date="${day}"]`)
    const events = page.locator("#day-drawer-events")
    await expect(cell.getByText("Household calendar preview")).toBeVisible()

    configured = []
    await cell.press("Enter")
    await expect(events).toContainText("No calendar events")
    await page.keyboard.press("Escape")

    const search = page.getByRole("toolbar", { name: "Filter tasks" }).getByRole("textbox", { name: "Filter by text" })
    await search.fill("updated")
    await expect(page).toHaveURL(/search=updated/)
    await expect(cell.getByText("Household calendar preview")).toHaveCount(0)

    configured = ["calendar.household"]
    await search.fill("updated again")
    await expect(page).toHaveURL(/search=updated\+again/)
    await expect(cell.getByText("Household calendar preview")).toBeVisible()
  })

  test("Calendar orders live and saved entries across offsets before clipping previews", async ({ page }) => {
    const day = "2031-01-08"
    await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({ json: { entities: ["calendar.household"] } }))
    await page.route("**/api/ha/events?*", route => route.fulfill({ json: { events: [
      { summary: "Late live event", start: day + "T09:00:00-06:00" },
      { summary: "Middle live event", start: day + "T12:00:00Z" },
      { summary: "Early live event", start: day + "T10:00:00Z" },
    ] } }))
    await page.route("**/api/calendar/agenda", route => route.fulfill({ json: { tasks: [], total: 0, linkedEvents: [
      { id: "floating", title: "Saved floating event", start: day + "T11:00:00", entity: null, uid: null, providerSummary: null },
      { id: "all-day", title: "Saved all-day event", start: day, entity: null, uid: null, providerSummary: null },
    ] } }))
    await page.goto("/tasks?view=calendar&year=2031&month=0#calendar")
    const cell = page.locator(`.cal-cell[data-date="${day}"]`)
    await expect(cell.locator(".cal-inline-ha")).toHaveText(["10:00 Early live event", "12:00 Middle live event"])
    await expect(cell.locator(".cal-inline-more")).toHaveText("+1 more")
    await cell.press("Enter")
    const connected = page.locator("#day-drawer-events")
    await expect(connected.locator(".day-drawer-item-title")).toHaveText([
      "Saved all-day event", "Early live event", "Saved floating event", "Middle live event", "Late live event",
    ])
    await expect(connected.locator(".day-drawer-item-meta")).toHaveText(["All day", "10:00", "11:00", "12:00", "15:00"])
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
      await expect(events.getByRole("status"))
        .toContainText("Some live Home Assistant calendars couldn’t refresh. Reopen the day to retry.", { timeout: 15_000 })
      await expect(events).toContainText("Household feed result")
      await expect(page.locator("#day-drawer-close")).toBeFocused()
      await expect(cell.getByText("Household feed result")).toBeVisible()
      await page.keyboard.press("Escape")
      allFail = true
      await cell.press("Enter")
      await expect(events.getByText("Live Home Assistant calendars couldn’t refresh. Reopen the day to retry.", { exact: true }))
        .toBeVisible({ timeout: 15_000 })
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
    await page.getByRole("button", { name: "Load more items (1 remaining)" }).press("Enter")
    await expect(drawer.getByRole("button")).toHaveCount(101)
    await expect(drawer.getByRole("button", { name: /Fitted roof task 101/ })).toBeFocused()
    await expect(page.locator("#day-drawer-task-status")).toHaveText("1 more item loaded")
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
      await expect(page.locator("#day-drawer-tasks")).toContainText("No matching tasks or local events")
      await expect(page.locator("#day-drawer-tasks").getByText("LA Evening Timed Task")).toHaveCount(0)
    } finally {
      await request.put("/api/settings", { data: { key: "timezone", value: prevTz } })
      if (taskId) {
        await request.delete(`/api/tasks/${taskId}`, { data: {} })
      }
    }
  })
})
