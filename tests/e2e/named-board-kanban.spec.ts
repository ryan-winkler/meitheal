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
  test.setTimeout(90_000)
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
    expect((await owner.request.post(app + "/api/areas", { headers, data: { name: "Household only Area" } })).status()).toBe(201)
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
    await expect(page.locator('[data-named-inspector-create] input[name="areaId"]')).toHaveValue(namedArea)
    await page.locator("#td-close").click()
    await page.locator("#area-selector-trigger").click()
    await page.getByRole("option", { name: "All Areas", exact: true }).click()
    await expect(page.locator(".kanban-card")).toHaveCount(25)
    await expect(page.locator(".kanban-column[data-status=pending] .kanban-count")).toHaveText("56")
    await page.locator(".kanban-pagination").getByRole("link", { name: /Next/ }).click()
    await expect(page.locator(".kanban-card")).toHaveCount(25)
    await page.locator(".kanban-pagination").getByRole("link", { name: /Next/ }).click()
    await expect(page.locator(".kanban-card")).toHaveCount(6)
    await page.goto(app + path + "?search=Needle")
    const oldest = page.locator(`.kanban-card[data-id="${ids[0]}"]`)
    await expect(oldest).toBeVisible()
    await expect(page.locator(".kanban-card")).toHaveCount(1)
    const leaks: string[] = []
    page.on("request", request => { if (new URL(request.url()).pathname.includes("/api/tasks/" + ids[0])) leaks.push(request.url()) })
    await oldest.locator(".card-open-btn").press("Enter")
    const inspector = page.getByRole("dialog", { name: "Task detail", exact: true })
    await expect(inspector).toBeVisible()
    const edit = inspector.locator('form[data-board-form="task-edit"]:visible')
    await edit.getByRole("textbox", { name: "Title", exact: true }).fill("Retained conflict draft")
    const version = Number(await oldest.getAttribute("data-version"))
    expect((await owner.request.patch(api + "/tickets/" + ids[0], { headers, data: { title: "Newer server title", description: "Needle", version } })).status()).toBe(200)
    const conflict = page.waitForResponse(response => response.url().endsWith("/tickets/" + ids[0]) && response.request().method() === "PATCH")
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    expect((await conflict).status()).toBe(409)
    await expect(edit.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Retained conflict draft")
    await expect(edit.locator("[data-board-feedback]")).toContainText("changed")
    expect(leaks).toEqual([])
    expect(pageErrors).toEqual([])
    await page.goto(app + path)
    await page.locator("#kanban-bar-new-task").click()
    const capture = page.locator("[data-named-inspector-create]")
    await capture.getByRole("textbox", { name: "Title", exact: true }).fill("A new scoped capture")
    await capture.getByRole("button", { name: "Create task", exact: true }).click()
    const captureCard = page.locator(".kanban-card").filter({ hasText: "A new scoped capture" })
    await expect(captureCard).toBeVisible()
    const captureId = await captureCard.getAttribute("data-id")
    const activeLane = page.locator('.kanban-column[data-status="active"]')
    await page.route(api + "/tickets/" + captureId, route => route.fulfill({ status: 409, json: { error: "Refresh the Board fixture" } }), { times: 1 })
    await captureCard.dragTo(activeLane.locator(".kanban-column-header"))
    await expect(page.locator("[data-named-kanban-feedback]")).toHaveText("Refresh the Board fixture")
    await expect(captureCard).toHaveAttribute("data-status", "pending")
    await captureCard.dragTo(activeLane.locator(".kanban-column-header"))
    await expect(captureCard).toHaveAttribute("data-status", "active")
    expect((await owner.request.post(api + "/planning", { headers, data: {
      action: "project", title: "Named planning Project", areaId: namedArea, goalId: null,
    } })).status()).toBe(200)
    const planning = await (await owner.request.get(api)).json()
    const namedProject = planning.planning.projects.find((project: { title: string }) => project.title === "Named planning Project").id
    const householdPosts: string[] = []
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/api/tasks")) householdPosts.push(request.url()) })
    for (const scope of ["", `area=${namedArea}&`, `project=${namedProject}&`]) {
      await page.goto(app + path + "?" + scope + "view=groups")
      await expect(page.locator("#new-task-overlay")).toHaveCount(0)
      await page.locator("#sidebar-rail-new-task").click()
      await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
      await expect(page.locator('[data-named-inspector-create] input[name="projectId"]')).toHaveValue(scope.startsWith("project") ? namedProject : "")
      if (scope.startsWith("project")) {
        await page.locator("[data-named-inspector-create]").getByRole("textbox", { name: "Title", exact: true }).fill("Planning scope capture")
        const savedPlanning = page.waitForResponse(response => response.request().method() === "POST" && response.url() === api + "/tickets").then(response => response.json())
        await page.locator("[data-named-inspector-create]").getByRole("button", { name: "Create task", exact: true }).click()
        const ticket = await savedPlanning
        const placed = await (await owner.request.get(api + "?view=tasks&ticket=" + ticket.id)).json()
        expect(placed.tasks[0].placement).toMatchObject({ areaId: namedArea, projectId: namedProject })
      } else await page.locator("#td-close").click()
    }
    expect(householdPosts).toEqual([])
    const member = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await member.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    const childPage = await member.newPage()
    childPage.setDefaultTimeout(8_000)
    await childPage.goto(app + path + "?search=Needle")
    await childPage.locator(".kanban-card .card-open-btn").press("Enter")
    const childInspector = childPage.getByRole("dialog", { name: "Task detail", exact: true })
    await expect(childInspector).toBeVisible()
    await expect(childInspector.getByRole("button", { name: "Delete task", exact: true })).toHaveCount(0)
    const move = childInspector.locator('form[data-board-form="task-move"]:visible')
    await expect(move.locator("option").filter({ hasText: "Done" })).toHaveCount(0)
    await expect(move.getByRole("button", { name: "Move", exact: true })).toBeVisible()
    await move.getByLabel("Move to").focus()
    await move.getByLabel("Move to").press("ArrowDown")
    await move.getByRole("button", { name: "Move", exact: true }).press("Enter")
    await expect(childPage.locator(".kanban-card")).toHaveAttribute("data-status", "active")
    await childPage.locator(".kanban-card .card-open-btn").press("Enter")
    await expect(childInspector).toBeVisible()
    const childDirectory = await member.request.get(app + "/api/boards")
    const childHeaders = { origin, "x-meitheal-board-session": childDirectory.headers()["x-meitheal-board-session"]! }
    const current = await (await member.request.get(api + "?view=tasks&ticket=" + ids[0])).json()
    expect((await member.request.delete(api + "/tickets/" + ids[0], { headers: childHeaders, data: { version: current.tasks[0].version } })).status()).toBe(403)
    expect((await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: null } })).status()).toBe(200)
    await childPage.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(childPage.locator("[data-board-expired]")).toBeVisible()
    await expect(childPage.locator(".kanban-card, #task-detail-overlay")).toHaveCount(0)
    await expect(childPage.getByText("Private details", { exact: true })).toHaveCount(0)
    expect(await childPage.evaluate(() => document.body.style.overflow)).toBe("")
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
