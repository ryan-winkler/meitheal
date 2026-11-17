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
    for (let index = 0; index < 206; index++) {
      const id = `calendar-fixture-${index}`
      const title = index < 201 ? `Matching garden task ${index}` : `Excluded indoor task ${index}`
      insert.run(id, title, id, id, date, 100_000 + index, 100_000 + index)
    }
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run("calendar-fixture-205")

    const agendaPath = base + "/api/calendar/agenda"
    const query = { date, filters: "search=matching+garden", limit: 100, offset: 0 }
    const first = await api.post(agendaPath, { headers: headers("member"), data: query })
    expect(first.status()).toBe(200)
    const { tasks, total } = await first.json()
    expect(total).toBe(201)
    expect(tasks).toHaveLength(100)
    expect(tasks[0].title).toBe("Matching garden task 200")
    expect(tasks[99].title).toBe("Matching garden task 101")
    const second = await api.post(agendaPath, { headers: headers("member"), data: { ...query, offset: 100 } })
    const secondPage = await second.json()
    expect(secondPage.total).toBe(201)
    expect(secondPage.tasks).toHaveLength(100)
    expect(secondPage.tasks[0].title).toBe("Matching garden task 100")
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
    await expect(day).toHaveAccessibleName(/201 tasks$/)
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-calendar-ready", "true")
    await day.press("Enter")
    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
    const agenda = page.locator("#day-drawer-tasks")
    await expect(agenda.getByRole("button")).toHaveCount(100, { timeout: 12_000 })
    const moreTasks = page.getByRole("button", { name: "Load more items" })
    await moreTasks.press("Enter")
    await expect(agenda.getByRole("button")).toHaveCount(200)
    await expect(agenda.getByRole("button").nth(100)).toBeFocused()
    await expect(page.locator("#day-drawer-task-status")).toHaveText("100 more items loaded")
    await page.keyboard.press("Tab")
    await expect(agenda.getByRole("button").nth(101)).toBeFocused()
    await moreTasks.press("Enter")
    await expect(agenda.getByRole("button")).toHaveCount(201)
    await expect(agenda.getByRole("button").last()).toBeFocused()
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
            { start: "2031-07-14T09:00:00", end: "2031-07-14T10:00:00" },
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
      if (params.get("start") !== "2031-07-13T00:00:00Z" || params.get("end") !== "2031-07-16T00:00:00Z") return route.fallback()
      if (!liveAvailable) return route.fulfill({ status: 503 })
      return route.fulfill({ json: { events: [
        { uid: "linked-uid", summary: "Household live duplicate", start: "2031-07-14T09:00:00+01:00" },
        { uid: "linked-uid", summary: "Household live duplicate", start: "2031-07-14T13:00:00+01:00" },
        { uid: "unlinked-uid", summary: "Live calendar only", start: "2031-07-14T10:00:00Z" },
        { summary: "  PROVIDER  NAME without uid  ", start: "2031-07-14T15:00:00+01:00" },
        { summary: "  AMBIGUOUS provider  name", start: "2031-07-14T15:00:00Z" },
        { summary: "ambiguous PROVIDER name  ", start: "2031-07-14T16:00:00+01:00" },
      ] } })
    })
    const unfilteredMonth = base + "/tasks?view=calendar&year=2031&month=6&area=#calendar"
    await page.goto(unfilteredMonth)
    const linkedCell = page.locator(`.cal-cell[data-date="${linkedDay}"]`)
    const connected = page.locator("#day-drawer-events")
    await expect(linkedCell).toHaveAccessibleName(/5 calendar events$/)
    await expect(linkedCell.locator(".cal-event-badge > span")).toBeVisible()
    expect(await linkedCell.locator(".cal-event-badge > span").evaluate(count => count.firstChild?.textContent)).toBe("5")
    await expect(page.locator("#calendar-signal-summary")).toContainText("5 synced events")
    await expect(page.locator('.cal-cell[data-date="2031-07-15"]')).not.toHaveAccessibleName(/calendar event/)
    await linkedCell.press("Enter")
    await expect(connected.getByRole("button", { name: /Household seed event/ })).toHaveCount(2)
    await expect(connected.getByRole("button", { name: /Linked calendar retreat/ })).toBeVisible()
    await expect(connected.getByText("Live calendar only")).toBeVisible()
    await expect(connected.getByText("Household live duplicate")).toHaveCount(0)
    await expect(connected.getByRole("button", { name: /Renamed household event/ })).toBeVisible()
    const connectedTitles = connected.locator(".day-drawer-item-title")
    const countTitle = (text: string) => connectedTitles.evaluateAll((titles, expected) =>
      titles.filter(title => title.textContent?.trim().toLowerCase().replace(/\s+/g, " ") === expected).length, text)
    await expect.poll(() => countTitle("ambiguous provider name")).toBe(2)
    expect(await countTitle("provider name without uid")).toBe(0)
    await expect(connected.getByText("Archived linked event")).toHaveCount(0)
    await connected.getByRole("button", { name: /Linked calendar retreat/ }).click()
    await expect(page.locator("#td-title")).toHaveValue("Linked calendar retreat")
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
    liveAvailable = false
    await linkedCell.press("Enter")
    await expect(connected.getByText("Live Home Assistant calendars couldn’t refresh. Reopen the day to retry.")).toBeVisible()
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
    await expect(connected.getByText("Live Home Assistant calendars couldn’t refresh. Reopen the day to retry.")).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-timezone", "America/Los_Angeles")
    await expect(day).toHaveAccessibleName(/205 tasks$/)
    const eventDay = page.locator('.cal-cell[data-date="2031-07-09"]')
    await eventDay.press("Enter")
    await page.getByRole("button", { name: "Add Event" }).click()
    await expect(page.locator("#nt-event-start")).toHaveValue(/^2031-07-09T00:00/)
    await page.locator("#new-task-title-input").fill("Native patio gathering")
    const timedEnd = page.locator("#nt-event-end")
    await timedEnd.fill("2031-07-09T00:00")
    await page.locator("#submit-new-task-btn").click()
    await expect(page.locator("#nt-date-error")).toBeVisible()
    await timedEnd.fill("")
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
    expect(await eventDay.locator(".cal-event-badge > span").evaluate(count => count.firstChild?.textContent)).toBe("1")
    await expect(day).toHaveAccessibleName(/205 tasks$/)
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
    await expect(day).toHaveAccessibleName(/205 tasks$/)

    // The cached end came from a UTC-based sync, while this browser reads the household day in Los Angeles.
    const boundaryId = "linked-timezone-boundary"
    const start = "2031-07-20T23:30:00Z"
    insertLinkedTask.run(boundaryId, "Linked timed appointment", "pending", boundaryId, boundaryId, start)
    insertConfirmation.run(boundaryId, boundaryId, boundaryId, "timezone-boundary-uid", "caldav", JSON.stringify({
      occurrences: [{ start, end: "2031-07-21T01:00:00Z", effective_end: "2031-07-21" }],
    }))
    const legacyId = "legacy-linked-with-provider-bounds"
    const startDate = "2031-07-22"
    insertLinkedTask.run(legacyId, "Legacy linked workshop", "pending", legacyId, legacyId, null)
    db.prepare("UPDATE tasks SET due_date = ? WHERE id = ?").run(startDate, legacyId)
    insertConfirmation.run(legacyId, legacyId, legacyId, "legacy-bounds-uid", "ha.calendar_sync", JSON.stringify({
      entity_id: "calendar.household", start: startDate, end: "2031-07-24",
    }))
    const legacyCalDAV = "legacy-caldav-with-provider-bounds"
    insertLinkedTask.run(legacyCalDAV, "Legacy linked CalDAV trip", "pending", legacyCalDAV, legacyCalDAV, "2031-07-27")
    insertConfirmation.run(legacyCalDAV, legacyCalDAV, legacyCalDAV, "older-caldav-uid", "caldav", JSON.stringify({
      dtstart: "2031-07-25", dtend: "2031-07-27",
    }))
    await page.reload()
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-timezone", "America/Los_Angeles")
    const boundaryDay = page.locator('.cal-cell[data-date="2031-07-20"]')
    const followingDay = page.locator('.cal-cell[data-date="2031-07-21"]')
    await expect(boundaryDay).toHaveAccessibleName(/1 calendar event$/)
    await expect(followingDay).not.toHaveAccessibleName(/calendar event/)
    await boundaryDay.press("Enter")
    const appointment = connected.getByRole("button", { name: /Linked timed appointment/ })
    await expect(appointment).toBeVisible()
    await page.keyboard.press("Escape")
    await followingDay.press("Enter")
    await expect(appointment).toHaveCount(0)
    await page.keyboard.press("Escape")

    const legacyLastDay = page.locator('.cal-cell[data-date="2031-07-23"]')
    await expect(legacyLastDay).toHaveAccessibleName(/1 calendar event$/)
    await expect(page.locator('.cal-cell[data-date="2031-07-24"]')).not.toHaveAccessibleName(/calendar event/)
    await legacyLastDay.press("Enter")
    await expect(connected.getByRole("button", { name: /Legacy linked workshop/ })).toBeVisible()
    await page.keyboard.press("Escape")
    const calDAVLastDay = page.locator('.cal-cell[data-date="2031-07-26"]')
    await expect(calDAVLastDay).toHaveAccessibleName(/1 calendar event$/)
    await expect(page.locator('.cal-cell[data-date="2031-07-27"]')).not.toHaveAccessibleName(/calendar event/)
    await calDAVLastDay.press("Enter")
    await expect(connected.getByRole("button", { name: /Legacy linked CalDAV trip/ })).toBeVisible()
    await page.keyboard.press("Escape")

    const overnight = { start: "2031-07-27T23:30:00-07:00", end: "2031-07-28T01:00:00-07:00" }
    const overnightId = "linked-overnight-event"
    insertLinkedTask.run(overnightId, "Saved overnight event", "pending", overnightId, overnightId, overnight.start)
    insertConfirmation.run(overnightId, overnightId, overnightId, "overnight-saved", "caldav", JSON.stringify(overnight))
    const enableFeed = await api.put(base + "/api/settings", { headers: headers("admin"),
      data: { key: "calendar_entities", value: '["calendar.household"]' },
    })
    expect(enableFeed.status(), await enableFeed.text()).toBe(200)
    await page.route("**/api/ha/events?*", route => route.fulfill({ json: {
      events: [{ uid: "overnight-live", summary: "Live overnight event", ...overnight }],
    } }))
    await page.goto(unfilteredMonth)
    for (const [date, label] of [["2031-07-27", "23:30"], ["2031-07-28", "Continues · Started Jul 27, 23:30"]] as const) {
      await page.locator(`.cal-cell[data-date="${date}"]`).press("Enter")
      for (const title of ["Saved overnight event", "Live overnight event"]) {
        await expect(connected.locator(".day-drawer-item").filter({ hasText: title }).locator(".day-drawer-item-meta")).toHaveText(label)
      }
      await page.keyboard.press("Escape")
    }

    const pastDay = "2020-08-17"
    insert.run("overdue-calendar", "Overdue calendar task", "overdue-calendar", "overdue-calendar", pastDay, 100, 100)
    insert.run("deferred-calendar", "Deferred calendar task", "deferred-calendar", "deferred-calendar", pastDay, 100, 100)
    db.prepare("UPDATE tasks SET deferred_at = 200 WHERE id = ?").run("deferred-calendar")
    await page.goto(base + "/tasks?view=calendar&year=2020&month=7#calendar")
    const overdueDay = page.locator(`.cal-cell[data-date="${pastDay}"]`)
    await expect(overdueDay).toHaveAccessibleName(/2 tasks$/)
    await page.getByRole("combobox", { name: "Filter by status" }).selectOption("overdue")
    await expect(overdueDay).toHaveAccessibleName(/1 task$/)
    await overdueDay.press("Enter")
    await expect(agenda.getByRole("button", { name: /Overdue calendar task/ })).toBeVisible()
    await expect(agenda.getByRole("button", { name: /Deferred calendar task/ })).toHaveCount(0)
    await page.keyboard.press("Escape")

    for (const [key, value] of [["timezone", "America/Nuuk"], ["calendar_entities", '["calendar.household"]']]) {
      const result = await api.put(base + "/api/settings", { headers: headers("admin"), data: { key, value } })
      expect(result.status(), await result.text()).toBe(200)
    }
    const gapId = "linked-midnight-gap"
    insertLinkedTask.run(gapId, "Saved midnight transition", "pending", gapId, gapId, null)
    insertConfirmation.run(gapId, gapId, gapId, "midnight-gap-uid", "ha.calendar_sync", JSON.stringify({
      entity_id: "calendar.household", start: "2026-03-28T23:30:00", end: "2026-03-28T23:45:00",
    }))
    await page.route("**/api/ha/events?*", route => route.fulfill({ json: { events: [
      { uid: "midnight-gap-uid", summary: "Live midnight transition", start: "2026-03-29T01:30:00Z" },
    ] } }))
    await page.goto(base + "/tasks?view=calendar&year=2026&month=2#calendar")
    const prior = page.locator('.cal-cell[data-date="2026-03-28"]')
    const shifted = page.locator('.cal-cell[data-date="2026-03-29"]')
    await expect(prior).not.toHaveAccessibleName(/calendar event/)
    await expect(shifted).toHaveAccessibleName(/\b1 calendar event\b/)
    await expect(shifted.locator(".cal-inline-ha")).toHaveText("00:30 Live midnight transition")
    await shifted.press("Enter")
    await expect(connected.getByRole("button", { name: /Saved midnight transition.*00:30/ })).toBeVisible()
    await expect(connected.getByText("Live midnight transition")).toHaveCount(0)

    const rollbackZone = await api.put(base + "/api/settings", { headers: headers("admin"), data: { key: "timezone", value: "America/Goose_Bay" } })
    expect(rollbackZone.status(), await rollbackZone.text()).toBe(200)
    const rollbackId = "linked-midnight-rollback"
    const rollback = { start: "2010-11-07T03:00:30Z", end: "2010-11-07T03:15:00Z" }
    insertLinkedTask.run(rollbackId, "Saved rollback appointment", "pending", rollbackId, rollbackId, null)
    insertConfirmation.run(rollbackId, rollbackId, rollbackId, "rollback-uid", "ha.calendar_sync", JSON.stringify({
      entity_id: "calendar.household", ...rollback,
    }))
    await page.route("**/api/ha/events?*", route => route.fulfill({ json: { events: [
      { uid: "rollback-uid", summary: "Linked rollback feed entry", ...rollback },
      { uid: "live-rollback-uid", summary: "Live rollback appointment", ...rollback },
    ] } }))
    await page.goto(base + "/tasks?view=calendar&year=2010&month=10#calendar")
    await expect(page.locator("#calendar-signal-summary")).toContainText("1 synced event")
    for (const date of ["2010-11-06", "2010-11-07"]) {
      const cell = page.locator(`.cal-cell[data-date="${date}"]`)
      await expect(cell).toHaveAccessibleName(/\b1 calendar event\b/)
      await cell.press("Enter")
      await expect(connected.getByRole("button", { name: /Saved rollback appointment/ })).toBeVisible()
      await expect(connected.getByText("Live rollback appointment")).toBeVisible()
      await expect(connected.getByText("Linked rollback feed entry")).toHaveCount(0)
      await page.keyboard.press("Escape")
    }

    // Force each query to fail in isolation in this disposable database.
    const localId = "local-agenda-recovery"
    insert.run(localId, "Local agenda recovery task", localId, localId, linkedDay, 100_010, 100_010)
    liveAvailable = true
    await page.unroute("**/api/ha/events?*")
    await page.route("**/api/ha/events?*", route => route.fulfill({ json: { events: [
      { summary: "Available live feed", start: linkedDay },
    ] } }))
    await page.goto(unfilteredMonth)
    await expect(page.locator("#calendar-shell")).toHaveAttribute("data-calendar-ready", "true")
    db.exec("ALTER TABLE calendar_confirmations RENAME TO unavailable_calendar_confirmations")
    try {
      await linkedCell.press("Enter")
      await expect(agenda.getByRole("button", { name: /Local agenda recovery task/ })).toBeVisible()
      await expect(connected.getByText("Available live feed")).toBeVisible()
      await expect(connected.getByText("Saved calendar links couldn’t load. Reopen the day to retry.")).toBeVisible()
      await expect(page.getByRole("button", { name: "Retry agenda" })).toBeHidden()
      await page.keyboard.press("Escape")
    } finally {
      db.exec("ALTER TABLE unavailable_calendar_confirmations RENAME TO calendar_confirmations")
    }

    db.exec("ALTER TABLE tasks RENAME COLUMN description TO unavailable_description")
    try {
      await linkedCell.press("Enter")
      await expect(agenda.getByText("Couldn’t load this day’s agenda.")).toBeVisible()
      await expect(connected.getByRole("button", { name: /Linked calendar retreat/ })).toBeVisible()
      await expect(connected.getByText("Available live feed")).toBeVisible()
      await expect(connected.getByText("Saved calendar links couldn’t load", { exact: false })).toHaveCount(0)
    } finally {
      db.exec("ALTER TABLE tasks RENAME COLUMN unavailable_description TO description")
    }
    await page.getByRole("button", { name: "Retry agenda" }).press("Enter")
    await expect(agenda.getByRole("button", { name: /Local agenda recovery task/ })).toBeVisible()
    await expect(connected.getByRole("button", { name: /Linked calendar retreat/ })).toBeVisible()
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
