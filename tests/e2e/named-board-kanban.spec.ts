import { DatabaseSync } from "node:sqlite"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built app")

test("named Boards use the common Kanban with paged capture, version conflicts, child restrictions and private inspector revocation", async () => {
  test.setTimeout(150_000)
  const work = await mkdtemp(join(tmpdir(), "named-kanban-"))
  const fixtureProcess = startCoreFixture(work, false, undefined, undefined, work)
  fixtureProcess.stdout?.resume()
  fixtureProcess.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(fixtureProcess, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const owner = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, viewport: { width: 1240, height: 820 } })
    await owner.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const directory = await owner.request.get(app + "/api/boards")
    const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
    const created = await owner.request.post(app + "/api/boards", { headers, data: { name: "Private shared Kanban" } })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json()
    const path = `/boards/${id}`
    const api = app + "/api" + path
    expect((await owner.request.post(api + "/planning", { headers, data: { action: "area", title: "Named only Area" } })).status()).toBe(200)
    const householdAreaResponse = await owner.request.post(app + "/api/areas", { headers, data: { name: "Household only Area" } })
    expect(householdAreaResponse.status()).toBe(201)
    const householdArea = await householdAreaResponse.json()
    expect((await owner.request.post(app + "/api/projects", { headers, data: { title: "Household shortcut trap", area_id: householdArea.id } })).status()).toBe(201)
    const namedCatalog = await (await owner.request.get(api + "?view=groups")).json()
    const namedArea = namedCatalog.items.find((area: { name: string }) => area.name === "Named only Area").id
    const ids: string[] = []
    for (let index = 0; index < 56; index++) {
      const response = await owner.request.post(api + "/tickets", { headers, data: {
        title: `Scoped work ${index}`, description: index === 0 ? "Needle in oldest description" : "Private details", placement: {},
      } })
      expect(response.status(), await response.text()).toBe(201)
      ids.push((await response.json()).id)
    }
    expect((await owner.request.patch(api, { headers, data: {
      action: "member", memberId: "fixture-member-two", role: "member", denyCompletion: true, denyDeletion: true,
    } })).status()).toBe(200)
    const page = await owner.newPage()
    const pageErrors: string[] = []
    page.on("pageerror", error => pageErrors.push(error.message))
    page.setDefaultTimeout(8_000)
    await page.goto(app + path)
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await expect(page.locator(".kanban-card")).toHaveCount(25)
    await expect(page.locator(".board-columns")).toHaveCount(0)
    const entries = page.locator(".kanban-card .card-open-btn")
    await entries.first().focus()
    await entries.first().press("ArrowDown")
    await expect(entries.nth(1)).toBeFocused()
    await entries.nth(1).press("n")
    const pending = page.locator('.kanban-column[data-status="pending"]')
    const inlineCapture = pending.locator(".kanban-inline-add")
    await expect(inlineCapture.locator("input")).toBeFocused()
    await expect(page.locator("[data-task-workspace][data-board-id]")).toHaveAttribute("data-board-id", id)
    await expect(page).toHaveURL(url => url.pathname === fixture.configuredPath + path)
    await inlineCapture.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(inlineCapture).toHaveCount(0)
    await page.locator("#area-selector-trigger").click()
    await expect(page.getByRole("option", { name: "Named only Area", exact: true })).toBeVisible()
    await expect(page.getByRole("option", { name: "Household only Area", exact: true })).toHaveCount(0)
    await page.getByRole("option", { name: "Named only Area", exact: true }).click()
    await expect(page).toHaveURL(new RegExp("area=" + namedArea))
    await expect(page.locator(".kanban-card")).toHaveCount(0)
    await page.goto(app + path)
    await expect(page).toHaveURL(url => url.searchParams.get("area") === namedArea)
    await expect(page.locator(".kanban-card")).toHaveCount(0)
    await page.locator("#kanban-bar-new-task").click()
    const scopedCreate = page.locator("#new-task-overlay")
    const scopedTitle = scopedCreate.locator("#new-task-title-input")
    await expect(scopedTitle).toBeFocused()
    const captureUrl = app + "/api/tasks"
    await page.route(captureUrl, route => route.fulfill({ status: 400, json: { error: "Fixture stops before writing" } }), { times: 1 })
    const scopedRequest = page.waitForRequest(request => request.method() === "POST" && request.url() === captureUrl)
    await scopedTitle.fill("Scope inspection")
    await scopedCreate.locator("#submit-new-task-btn").click()
    const attempt = await scopedRequest
    expect(attempt.headers()["x-meitheal-board-id"]).toBe(id)
    expect(attempt.postDataJSON()).toMatchObject({ placement: { areaId: namedArea, projectId: null } })
    await expect(scopedCreate.locator("#submit-new-task-btn")).toBeEnabled()
    await scopedTitle.fill("")
    await scopedCreate.locator("#cancel-new-task").click()
    await page.locator("#area-selector-trigger").click()
    await page.getByRole("option", { name: "All Areas", exact: true }).click()
    await expect(page.locator(".kanban-card")).toHaveCount(25)
    await expect(page.locator(".kanban-column[data-status=pending] .kanban-count")).toHaveText("56")
    const cards = page.locator(".kanban-card")
    const firstPageHead = (await cards.first().getAttribute("data-id"))!
    const next = page.locator(".kanban-pagination").getByRole("link", { name: /Next/ })
    await next.click()
    await expect(cards.first()).not.toHaveAttribute("data-id", firstPageHead)
    await expect(cards).toHaveCount(25)
    await expect(page).toHaveURL(url => url.pathname === fixture.configuredPath + path)
    await next.click()
    await expect(cards).toHaveCount(6)
    await expect(page).toHaveURL(url => url.pathname === fixture.configuredPath + path)
    await page.goto(app + path + "?search=Needle")
    const oldest = page.locator(`.kanban-card[data-id="${ids[0]}"]`)
    await expect(oldest).toBeVisible()
    await expect(page.locator(".kanban-card")).toHaveCount(1)
    const leaks: string[] = []
    const taskUrl = app + "/api/tasks/" + ids[0]
    page.on("request", request => {
      if (new URL(request.url()).pathname === new URL(taskUrl).pathname &&
          request.headers()["x-meitheal-board-id"] !== id) leaks.push(request.url())
    })
    await oldest.locator(".card-open-btn").press("Enter")
    const inspector = page.locator("#task-detail-panel")
    const detailTitle = inspector.locator("#td-title")
    await expect(detailTitle).toBeEditable()
    const version = (await (await owner.request.get(api + "?view=tasks&ticket=" + ids[0])).json()).tasks[0].version
    await detailTitle.fill("Retained conflict draft")
    expect((await owner.request.patch(api + "/tickets/" + ids[0], { headers, data: { title: "Newer server title", description: "Needle", version } })).status()).toBe(200)
    const conflict = page.waitForResponse(response => response.url() === taskUrl && response.request().method() === "PUT")
    await detailTitle.press("Tab")
    expect((await conflict).status()).toBe(409)
    await expect(detailTitle).toHaveValue("Retained conflict draft")
    await expect(inspector.locator("#td-write-conflict")).toBeVisible()
    expect(leaks).toEqual([])
    // Two verification polls must preserve a safe draft after a version conflict.
    await page.waitForTimeout(21_000)
    await expect(inspector).toBeVisible()
    await expect(detailTitle).toHaveValue("Retained conflict draft")
    await expect(inspector.locator("#td-write-conflict")).toBeVisible()
    await expect(page.locator("[data-layout-board-expired]")).toBeHidden()
    expect(pageErrors).toEqual([])
    await page.goto(app + path)
    await page.locator("#kanban-bar-new-task").click()
    const capture = page.locator("#new-task-overlay")
    await expect(capture.locator("#new-task-title-input")).toBeFocused()
    await capture.locator("#new-task-title-input").fill("A new scoped capture")
    const posted = page.waitForResponse(response => response.url() === captureUrl && response.request().method() === "POST")
    await capture.locator("#submit-new-task-btn").click()
    const createResponse = await posted
    expect(createResponse.status()).toBe(201)
    expect(createResponse.request().headers()["x-meitheal-board-id"]).toBe(id)
    const captureId = (await createResponse.json()).id
    const capturedInspector = page.locator("#task-detail-overlay")
    await expect(capturedInspector.locator("#td-title")).toHaveValue("A new scoped capture")
    await capturedInspector.locator("#td-close").click()
    await expect(capturedInspector).toBeHidden()
    const captureCard = page.locator(`.kanban-card[data-id="${captureId}"]`)
    await expect(captureCard).toBeVisible()
    const activeLane = page.locator('.kanban-column[data-status="active"]')
    const movingPath = app + "/api/tasks/" + captureId
    let rejectMove = true
    await page.route(movingPath, route => {
      if (route.request().method() !== "PUT" || !rejectMove) return route.fallback()
      rejectMove = false
      return route.fulfill({ status: 409, json: { error: "Refresh the Board fixture" } })
    })
    const drop = () => captureCard.dragTo(activeLane.locator(".kanban-column-header"), { sourcePosition: { x: 100, y: 35 } })
    await drop()
    await expect(page.getByText("Couldn’t move the task. Try again.", { exact: true })).toBeVisible()
    await expect(captureCard).toHaveAttribute("data-status", "pending")
    await drop()
    await expect(captureCard).toHaveAttribute("data-status", "active")
    expect((await owner.request.post(api + "/planning", { headers, data: {
      action: "project", title: "Named planning Project", areaId: namedArea, goalId: null,
    } })).status()).toBe(200)
    const planning = await (await owner.request.get(api)).json()
    const namedProject = planning.planning.projects.find((project: { title: string }) => project.title === "Named planning Project").id
    const createScopes = [
      { query: "", areaId: null, projectId: null },
      { query: `area=${namedArea}&`, areaId: namedArea, projectId: null },
      { query: `project=${namedProject}&`, areaId: namedArea, projectId: namedProject },
    ]
    for (const [index, scope] of createScopes.entries()) {
      await page.goto(app + path + "?" + scope.query + "view=groups")
      await expect(capture).toBeHidden()
      if (scope.projectId) await page.keyboard.press("n")
      else await page.locator("#sidebar-rail-new-task").click()
      await expect(capture.locator("#new-task-title-input")).toBeFocused()
      await capture.locator("#new-task-title-input").fill("Planning scope capture " + index)
      const previousDocument = await page.evaluate(() => performance.timeOrigin)
      const savedPlanning = page.waitForResponse(response => response.request().method() === "POST" && response.url() === captureUrl)
      const refreshedPlanning = page.waitForResponse(response => {
        const url = new URL(response.url())
        return response.request().isNavigationRequest() && url.pathname === fixture.configuredPath + path && url.searchParams.has("open")
      })
      await capture.locator("#submit-new-task-btn").click()
      const response = await savedPlanning
      expect(response.status()).toBe(201)
      expect(response.request().headers()["x-meitheal-board-id"]).toBe(id)
      const { id: savedTicket, ticket_key: savedKey } = await response.json()
      const refresh = await refreshedPlanning
      expect(refresh.status()).toBe(200)
      expect(new URL(refresh.url()).searchParams.get("open")).toBe(savedTicket)
      await page.waitForFunction(start => performance.timeOrigin !== start, previousDocument)
      await expect(page).toHaveURL(
        url => url.searchParams.get("open") === savedTicket || url.pathname === fixture.configuredPath + "/tickets/" + savedKey,
      )
      await page.waitForLoadState("load")
      const placed = await (await owner.request.get(api + "?view=tasks&ticket=" + savedTicket)).json()
      expect(placed.tasks[0].placement).toMatchObject({ areaId: scope.areaId, projectId: scope.projectId })
    }
    const member = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await member.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    const childPage = await member.newPage()
    childPage.setDefaultTimeout(8_000)
    await childPage.goto(app + path + "?search=Needle")
    await childPage.locator(".kanban-card .card-open-btn").press("Enter")
    const childInspector = childPage.locator("#task-detail-panel")
    await expect(childInspector).toBeVisible()
    const childDirectory = await member.request.get(app + "/api/boards")
    const childHeaders = {
      origin, "x-meitheal-board-session": childDirectory.headers()["x-meitheal-board-session"]!,
      "x-meitheal-board-id": id,
    }
    const actions = await member.request.get(taskUrl, { headers: childHeaders })
    expect(actions.ok()).toBe(true)
    expect((await actions.json()).actions).toEqual(["edit"])
    const current = await (await member.request.get(api + "?view=tasks&ticket=" + ids[0])).json()
    const deniedCompletion = await member.request.put(taskUrl, {
      headers: childHeaders, data: { status: "complete", updated_at: current.tasks[0].version },
    })
    expect(deniedCompletion.status(), await deniedCompletion.text()).toBe(403)
    const deniedDeletion = await member.request.delete(api + "/tickets/" + ids[0], {
      headers: childHeaders, data: { version: current.tasks[0].version },
    })
    expect(deniedDeletion.status(), await deniedDeletion.text()).toBe(403)
    await expect.soft(childInspector.locator("#td-delete")).toBeHidden()
    await expect.soft(childInspector.locator("#td-toggle-done")).toBeHidden()
    const move = childInspector.locator("#td-status")
    await expect.soft(move.locator('option[value="complete"]:not([disabled])')).toHaveCount(0)
    await expect(move).toBeEnabled()
    const moved = childPage.waitForResponse(response => response.url() === taskUrl && response.request().method() === "PUT")
    await move.focus()
    await move.press("ArrowDown")
    expect((await moved).status()).toBe(200)
    await expect(move).toHaveValue("active")
    await expect(childInspector).toBeVisible()
    expect((await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: null } })).status()).toBe(200)
    await childPage.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(childPage.locator("[data-board-expired]")).toBeVisible()
    await expect(childPage.locator(".kanban-card")).toHaveCount(0)
    await expect(childInspector).toHaveCount(0)
    await expect(childPage.getByText("Private details", { exact: true })).toHaveCount(0)
    expect(await childPage.evaluate(() => document.body.style.overflow)).toBe("")
    expect((await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: "viewer" } })).status()).toBe(200)
    await childPage.goto(app + path + "?search=Needle")
    await childPage.locator(".kanban-card .card-open-btn").press("n")
    await expect(childPage.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await expect(childPage.locator("#sidebar-rail-new-task")).toBeDisabled()
    await expect(childPage).toHaveURL(url => url.pathname.endsWith(path))
    await childPage.locator(".kanban-card .card-open-btn").press("Enter")
    const viewerTitle = childPage.locator("#td-title")
    await expect(viewerTitle).toHaveValue("Newer server title")
    await expect(viewerTitle).not.toBeEditable()
    // The extracted Astro component must preserve a failed refresh's HTTP status.
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      db.prepare("UPDATE kanban_lanes SET includes = 'invalid-json' WHERE board_id = 'household' AND key = 'pending'").run()
      const failedRefresh = await owner.request.get(app + "/tasks?view=table&lane=lane-pending&tableRefresh=fixture-failure")
      expect(failedRefresh.status(), await failedRefresh.text()).toBe(503)
      expect(failedRefresh.headers()["cache-control"]).toContain("no-store")
    } finally { db.close() }
  } finally {
    await browser?.close()
    if (fixtureProcess.exitCode === null && fixtureProcess.signalCode === null) {
      const exited = once(fixtureProcess, "exit", { signal: AbortSignal.timeout(3_000) })
      fixtureProcess.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
