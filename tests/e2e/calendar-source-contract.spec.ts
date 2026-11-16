import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test("Calendar reads configured sources as a household member and filters before pagination", async ({ playwright }, testInfo) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and authenticated ingress")
  const work = await mkdtemp(join(tmpdir(), "meitheal-calendar-filter-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  const api = await playwright.request.newContext({ ignoreHTTPSErrors: true })
  const db = new DatabaseSync(join(work, "pins.db"))
  const browser = await launchPinBrowser(work)
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block", timezoneId: "America/Los_Angeles",
  })
  await context.setExtraHTTPHeaders({})
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("response", response => {
    if (response.url().includes("/api/calendar/agenda") || response.status() >= 400) {
      pageErrors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
  })
  page.on("requestfailed", request => pageErrors.push(`${request.failure()?.errorText} ${request.url()}`))
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const base = origin + info.configuredPath
    const headers = (role: string) => ({ origin, cookie: `feedback-fixture=${role}`, "sec-fetch-site": "same-origin" })
    const write = await api.put(base + "/api/settings", { headers: headers("admin"), data: {
      key: "calendar-entities", value: JSON.stringify(["calendar.household", "calendar.household", "light.hall"]),
    } })
    expect(write.status(), await write.text()).toBe(200)
    const settings = await api.get(base + "/api/settings?key=calendar-entities", { headers: headers("member") })
    expect(settings.status()).toBe(403)
    const sources = await api.get(base + "/api/ha/calendars?configured=1", { headers: headers("member") })
    expect(sources.status(), await sources.text()).toBe(200)
    expect(await sources.json()).toEqual({ entities: ["calendar.household"] })
    expect(sources.headers()["cache-control"]).toContain("no-store")

    const date = "2031-07-08"
    const insert = db.prepare(`INSERT INTO tasks (id, title, status, idempotency_key, request_id, due_date, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`)
    for (let index = 0; index < 106; index++) {
      const id = `calendar-fixture-${index}`
      const title = index < 101 ? `Matching garden task ${index}` : `Excluded indoor task ${index}`
      insert.run(id, title, id, id, date, 100_000 + index, 100_000 + index)
    }
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run("calendar-fixture-105")

    const agendaPath = base + "/api/calendar/agenda"
    const query = { date, filters: "search=matching+garden", limit: 100, offset: 0 }
    const first = await api.post(agendaPath, { headers: headers("member"), data: query })
    expect(first.status()).toBe(200)
    const { tasks, total } = await first.json()
    expect(total).toBe(101)
    expect(tasks).toHaveLength(100)
    expect(tasks[0].title).toBe("Matching garden task 100")
    expect(tasks[99].title).toBe("Matching garden task 1")
    const second = await api.post(agendaPath, { headers: headers("member"), data: { ...query, offset: 100 } })
    expect(await second.json()).toMatchObject({ tasks: [{ title: "Matching garden task 0" }], total: 101 })
    const credential = await api.post(base + "/api/agent-tokens", {
      headers: headers("admin"), data: { name: "Calendar scope fixture", scopes: ["tasks:read"] },
    })
    expect(credential.status()).toBe(201)
    const { token } = await credential.json()
    const scoped = { ...headers("member"), authorization: `Bearer ${token}` }
    const agendaQuery = { date, filters: "", offset: 0, limit: 1 }
    expect((await api.get(base + "/api/tasks?limit=1", { headers: scoped })).status()).toBe(200)
    expect((await api.post(agendaPath, { headers: scoped, data: agendaQuery })).status()).toBe(403)
    const overflow = await api.post(base + "/api/calendar/agenda", { headers: headers("member"), data: {
      date, filters: "x".repeat(21_000), offset: 0, limit: 100,
    } })
    expect(overflow.status()).toBe(413)

    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await page.route("**/api/ha/events?*", route => route.fulfill({ json: { events: [] } }))
    await page.goto(base + "/tasks?view=calendar&year=2031&month=6&search=matching+garden#calendar")
    const day = page.locator(`.cal-cell[data-date="${date}"]`)
    await expect(day).toHaveAccessibleName(/101 tasks$/)
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-calendar-ready", "true")
    await day.press("Enter")
    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
    const agenda = page.locator("#day-drawer-tasks")
    await expect(agenda.getByRole("button")).toHaveCount(100, { timeout: 12_000 })
    await page.getByRole("button", { name: "Load more tasks" }).press("Enter")
    await expect(agenda.getByRole("button")).toHaveCount(101)
    await expect(agenda.getByRole("button").last()).toContainText("Matching garden task 0")

    const advanced = JSON.stringify({ id: "root", logic: "AND", conditions: Array.from({ length: 39 }, (_, index) => ({
      id: String(index), field: "title", operator: "equals",
      value: index === 0 ? "Matching garden task 0"
        : ("Retired calendar filter label used by an older integration to describe an irrelevant task " + index),
      logic: index === 0 ? "AND" : "OR",
    })) })
    expect(advanced.length).toBeLessThan(8000)
    expect(encodeURIComponent(advanced).length).toBeGreaterThan(8000)
    const deepLink = new URLSearchParams({ view: "calendar", year: "2031", month: "6", advancedFilter: advanced })
    await page.goto(base + "/tasks?" + deepLink + "#calendar")
    await expect(day).toHaveAccessibleName(/1 task$/)
    await day.press("Enter")
    await expect(agenda.getByRole("button")).toHaveCount(1)
    await expect(agenda.getByRole("button").first()).toContainText("Matching garden task 0")

    const insertLinkedTask = db.prepare(`INSERT INTO tasks (id, title, status, idempotency_key, request_id, task_kind,
      calendar_sync_state, start_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'calendar_event', 'synced', ?, 100, 100)`)
    const insertConfirmation = db.prepare(`INSERT INTO calendar_confirmations (confirmation_id, task_id, request_id,
      provider_event_id, source, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, 100)`)
    const linkedDay = "2031-07-14"
    for (const [id, title, status, source, uid] of [
      ["ha-linked", "Household seed event", "pending", "ha.calendar_sync", "linked-uid"],
      ["caldav-linked", "Linked calendar retreat", "pending", "caldav", "retreat-uid"],
      ["archived-linked", "Archived linked event", "archived", "caldav", "archived-uid"],
    ] as const) {
      insertLinkedTask.run(id, title, status, id, id, "2031-07-11")
      const occurrences = source === "caldav"
        ? [{ start: "2031-07-13", end: "2031-07-15" }]
        : [
            { start: "2031-07-14T08:00:00Z", end: "2031-07-14T09:00:00Z" },
            { start: "2031-07-14T12:00:00Z", end: "2031-07-14T13:00:00Z" },
            { start: "2031-07-14T13:00:00+01:00", end: "2031-07-14T14:00:00+01:00" },
          ]
      insertConfirmation.run(id, id, id, uid, source, JSON.stringify({ entity_id: "calendar.household", occurrences }))
    }
    for (const [id, title, summary, start] of [
      ["ha-idless", "Renamed household event", "Provider name without UID", "2031-07-14T14:00:00Z"],
      ["ha-ambiguous", "Stored ambiguous event", "Ambiguous provider name", "2031-07-14T15:00:00Z"],
    ] as const) {
      insertLinkedTask.run(id, title, "pending", id, id, start)
      insertConfirmation.run(id, id, id, `legacy-${id}`, "ha.calendar_sync",
        JSON.stringify({ entity_id: "calendar.household", summary, occurrences: [{ start }] }))
    }
    let liveAvailable = true
    await page.route("**/api/ha/events?*", route => {
      const params = new URL(route.request().url()).searchParams
      if (params.get("start") !== linkedDay) return route.fallback()
      if (!liveAvailable) return route.fulfill({ status: 503 })
      return route.fulfill({ json: { events: [
        { uid: "linked-uid", summary: "Household live duplicate", start: "2031-07-14T09:00:00+01:00" },
        { uid: "linked-uid", summary: "Household live duplicate", start: "2031-07-14T13:00:00+01:00" },
        { uid: "unlinked-uid", summary: "Live calendar only", start: "2031-07-14T10:00:00Z" },
        { summary: "Provider name without UID", start: "2031-07-14T15:00:00+01:00" },
        { summary: "Ambiguous provider name", start: "2031-07-14T15:00:00Z" },
        { summary: "Ambiguous provider name", start: "2031-07-14T16:00:00+01:00" },
      ] } })
    })
    const unfilteredMonth = base + "/tasks?view=calendar&year=2031&month=6&area=#calendar"
    await page.goto(unfilteredMonth)
    const linkedCell = page.locator(`.cal-cell[data-date="${linkedDay}"]`)
    const connected = page.locator("#day-drawer-events")
    await expect(linkedCell).toHaveAccessibleName(/5 calendar events$/)
    await expect(page.locator('.cal-cell[data-date="2031-07-15"]')).not.toHaveAccessibleName(/calendar event/)
    await linkedCell.press("Enter")
    await expect(connected.getByRole("button", { name: /Household seed event/ })).toHaveCount(2)
    await expect(connected.getByRole("button", { name: /Linked calendar retreat/ })).toBeVisible()
    await expect(connected.getByText("Live calendar only")).toBeVisible()
    await expect(connected.getByText("Household live duplicate")).toHaveCount(0)
    await expect(connected.getByRole("button", { name: /Renamed household event/ })).toBeVisible()
    await expect(connected.getByText("Provider name without UID")).toHaveCount(0)
    await expect(connected.getByText("Ambiguous provider name")).toHaveCount(2)
    await expect(connected.getByText("Archived linked event")).toHaveCount(0)
    await connected.getByRole("button", { name: /Linked calendar retreat/ }).click()
    await expect(page.locator("#td-title")).toHaveValue("Linked calendar retreat")
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
    liveAvailable = false
    await linkedCell.press("Enter")
    await expect(connected.getByText("Connected calendar events couldn’t load.")).toBeVisible()
    await expect(connected.getByRole("button", { name: /Household seed event/ })).toHaveCount(2)
    await expect(connected.getByRole("button", { name: /Linked calendar retreat/ })).toBeVisible()
    await page.keyboard.press("Escape")
    await page.getByRole("toolbar", { name: "Filter tasks" }).getByRole("button", { name: "Events", exact: true }).click()
    await expect(linkedCell).not.toHaveAccessibleName(/calendar event/)
    await linkedCell.press("Enter")
    await expect(connected).toBeHidden()

    for (const [key, value] of [["timezone", "America/Los_Angeles"], ["calendar_entities", "[]"]]) {
      const result = await api.put(base + "/api/settings", { headers: headers("admin"), data: { key, value } })
      expect(result.status(), await result.text()).toBe(200)
    }
    const clearedSources = await api.get(base + "/api/ha/calendars?configured=1", { headers: headers("member") })
    expect(await clearedSources.json()).toEqual({ entities: [] })
    await page.goto(unfilteredMonth)
    await page.evaluate(() => { document.documentElement.dataset.fixtureCalendar = "mounted" })
    await linkedCell.press("Enter")
    await expect(connected.getByRole("button", { name: /Linked calendar retreat/ })).toBeVisible()
    await expect(connected.getByText("Connected calendar events couldn’t load.")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-timezone", "America/Los_Angeles")
    await expect(day).toHaveAccessibleName(/105 tasks$/)
    const eventDay = page.locator('.cal-cell[data-date="2031-07-09"]')
    await eventDay.press("Enter")
    await page.getByRole("button", { name: "Add Event" }).click()
    await expect(page.locator("#nt-event-start")).toHaveValue(/^2031-07-09T00:00/)
    await page.locator("#new-task-title-input").fill("Native patio gathering")
    const created = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/api/tasks"))
    await page.locator("#submit-new-task-btn").click()
    expect((await created).status()).toBe(201)
    const capturedDate = db.prepare("SELECT task_kind, start_date, due_date FROM tasks WHERE title = ?")
    expect(capturedDate.get("Native patio gathering")).toMatchObject({
      task_kind: "calendar_event", start_date: "2031-07-09", due_date: null,
    })
    await expect(page.locator("#td-title")).toHaveValue("Native patio gathering")
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
    await expect(page.locator("html")).toHaveAttribute("data-fixture-calendar", "mounted")
    await expect(eventDay).toHaveAccessibleName(/1 calendar event$/)
    await expect(day).toHaveAccessibleName(/105 tasks$/)
    await eventDay.press("Enter")
    await expect(agenda.getByRole("button", { name: /Native patio gathering/ })).toContainText("All day")
    await expect(agenda.locator(".day-drawer-item-icon use")).toHaveAttribute("href", "#mt-icon-calendar-event")
    await page.keyboard.press("Escape")
    const taskDay = page.locator('.cal-cell[data-date="2031-07-10"]')
    await taskDay.press("Enter")
    await page.locator("#day-drawer-add-task").click()
    await expect(page.locator("#nt-contextual-due")).toHaveValue("2031-07-10")
    await page.locator("#new-task-title-input").fill("Workshop bench check")
    const taskCreated = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/api/tasks"))
    await page.locator("#submit-new-task-btn").click()
    expect((await taskCreated).status()).toBe(201)
    expect(capturedDate.get("Workshop bench check")).toMatchObject({ task_kind: "standard_action", due_date: "2031-07-10" })
    await expect(page.locator("#td-title")).toHaveValue("Workshop bench check")
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
    await expect(page.locator("html")).toHaveAttribute("data-fixture-calendar", "mounted")
    await expect(taskDay).toHaveAccessibleName(/1 task$/)
    await expect(eventDay).toHaveAccessibleName(/1 calendar event$/)
    await taskDay.press("Enter")
    await expect(agenda.getByRole("button", { name: /Workshop bench check/ })).toBeVisible()

    const legacy = JSON.stringify({ conditions: [
      { field: "title", operator: "equals", value: "Matching garden task 0" },
      ...Array.from({ length: 19 }, () => ({ field: "title", operator: "notContains", value: "x".repeat(340) })),
    ] })
    deepLink.set("advancedFilter", legacy)
    await page.goto(base + "/tasks?" + deepLink + "#calendar")
    await expect(day).toHaveAccessibleName(/1 task$/)
    await page.getByRole("combobox", { name: "Filter by priority" }).selectOption("3")
    await expect(page).toHaveURL(url => url.searchParams.get("priority") === "3")
    expect(new URL(page.url()).searchParams.get("advancedFilter")).toBe(legacy)
    await expect(day).toHaveAccessibleName(/1 task$/)
    await day.press("Enter")
    await expect(agenda.getByRole("button")).toHaveCount(1)
    await expect(agenda.getByRole("button").first()).toContainText("Matching garden task 0")

    const names = Array.from({ length: 23 }, (_, index) => `${"園".repeat(63)}${String(index).padStart(2, "0")}`)
    const extra = "川".repeat(100)
    await page.route("**/api/labels", route => route.fulfill({ json: [...names, extra].map(title => ({ title })) }))
    db.prepare("UPDATE tasks SET labels = ? WHERE id = ?").run(JSON.stringify(names), "calendar-fixture-0")
    deepLink.delete("advancedFilter")
    deepLink.set("labels", names.join(","))
    const monthUrl = base + "/tasks?" + deepLink + "#calendar"
    expect(new URL(monthUrl).search.length).toBeLessThan(14_000)
    expect(new URLSearchParams({ calendar_filters: deepLink.toString() }).toString().length).toBeGreaterThan(20_000)
    await page.goto(monthUrl)
    await expect(day).toHaveAccessibleName(/1 task$/)
    await day.press("Enter")
    await expect(agenda.getByRole("button")).toHaveCount(1)
    await expect(agenda.getByRole("button").first()).toContainText("Matching garden task 0")
    await page.keyboard.press("Escape")
    await page.getByText("Labels (23)", { exact: true }).click()
    const longLabel = page.getByRole("button", { name: extra, exact: true })
    await longLabel.click()
    await expect(longLabel).toHaveAttribute("aria-pressed", "false")
    await expect(page.locator("[data-calendar-status]")).toContainText("Remove a Calendar filter")
    await expect(page).toHaveURL(monthUrl)
    await expect(day).toHaveAccessibleName(/1 task$/)
    await page.getByText("Labels (23)", { exact: true }).click()
    await page.getByRole("button", { name: "Clear all active filters" }).click()
    await expect(page).toHaveURL(url => !url.searchParams.has("labels"))
    await expect(day).toHaveAccessibleName(/105 tasks$/)
  } catch (error) {
    console.log("Calendar browser diagnostics", pageErrors)
    throw error
  } finally {
    await testInfo.attach("Browser errors", { body: JSON.stringify(pageErrors), contentType: "application/json" })
    await browser.close()
    db.close()
    await api.dispose()
    if (child.exitCode === null) {
      const stopped = once(child, "exit")
      child.kill("SIGTERM")
      await stopped
    }
    await rm(work, { recursive: true, force: true })
  }
})
