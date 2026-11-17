import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Area changes update the Kanban groups and preserve the board context through Details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "meitheal-kanban-area-edit-"))
  const fixture = startCoreFixture(directory)
  fixture.stdout?.resume()
  fixture.stderr?.resume()
  let browser
  let releasePending: (() => void) | undefined

  try {
    const [{ port, configuredPath }] = await once(fixture, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${port}`
    const app = origin + configuredPath
    const headers = { origin, "sec-fetch-site": "same-origin" }
    browser = await launchPinBrowser(directory)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    page.setDefaultTimeout(5_000)
    expect((await page.goto(app + "/fixture"))?.ok()).toBe(true)

    async function create(path: string, data: object) {
      const response = await context.request.post(app + path, { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      return (await response.json() as { id: string }).id
    }

    const original = await create("/api/areas", { name: "Workshop" })
    const destination = await create("/api/areas", { name: "Utility room" })
    const task = await create("/api/tasks", { title: "Area edit fixture first task", area_id: original, status: "pending" })
    const other = await create("/api/tasks", { title: "Area edit fixture second task", area_id: original, status: "pending" })
    const boardUrl = (area: string) => `${app}/tasks?area=${area}&groupBy=area&search=Area+edit+fixture#kanban`
    const api = `${app}/api/tasks/${task}`
    const catalog = app + "/api/areas"
    const board = page.locator("#kanban-board")
    const drawer = page.locator("#task-detail-overlay")
    const select = drawer.getByLabel("Area", { exact: true })
    const close = drawer.getByRole("button", { name: "Close detail", exact: true })
    const group = (area: string) => board.locator(`.swimlane-group[data-swimlane-type="${area}"]`)
    const card = (id: string) => board.locator(`.kanban-card[data-id="${id}"] .card-open-btn`)
    const savedValue = (area: string) => expect(select).toHaveValue(area)

    async function holdMove(area: string) {
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const release = new Promise<void>(resolve => { releasePending = resolve })
      await page.route(api, async route => {
        if (route.request().method() !== "PUT") return route.continue()
        expect(route.request().postDataJSON()).toMatchObject({ area_id: area })
        entered()
        await release
        await route.continue()
      })
      const response = page.waitForResponse(res => res.url() === api && res.request().method() === "PUT")
      await select.selectOption(area)
      await started
      await expect(select).toBeDisabled()
      return async () => {
        releasePending?.()
        expect((await response).ok()).toBe(true)
        await page.unroute(api)
      }
    }

    await page.goto(boardUrl(""))
    await expect(group(original).locator(`.kanban-card[data-id="${task}"]`)).toBeVisible()
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

    let catalogEntered!: () => void
    const catalogStarted = new Promise<void>(resolve => { catalogEntered = resolve })
    const releaseCatalog = new Promise<void>(resolve => { releasePending = resolve })
    await page.route(catalog, async route => {
      catalogEntered()
      await releaseCatalog
      await route.continue()
    }, { times: 1 })
    await card(task).click()
    await catalogStarted
    await expect(select).toBeDisabled()
    releasePending?.()
    await expect(select).toBeEnabled()
    await savedValue(original)

    await page.route(api, route => route.request().method() === "PUT"
      ? route.fulfill({ status: 409, json: { error: "fixture rejects stale write" } })
      : route.continue())
    await select.focus()
    await select.selectOption(destination)
    await savedValue(original)
    await expect(select).toBeEnabled()
    await expect(select).toBeFocused()
    await page.unroute(api)

    const saved = page.waitForResponse(res => res.url() === api && res.request().method() === "PUT")
    await select.selectOption(destination)
    expect((await saved).ok()).toBe(true)
    await expect(select).toBeEnabled()
    await close.click()
    await expect(group(destination).locator(`.kanban-card[data-id="${task}"]`)).toBeVisible()
    await expect(card(task)).toBeFocused()

    await card(task).click()
    await savedValue(destination)
    const lateReturn = await holdMove(original)
    await close.click()
    await expect(drawer).toBeHidden()
    const grouping = page.locator("#kanban-group-by-dropdown > summary")
    await grouping.focus()
    await lateReturn()
    await expect(group(original).locator(`.kanban-card[data-id="${task}"]`)).toBeVisible()
    await expect(grouping).toBeFocused()

    // A different drawer can open while a previous task's save is still pending.
    await card(task).click()
    const anotherDrawer = await holdMove(destination)
    await close.click()
    await expect(drawer).toBeHidden()
    await card(other).click()
    await savedValue(original)
    await anotherDrawer()
    await expect(group(destination).locator(`.kanban-card[data-id="${task}"]`)).toBeAttached()
    await savedValue(original)
    await expect(drawer.locator("#td-title")).toHaveValue("Area edit fixture second task")
    await close.click()
    await expect(card(other)).toBeFocused()

    await page.goto(boardUrl(destination))
    await expect(card(task)).toBeVisible()
    const rememberedArea = () => page.evaluate(() => localStorage.getItem("meitheal-selected-area"))
    const remembered = await rememberedArea()
    await card(task).click()
    const lateReopen = await holdMove(original)
    await close.click()
    await expect(drawer).toBeHidden()
    const oldAreaRead = page.waitForResponse(res => res.url() === api && res.request().method() === "GET")
    await card(task).click()
    expect((await (await oldAreaRead).json()).area_id).toBe(destination)
    await expect(select).toBeDisabled()
    await lateReopen()
    await savedValue(original)
    await expect(select).toBeEnabled()
    await close.click()
    await expect(card(task)).toHaveCount(0)
    await expect(board.locator('.kanban-column[data-status="pending"] .kanban-column-header')).toBeFocused()
    await expect(page).toHaveURL(url => url.searchParams.get("area") === destination && url.searchParams.get("groupBy") === "area")
    await expect(page.locator(`#area-selector-dropdown [data-area-id="${destination}"]`)).toHaveAttribute("aria-selected", "true")
    expect(await rememberedArea()).toBe(remembered)

    await page.goto(boardUrl(""))
    await expect(card(task)).toBeVisible()
    await page.evaluate(() => history.pushState(history.state, "", location.href))
    await page.keyboard.press("Control+k")
    await page.getByRole("tab", { name: "Tasks" }).click()
    const search = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
    await search.fill("Area edit fixture first task")
    await page.getByRole("option", { name: /Area edit fixture first task/ }).click()
    const searchWrite = await holdMove(destination)
    await page.goBack()
    await expect(drawer).toBeHidden()
    await card(other).click()
    await savedValue(original)
    const drawerRefreshes: string[] = []
    page.on("request", req => {
      if (new URL(req.url()).searchParams.has("boardRefresh")) drawerRefreshes.push(req.url())
    })
    await searchWrite()
    await expect(group(destination).locator(`.kanban-card[data-id="${task}"]`)).toBeAttached()
    await savedValue(original)
    expect(drawerRefreshes).toHaveLength(1)
    await close.click()

    await card(task).click()
    await savedValue(destination)
    await close.click()
    await expect(drawer).toBeHidden()
    await page.route(catalog, route => route.fulfill({ status: 503, json: {} }), { times: 1 })
    await card(other).click()
    await expect(select.locator("option")).toHaveText(["Areas could not load"])
    await expect(select).toBeDisabled()
    await close.click()
    await expect(drawer).toBeHidden()

    expect((await context.request.delete(app + "/api/areas/" + original, { headers })).ok()).toBe(true)
    await card(other).click()
    await expect(select.locator("option:checked")).toHaveText("Unavailable Area")
    await expect(select.locator("option:checked")).toBeDisabled()
    await expect(select).toBeEnabled()
  } finally {
    releasePending?.()
    await browser?.close()
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, "exit", { signal: AbortSignal.timeout(3_000) })
      fixture.kill("SIGKILL")
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
})
