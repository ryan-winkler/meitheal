import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Calendar filters and recovery", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test.beforeEach(async ({ page }) => {
    await page.goto("/calendar")
    await page.waitForLoadState("networkidle")
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

    await page.locator("#calendar-advanced-toggle").click()
    await page.getByRole("button", { name: "Condition", exact: true }).click()
    await page.locator("#calendar-advanced-panel .adv-val").fill("word".repeat(2050))
    await page.getByRole("button", { name: "Apply Rules" }).click()
    await expect(page.locator("[data-calendar-status]")).toContainText("Shorten the Calendar rules")
    await expect(page.getByRole("button", { name: "Retry calendar" })).toBeVisible()
    await page.getByRole("button", { name: "Close custom filters" }).click()
    const retryCalendar = page.getByRole("button", { name: "Retry calendar" })
    const retryFailure = page.waitForResponse(response => new URL(response.url()).searchParams.has("calendarRefresh"))
    await retryCalendar.press("Enter")
    expect((await retryFailure).status()).toBe(503)
    await expect(retryCalendar).toBeFocused()

    fail = false
    const backgroundRefresh = page.waitForResponse(response => new URL(response.url()).searchParams.has("calendarRefresh"))
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed", { detail: { action: "created" } })))
    expect((await backgroundRefresh).status()).toBe(200)
    await expect(month).not.toHaveAttribute("aria-busy")
    await expect(page).not.toHaveURL(/search=/)
    await expect(retryCalendar).toBeFocused()
    await retryCalendar.click()
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

  test("failed Clear Rules restores the applied rules in the open Calendar editor", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const day = "2031-07-24"
    const ids: string[] = []
    try {
      for (const title of ["Replace roof", "Paint fence"]) {
        const task = await request.post("/api/tasks", { headers, data: { title, due_date: day } })
        expect(task.status(), await task.text()).toBe(201)
        ids.push((await task.json()).id)
      }
      const params = new URLSearchParams({
        view: "calendar", year: "2031", month: "6", area: "",
        advancedFilter: JSON.stringify({
          id: "root", logic: "AND",
          conditions: [{ id: "roof", field: "title", operator: "contains", value: "roof" }],
        }),
      })
      let fail = true
      await page.route(url => url.searchParams.has("calendarRefresh"), route => fail
        ? route.fulfill({ status: 503 })
        : route.continue())
      await page.goto("/tasks?" + params + "#calendar")
      const cell = page.locator(`.cal-cell[data-date="${day}"]`)
      await expect(cell).toHaveAccessibleName(/1 task$/)
      await page.locator("#calendar-advanced-toggle").click()
      const value = page.getByRole("textbox", { name: "Value", exact: true })
      await expect(value).toHaveValue("roof")
      await page.getByRole("button", { name: "Clear Rules" }).click()

      const retry = page.getByRole("button", { name: "Retry calendar" })
      await expect(retry).toBeVisible()
      await expect(value).toBeVisible()
      await expect(value).toHaveValue("roof")
      await expect(cell).toHaveAccessibleName(/1 task$/)
      expect(new URL(page.url()).searchParams.get("advancedFilter")).toBe(params.get("advancedFilter"))

      fail = false
      await page.getByRole("button", { name: "Close custom filters" }).click()
      await retry.click()
      await expect(retry).toBeHidden()
      await page.locator("#calendar-advanced-toggle").click()
      await expect(value).toHaveCount(0)
      await expect(cell).toHaveAccessibleName(/2 tasks$/)
      await expect(page).not.toHaveURL(/advancedFilter=/)
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers, data: {} })
    }
  })

  test("a successful newer Calendar refresh retires the earlier failed filter", async ({ page }) => {
    let release = () => {}
    let blocked = false
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      const value = new URL(route.request().url()).searchParams.get("search")
      if (value === "first attempt") return route.fulfill({ status: 503 })
      if (!blocked && value === "new search") {
        blocked = true
        await pending
        return route.abort().catch(() => {})
      }
      return route.continue()
    })
    const search = page.getByRole("textbox", { name: "Filter by text" })
    const retry = page.getByRole("button", { name: "Retry calendar" })
    try {
      await search.fill("first attempt")
      await expect(retry).toBeVisible()
      await search.fill("new search")
      await expect.poll(() => blocked).toBe(true)
      await page.evaluate(() => document.dispatchEvent(new Event("meitheal:tasks-changed")))
      await expect(page).toHaveURL(/search=new\+search/)
      await expect(retry).toBeHidden()
      await expect(page.locator("[data-calendar-status]")).toBeHidden()
    } finally {
      release()
    }
  })

  test("invalid rule leaves Retry available after an initial Calendar outage", async ({ page }) => {
    await page.route(url => url.pathname === "/tasks" && url.searchParams.get("view") === "calendar"
      && !url.searchParams.has("calendarRefresh"), async route => {
      const response = await route.fetch()
      const body = (await response.text())
        .replace('data-calendar-available="true"', 'data-calendar-available="false"')
        .replace(/(data-calendar-status role="status") hidden[^>]*>/, "$1>Calendar data could not load.")
        .replace(/data-calendar-retry hidden[^>]*>/, "data-calendar-retry>")
      await route.fulfill({ response, body })
    }, { times: 1 })
    await page.goto("/tasks?view=calendar&year=2031&month=6#calendar")
    const retry = page.getByRole("button", { name: "Retry calendar" })
    await expect(retry).toBeVisible()
    const advanced = page.locator("#calendar-advanced-toggle")
    await advanced.click()
    await page.getByRole("button", { name: "Condition", exact: true }).click()
    await page.locator("#calendar-advanced-panel .adv-val").fill("word".repeat(2050))
    await page.getByRole("button", { name: "Apply Rules" }).click()
    await expect(page.locator("[data-calendar-rule-error]")).toBeVisible()
    await expect(page.locator("[data-calendar-status]")).toContainText("Calendar data could not load.")
    await page.getByRole("button", { name: "Close custom filters" }).press("Enter")
    await expect(advanced).toBeFocused()
    await retry.click()
    await expect(page.locator("[data-calendar-month]")).toHaveAttribute("data-calendar-available", "true")
    await expect(retry).toBeHidden()
    const status = page.locator("[data-calendar-status]")
    await expect(status).toHaveText("Shorten the Calendar rules or remove a condition.")
    await advanced.press("Enter")
    await expect(page.locator("[data-calendar-rule-error]")).toHaveText("Shorten the Calendar rules or remove a condition.")
    const value = page.locator("#calendar-advanced-panel .adv-val")
    await expect(value).toHaveValue("word".repeat(2050))

    await page.getByRole("button", { name: "Close custom filters" }).click()
    await page.route(url => url.searchParams.has("calendarRefresh"), route => route.fulfill({ status: 503 }))
    await page.getByRole("combobox", { name: "Filter by priority" }).selectOption("3")
    await expect(retry).toBeVisible()
    await advanced.click()
    await expect(value).toHaveValue("word".repeat(2050))
    await expect(page.locator("[data-calendar-rule-error]")).toBeVisible()
  })

  test("Calendar Retry leaves focus in an agenda opened during the request", async ({ page }) => {
    let fail = true
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      if (fail) return route.fulfill({ status: 503, body: "Calendar service unavailable" })
      await pending
      await route.continue()
    })
    await page.getByRole("textbox", { name: "Filter by text" }).fill("roof")
    const retry = page.getByRole("button", { name: "Retry calendar" })
    await expect(retry).toBeVisible()
    fail = false
    try {
      await retry.press("Enter")
      await page.locator('.cal-cell[data-date]:not(.cal-other)').first().press("Enter")
      const close = page.locator("#day-drawer-close")
      await expect(close).toBeFocused()
      release()
      await expect(page).toHaveURL(/search=roof/)
      await expect(close).toBeFocused()
    } finally {
      release()
    }
  })

  test("Calendar restores month navigation focus after a pending filter refresh", async ({ page }) => {
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    const refresh = (url: URL) => url.searchParams.has("calendarRefresh")
    await page.route(refresh, async route => {
      await pending
      await route.continue()
    })
    try {
      const requested = page.waitForRequest(request => refresh(new URL(request.url())))
      await page.getByRole("textbox", { name: "Filter by text" }).fill("roof")
      await requested
      const next = page.getByRole("link", { name: "Next month" })
      await next.focus()
      await expect(next).toBeFocused()
      release()
      await expect(page).toHaveURL(/search=roof/)
      await expect(next).toBeFocused()
    } finally {
      release()
    }
  })

  test("a background refresh replacing Calendar Retry preserves its focus on failure", async ({ page }) => {
    let hold = false
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      if (hold) {
        hold = false
        await pending
        return route.abort().catch(() => {})
      }
      return route.fulfill({ status: 503, body: "Calendar service unavailable" })
    })
    await page.getByRole("textbox", { name: "Filter by text" }).fill("roof")
    const retry = page.getByRole("button", { name: "Retry calendar" })
    await expect(retry).toBeVisible()
    hold = true
    try {
      const retryRequest = page.waitForRequest(request => new URL(request.url()).searchParams.has("calendarRefresh"))
      await retry.press("Enter")
      await retryRequest
      await expect(retry).toHaveAttribute("aria-disabled", "true")
      await page.evaluate(() => document.dispatchEvent(new CustomEvent("meitheal:tasks-changed")))
      await expect(retry).toBeEnabled()
      await expect(retry).toBeFocused()
    } finally {
      release()
    }
  })

  test("Calendar Retry retains focus on a filter chip used while loading", async ({ page }) => {
    let fail = true
    let release = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      if (fail) return route.fulfill({ status: 503 })
      await pending
      await route.continue()
    })
    await page.goto("/tasks?view=calendar&rice=high#calendar")
    await page.getByRole("textbox", { name: "Filter by text" }).fill("roof")
    const retry = page.getByRole("button", { name: "Retry calendar" })
    await expect(retry).toBeVisible()
    fail = false
    try {
      await retry.press("Enter")
      const chip = page.getByRole("button", { name: "Remove RICE filter high" })
      await chip.focus()
      release()
      await expect(page).toHaveURL(/search=roof/)
      await expect(chip).toBeFocused()
    } finally {
      release()
    }
  })

  test("pending and failed Calendar refreshes retain accepted Area and Events states", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const created = await request.post("/api/areas", { headers, data: { name: "Remembered workshop" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    let release = () => {}
    const hold = new Promise<void>(resolve => { release = resolve })
    let held = false
    let fail = false
    await page.evaluate(areaId => localStorage.setItem(document.querySelector<HTMLElement>("[data-area-selector]")!.dataset.areaStorageKey!, JSON.stringify({
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
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem(document.querySelector<HTMLElement>("[data-area-selector]")!.dataset.areaStorageKey!) ?? "{}").areaId)).toBe(id)

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

      fail = false
      await trigger.click()
      await page.locator('#area-selector-dropdown [data-area-id=""]').click()
      await expect(page).toHaveURL(url => url.searchParams.get("area") === "")
      await expect(retry).toBeHidden()
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem(document.querySelector<HTMLElement>("[data-area-selector]")!.dataset.areaStorageKey!) ?? "{}").areaId)).toBe("")
      await page.goto("/tasks?view=calendar&year=2031&month=6#calendar", { waitUntil: "networkidle" })
      await expect(trigger).toContainText("All Areas")
      await expect(page).not.toHaveURL(/area=/)
    } finally {
      release()
      await request.delete(`/api/areas/${id}`, { headers, data: {} })
    }
  })

  test("Calendar keeps the previous Area when a filter change exceeds its URL limit", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem(document.querySelector<HTMLElement>("[data-area-selector]")!.dataset.areaStorageKey!) ?? "{}").areaId)).toBe("")

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

      await page.evaluate(areaId => localStorage.setItem(document.querySelector<HTMLElement>("[data-area-selector]")!.dataset.areaStorageKey!, JSON.stringify({
        areaId, areaName: "Extra calendar area", areaIcon: "folder",
      })), id)
      params.delete("area")
      await page.goto("/tasks?" + params + "#calendar")
      await expect(page.locator("[data-calendar-status]")).toContainText("The previous results are still shown.")
      await expect(trigger).toContainText("All Areas")
      await expect(all).toHaveAttribute("aria-selected", "true")
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem(document.querySelector<HTMLElement>("[data-area-selector]")!.dataset.areaStorageKey!) ?? "{}").areaId)).toBe(id)

      await page.goto("/tasks?view=calendar&area=#calendar")
      const advanced = page.locator("#calendar-advanced-toggle")
      await advanced.click()
      await page.getByRole("button", { name: "Condition", exact: true }).click()
      const value = page.locator("#calendar-advanced-panel .adv-val")
      const tooLong = "word".repeat(2050)
      await value.fill(tooLong)
      await page.getByRole("button", { name: "Apply Rules" }).click()
      await expect(page.locator("[data-calendar-status]")).toContainText("Shorten the Calendar rules")
      await expect(page.locator("[data-calendar-rule-error]")).toBeVisible()
      await expect(advanced).toHaveAttribute("aria-expanded", "true")
      await expect(value).toHaveValue(tooLong)
      await page.keyboard.press("Escape")
      await expect(advanced).toBeFocused()
      await advanced.press("Enter")
      await value.fill("workshop")
      await page.getByRole("button", { name: "Apply Rules" }).press("Enter")
      await expect(advanced).toBeFocused()
      await expect(page).toHaveURL(url => url.searchParams.has("advancedFilter"))
    } finally {
      await request.delete(`/api/areas/${id}`, { headers, data: {} })
    }
  })

  test("month navigation retains a filter while the calendar is still loading", async ({ page }) => {
    let releaseRequest = () => {}
    const pending = new Promise<void>(resolve => { releaseRequest = resolve })
    const requested: URL[] = []
    await page.route(url => url.searchParams.has("calendarRefresh"), async route => {
      requested.push(new URL(route.request().url()))
      await pending
      await route.continue().catch(() => {})
    })
    try {
      await page.getByRole("textbox", { name: "Filter by text" }).fill("roof")
      await expect(page.getByText("Loading calendar…")).toBeVisible()
      const next = page.getByRole("link", { name: "Next month" })
      const canonicalHref = await next.getAttribute("href")
      const opened = page.context().waitForEvent("page")
      await next.click({ modifiers: ["Control"] })
      const newTab = await opened
      await expect(newTab).toHaveURL(url => url.searchParams.has("month") && !url.searchParams.has("search"))
      await newTab.close()
      await expect(next).toHaveAttribute("href", canonicalHref!)
      const nextMonth = new URL(canonicalHref!, page.url()).searchParams.get("month")
      // Month navigation refreshes in place: the pending request carries the filter
      // and the address follows once that month is shown.
      await next.click()
      await expect.poll(() => requested.at(-1)?.searchParams.get("month")).toBe(nextMonth)
      expect(requested.at(-1)!.searchParams.get("search")).toBe("roof")
      await expect(page.getByRole("textbox", { name: "Filter by text" })).toHaveValue("roof")
      releaseRequest()
      await expect(page).toHaveURL(url => url.searchParams.get("search") === "roof" && url.searchParams.get("month") === nextMonth)
      await expect(page.getByRole("textbox", { name: "Filter by text" })).toHaveValue("roof")
    } finally {
      releaseRequest()
    }
  })
})
