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
  const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
  await context.setExtraHTTPHeaders({})
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("response", response => {
    if (response.url().includes("due_date") || response.status() >= 400) {
      pageErrors.push(`${response.status()} ${response.url()}`)
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

    const query = new URLSearchParams({ due_date: date, calendar_filters: "search=matching+garden", limit: "100" })
    const first = await api.get(base + "/api/tasks?" + query, { headers: headers("member") })
    expect(first.status()).toBe(200)
    const { tasks, total } = await first.json()
    expect(total).toBe(101)
    expect(tasks).toHaveLength(100)
    expect(tasks[0].title).toBe("Matching garden task 100")
    expect(tasks[99].title).toBe("Matching garden task 1")
    query.set("offset", "100")
    const second = await api.get(base + "/api/tasks?" + query, { headers: headers("member") })
    expect(await second.json()).toMatchObject({ tasks: [{ title: "Matching garden task 0" }], total: 101 })

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
