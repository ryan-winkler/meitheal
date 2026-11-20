import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires an isolated built App and HTTPS ingress fixture")

test("compact workspace headers preserve ingress navigation and distinguish unavailable data", async () => {
  test.setTimeout(45_000)
  const work = await mkdtemp(join(tmpdir(), "meitheal-workspace-headers-"))
  const withFixtureDb = (write: (db: DatabaseSync) => void) => {
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      db.exec("PRAGMA busy_timeout=3000")
      write(db)
    } finally {
      db.close()
    }
  }
  let browser
  let child: ReturnType<typeof startCoreFixture> | undefined
  try {
    child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {}, viewport: { width: 1440, height: 950 }, reducedMotion: "reduce", serviceWorkers: "block",
    })
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const boardHeaders = await currentBoardWriteHeaders(context.request, "household", {}, app)
    const page = await context.newPage()
    await page.addInitScript(() => {
      const scroll = Element.prototype.scrollIntoView
      Element.prototype.scrollIntoView = function (options) {
        this.setAttribute("data-fixture-scroll", typeof options === "object" ? options.behavior ?? "auto" : "auto")
        scroll.call(this, options)
      }
    })

    for (const [path, id, section] of [["/", "dashboard", "capture"], ["/habits", "habits", "library"], ["/upcoming", "upcoming", "next"]] as const) {
      await page.goto(`${app}${path}#${id}-overview`)
      await page.waitForLoadState("networkidle")
      const tab = (name: string) => page.locator(`#${id}-bar-tabs [data-unified-bar-section="${id}-${name}"]`)
      await expect(tab("overview")).toHaveClass(/is-active/)
      await tab(section).press("Enter")
      await expect(page).toHaveURL(new RegExp(`#${id}-${section}$`))
      await expect(tab(section)).toHaveClass(/is-active/)
      await expect(tab(section)).toBeFocused()
      await expect(page.locator(`#${id}-${section}`)).toHaveAttribute("data-fixture-scroll", "auto")
      await expect(page.locator(`#${id}-${section}`)).not.toHaveClass(/--flash/)
    }
    await expect(page.getByText("No upcoming tasks", { exact: true })).toBeVisible()

    for (const [path, id, section] of [["/", "dashboard", "capture"], ["/habits", "habits", "library"]] as const) {
      const scrollPage = await context.newPage()
      await scrollPage.setViewportSize({ width: 375, height: 360 })
      await scrollPage.goto(app + path)
      await scrollPage.waitForLoadState("networkidle")
      const tab = (name: string) => scrollPage.locator(`#${id}-bar-tabs [data-unified-bar-section="${id}-${name}"]`)
      const backToTop = scrollPage.getByRole("button", { name: "Scroll to top", includeHidden: true })
      await expect(tab("overview")).toHaveClass(/is-active/)
      await expect(backToTop).toBeHidden()
      await scrollPage.mouse.move(300, 380)
      await scrollPage.mouse.wheel(0, 950)
      await expect(tab("overview")).not.toHaveClass(/is-active/)
      await expect(backToTop).toBeVisible()
      await scrollPage.reload({ waitUntil: "networkidle" })
      await expect(backToTop).toBeVisible()
      await expect(tab("overview")).not.toHaveClass(/is-active/)
      await backToTop.click()
      await expect.poll(() => scrollPage.evaluate(() => window.scrollY)).toBe(0)
      await expect(tab("overview")).toHaveClass(/is-active/)
      await expect(backToTop).toBeHidden()

      await scrollPage.goto(`${app}${path}#${id}-${section}`)
      await expect(tab(section)).toHaveClass(/is-active/)
      await scrollPage.mouse.wheel(0, -2000)
      await expect.poll(() => scrollPage.evaluate(() => window.scrollY)).toBe(0)
      await expect(tab("overview")).toHaveClass(/is-active/)
      await expect(scrollPage).toHaveURL(new RegExp(`#${id}-${section}$`))
      await scrollPage.close()
    }

    const upcoming = await context.newPage()
    await upcoming.setViewportSize({ width: 375, height: 350 })
    await upcoming.goto(app + "/upcoming")
    await upcoming.waitForLoadState("networkidle")
    const upcomingOverview = upcoming.locator('#upcoming-bar-tabs [data-unified-bar-section="upcoming-overview"]')
    await expect(upcomingOverview).toHaveClass(/is-active/)
    await upcoming.mouse.move(300, 180)
    await upcoming.mouse.wheel(0, 1100)
    await expect(upcomingOverview).not.toHaveClass(/is-active/)
    await upcoming.close()

    const ids = new Map<string, string>()
    for (const [status, data] of [
      ["active", { title: "Active header fixture", status: "active" }],
      ["overdue", { title: "Overdue header fixture", due_date: "2020-01-01" }],
    ] as const) {
      const response = await pinRequest(page, fixture.configuredPath + "/api/tasks", "POST", data, undefined, boardHeaders)
      expect(response.status).toBe(201)
      ids.set(status, response.body.id)
    }
    withFixtureDb(db => {
      db.prepare("INSERT OR REPLACE INTO gamification_stats (date, board_id, completed_count, streak_count, points) VALUES (?, 'household', 1, 1, 10)")
        .run(new Date().toISOString().slice(0, 10))
    })
    const wideDashboard = await context.newPage()
    await wideDashboard.goto(app + "/")
    const tiles = wideDashboard.locator("#dashboard-overview .stat-card")
    await expect(tiles).toHaveCount(5)
    const achievements = fixture.configuredPath + "/progress?board_id=household#achievements"
    await expect(tiles.first()).toHaveAttribute("href", achievements)
    expect(await tiles.evaluateAll(elements => new Set(elements.map(element => element.getBoundingClientRect().top)).size)).toBe(1)
    await wideDashboard.close()

    for (const [status, excluded] of [["active", "overdue"], ["overdue", "active"]] as const) {
      const dashboard = await context.newPage()
      await dashboard.goto(app + "/#dashboard-overview")
      const link = dashboard.locator("#stat-" + status)
      await link.press("Shift+Tab")
      await dashboard.keyboard.press("Tab")
      await expect(link).toBeFocused()
      await expect(link).toHaveCSS("outline-style", "solid")
      await link.press("Enter")
      const url = new URL(app + "/boards/household?status=" + status)
      await expect(dashboard).toHaveURL(result => result.origin === url.origin && result.pathname === url.pathname && result.search === url.search)
      await expect(dashboard.locator(`.kanban-card[data-id="${ids.get(status)}"]`)).toBeVisible()
      await expect(dashboard.locator(`.kanban-card[data-id="${ids.get(excluded)}"]`)).toHaveCount(0)
      await dashboard.close()
    }

    const alias = "W".repeat(40)
    const labels = fixture.configuredPath + "/api/organization-labels"
    const current = await page.evaluate(async url => (await fetch(url)).json(), labels)
    const saved = await page.evaluate(async ({ url, current, alias }) => (await fetch(url, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...current, forms: { routine: [alias, alias] } }),
    })).status, { url: labels, current, alias })
    expect(saved).toBe(204)
    await page.setViewportSize({ width: 320, height: 780 })
    await page.goto(app + "/habits")
    const switcher = page.locator("#habits-bar-switcher-btn")
    await expect(switcher).toHaveAccessibleName(alias + " — switch section")
    await expect(switcher.locator(".unified-bar__switcher-chevron")).toBeInViewport({ ratio: 1 })
    await expect(page.locator("#habits-bar-new-habit")).toBeInViewport({ ratio: 1 })
    await switcher.press("Enter")
    await expect(page.locator("#habits-bar-switcher-dropdown")).toBeVisible()
    await page.keyboard.press("Escape")
    await page.goto(app + "/habits#habits-library")
    const create = page.locator("#habits-library").getByRole("button", { name: "New " + alias, exact: true })
    await expect(create).toBeVisible()
    const box = await create.boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)

    const partialCounts = await context.newPage()
    withFixtureDb(db => db.exec("ALTER TABLE tasks RENAME COLUMN due_date TO fixture_due_date"))
    try {
      await partialCounts.goto(app + "/")
      // A missing due-date column invalidates the shared scoped task projection.
      // The independent streak remains available while task statistics are withheld.
      await expect(partialCounts.getByText("Task counts couldn’t load.", { exact: false })).toBeVisible()
      await expect(partialCounts.locator("#stat-active")).toHaveCount(0)
      await expect(partialCounts.locator("#stat-overdue")).toHaveCount(0)
      await expect(partialCounts.locator("#dashboard-overview .stat-card")).toHaveAttribute("href", achievements)
    } finally {
      await partialCounts.close()
      withFixtureDb(db => db.exec("ALTER TABLE tasks RENAME COLUMN fixture_due_date TO due_date"))
    }

    withFixtureDb(db => db.prepare("UPDATE tasks SET is_favorite = 1 WHERE id = ?").run(ids.get("active")!))
    const focus = await context.newPage()
    await focus.goto(app + "/#dashboard-open")
    await expect(focus.locator("#my-open-list").getByText("Active header fixture")).toBeVisible()
    await expect(focus.locator("#dashboard-shell")).toHaveAttribute("data-dashboard-booted", "true")
    const refreshFocus = async () => {
      const response = focus.waitForResponse(response => new URL(response.url()).searchParams.has("dashboardQueueRefresh"))
      await focus.evaluate(() => document.dispatchEvent(new CustomEvent("meitheal:task-status-saved", {
        detail: { id: "fixture-refresh", status: "active" },
      })))
      expect((await response).ok()).toBe(true)
    }

    const favorites = focus.locator("#dashboard-favorites")
    await expect(favorites.getByText("Active header fixture")).toBeVisible()
    withFixtureDb(db => {
      db.prepare("UPDATE tasks SET is_favorite = 0 WHERE id = ?").run(ids.get("active")!)
      db.exec("ALTER TABLE tasks RENAME COLUMN assigned_to TO fixture_assigned_to")
    })
    try {
      await refreshFocus()
      await expect(focus.locator("#my-open-empty")).toContainText("Couldn’t refresh open work.")
      // Both queues share the same scoped task projection and retain their last successful read.
      await expect(favorites.getByText("Active header fixture")).toBeVisible()
      await expect(focus.locator("#my-open-list").getByText("Active header fixture")).toBeVisible()
    } finally {
      withFixtureDb(db => db.exec("ALTER TABLE tasks RENAME COLUMN fixture_assigned_to TO assigned_to"))
    }

    withFixtureDb(db => {
      db.exec("ALTER TABLE tasks RENAME TO fixture_tasks_unavailable")
      db.exec("ALTER TABLE task_templates RENAME TO fixture_templates_unavailable")
    })
    await refreshFocus()
    await expect(focus.locator("#my-open-empty")).toContainText("Couldn’t refresh open work.")
    await expect(focus.locator("#my-open-list").getByText("Active header fixture")).toBeVisible()
    for (const [path, description, stats] of [
      ["/#dashboard-overview", "Task counts couldn’t load.", ".stats-grid :is(#stat-active, #stat-overdue, #dashboard-stat-open-count, a[href$='status=complete'])"],
      ["/upcoming#upcoming-week", "Upcoming tasks couldn’t load.", ".page-summary-grid"],
      ["/habits?new=1#habits-rhythm", "Routine counts couldn’t load.", "#habits-stats"],
    ] as const) {
      const failed = await context.newPage()
      expect((await failed.goto(app + path))?.status()).toBe(200)
      await expect(failed.getByRole("status").filter({ hasText: description }).first()).toBeVisible()
      await expect(failed.locator(stats)).toHaveCount(0)
      if (path.startsWith("/#")) {
        await expect(failed.locator("#dashboard-overview .stat-card")).toHaveCount(1)
        await expect(failed.locator("#dashboard-overview .stat-card")).toHaveAttribute("href", achievements)
        await expect(failed.locator("#my-open-count")).toBeHidden()
        await expect(failed.locator("#my-open-empty")).toContainText("Couldn’t refresh open work.")
        await expect(failed.getByText("Recent tasks couldn’t load.", { exact: false })).toBeVisible()
      }
      if (path.startsWith("/upcoming")) {
        await expect(failed.locator("#upcoming-week").getByRole("status")).toContainText(description)
        await expect(failed.getByText("No upcoming tasks", { exact: true })).toHaveCount(0)
      }
      if (path.startsWith("/habits")) {
        await failed.waitForLoadState("networkidle")
        await expect(failed.locator("#habits-library-count")).toHaveCount(0)
        await expect(failed.locator("#habits-library").getByText("Habits couldn’t load right now")).toBeVisible()
        await expect(failed.locator("#habits-library").getByRole("button", { name: "New " + alias, exact: true })).toBeDisabled()
        const toolbarCreate = failed.locator("#habits-bar-new-habit")
        await expect(toolbarCreate).toBeDisabled()
        await expect(toolbarCreate).toHaveAttribute("title", "Refresh the page to retry loading Routines")
        const label = toolbarCreate.locator(".unified-bar__new-task-label")
        await expect(label).toBeInViewport()
        const labelBox = await label.boundingBox()
        if (!labelBox) throw new Error("Missing disabled New Routine label")
        await failed.mouse.click(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2)
        await expect(failed.locator("#habit-modal-overlay")).toBeHidden()
      }
      await failed.close()
    }

    withFixtureDb(db => {
      db.exec("ALTER TABLE fixture_templates_unavailable RENAME TO task_templates")
      db.exec("ALTER TABLE fixture_tasks_unavailable RENAME TO tasks")
    })
    const savedAfterRecovery = await pinRequest(focus, fixture.configuredPath + "/api/tasks", "POST", { title: "Recovered header fixture" }, undefined, boardHeaders)
    expect(savedAfterRecovery.status).toBe(201)
    await refreshFocus()
    await expect(focus.locator("#my-open-list").getByText("Recovered header fixture")).toBeVisible()
    await expect(focus.locator("#my-open-empty")).toBeHidden()
    await expect(favorites).toBeHidden()
  } finally {
    try {
      await browser?.close()
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit")
          child.kill()
          await exited
        }
      } finally {
        await rm(work, { recursive: true, force: true })
      }
    }
  }
})
