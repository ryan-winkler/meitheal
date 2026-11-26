import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

const date = "2031-06-08"
const dayUrl = `/tasks?view=calendar&calView=day&date=${date}#calendar`

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({
  viewport: { width: 320, height: 812 }, hasTouch: true, isMobile: true,
  timezoneId: "America/Los_Angeles", serviceWorkers: "block", reducedMotion: "reduce",
})

test("Day separates overlapping entries and uses the household clock for all 24 hours", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const ids: string[] = []
  const create = async (data: Record<string, string>) => {
    const response = await request.post("/api/tasks", { headers, data })
    expect(response.status(), await response.text()).toBe(201)
    const { id } = await response.json() as { id: string }
    ids.push(id)
    return id
  }
  try {
    const task = await create({ title: "Timed Task", due_date: `${date}T08:30:00Z` })
    const event = await create({ title: "Same-start Event", task_kind: "calendar_event", start_date: `${date}T08:30:00Z` })
    const saved = await create({ title: "Saved connected Event" })
    await create({ title: "Date-only Task", due_date: date })
    await page.route("**/api/calendar/agenda", async route => {
      const response = await route.fetch()
      const payload = await response.json()
      await route.fulfill({ response, json: { ...payload, linkedEvents: [{
        id: saved, title: "Saved connected Event", start: `${date}T08:40:00Z`, entity: null, uid: null, providerSummary: null,
      }] } })
    })
    await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({ json: { entities: ["calendar.fixture"] } }))
    await page.route("**/api/ha/events?**", route => route.fulfill({ json: { events: [
      { summary: "Early connected Event", start: `${date}T00:15:00Z` },
      { summary: "Late connected Event", start: `${date}T22:45:00Z` },
    ] } }))
    await page.goto(dayUrl)
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-timezone", "Europe/Dublin")
    const schedule = page.locator("[data-cal-hourly]")
    const atNine = schedule.locator('[data-hour="9"]')
    const overlap = atNine.locator(".day-drawer-item")
    await expect(overlap).toHaveCount(3)
    await expect(atNine.getByText(/^09:30/)).toHaveCount(2)
    await expect(atNine.getByText("09:40", { exact: true })).toBeVisible()
    await expect(schedule.locator('[data-hour="1"]')).toContainText("Early connected Event")
    await expect(schedule.locator('[data-hour="23"]')).toContainText("Late connected Event")
    const allDay = schedule.locator("#cal-day-allday-strip .day-drawer-item")
    await expect(allDay).toHaveCount(1)
    await expect(allDay).toContainText("Date-only Task")
    await expect(schedule.locator("[data-hour]")).toHaveCount(24)
    expect(await atNine.evaluate(node => {
      const boxes = [...node.querySelectorAll("button")].map(button => button.getBoundingClientRect())
      return boxes.every((box, index) => box.height >= 44 && (!index || box.top >= boxes[index - 1]!.bottom))
        && node.scrollWidth <= node.clientWidth + 1
    })).toBe(true)

    for (const [id, title] of [[task, "Timed Task"], [event, "Same-start Event"], [saved, "Saved connected Event"]]) {
      await atNine.locator(`button[data-task-id="${id}"]`).tap()
      await expect(page.locator("#td-title")).toHaveValue(title!)
      await page.getByRole("button", { name: "Close detail" }).tap()
      await expect(page.locator("#task-detail-overlay")).toBeHidden()
    }
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})

test("Day keeps connected items visible when scheduled work cannot load", async ({ page }) => {
  await page.route("**/api/calendar/agenda", route => route.fulfill({ json: { tasks: null, total: null, linkedEvents: [] } }))
  await page.route("**/api/ha/calendars?configured=1", route => route.fulfill({ json: { entities: ["calendar.fixture"] } }))
  await page.route("**/api/ha/events?**", route => route.fulfill({
    json: { events: [{ summary: "Available connected Event", start: `${date}T08:30:00Z` }] },
  }))
  await page.goto(dayUrl)
  await expect(page.getByRole("region", { name: "Hourly schedule" }).getByText("Available connected Event")).toBeVisible()
  await expect(page.locator("#cal-day-view-task-status")).toHaveText("Couldn’t load this day’s agenda.")
  await expect(page.locator("#cal-day-view-event-status")).toBeEmpty()
})

test("a Day swipe keeps Task and Event capture on the displayed day", async ({ page }) => {
  await page.goto(dayUrl)
  const day = page.locator("[data-cal-day-view]")
  const schedule = day.locator("[data-cal-hourly]")
  await expect(day).toHaveAttribute("data-cal-day-view", date)
  await expect(page.locator("#calendar-shell")).toHaveAttribute("data-calendar-ready", "true")
  await expect(page.locator("#cal-mobile-fab")).toBeHidden()
  const box = (await schedule.boundingBox())!
  const y = Math.round(box.y + 35)
  const client = await page.context().newCDPSession(page)
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 270, y }] })
  await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 170, y }] })
  await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 40, y }] })
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })

  const next = "2031-06-09"
  await expect(day).toHaveAttribute("data-cal-day-view", next)
  const modal = page.locator("#new-task-overlay")
  await expect(modal).toHaveAttribute("data-new-task-controller", "ready")
  await expect(page.locator("#cal-day-view-task-status")).not.toHaveText("Loading…")
  for (const [label, kind, field, value] of [
    ["Add Task", "standard_action", "#nt-contextual-due", next],
    ["Add Event", "calendar_event", "#nt-event-start", /^2031-06-09T00:00/],
  ] as const) {
    const action = day.getByRole("button", { name: label, exact: true })
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44)
    // Chromium can suppress the click from a synthetic tap immediately after a CDP swipe.
    if (kind === "standard_action") await action.press("Enter")
    else await action.tap()
    await expect(modal, label).toBeVisible()
    await expect(modal.locator("#new-task-kind")).toHaveValue(kind)
    await expect(modal.locator(field)).toHaveValue(value)
    await modal.locator("#cancel-new-task").tap()
    await expect(modal).toBeHidden()
  }
})
