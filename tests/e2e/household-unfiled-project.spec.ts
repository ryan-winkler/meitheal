import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Route } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built App")

test("unfiled Projects ignore remembered Areas in every view and stay unfiled through modal, lane and draft capture", async () => {
  test.setTimeout(90_000)
  const work = await mkdtemp(join(tmpdir(), "unfiled-project-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const headers = await currentBoardWriteHeaders(context.request, "household", { origin }, app)
    async function create(path: string, data: object) {
      const response = await context.request.post(app + path, { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      return await response.json()
    }
    const remembered = await create("/api/areas", { name: "Unrelated remembered Area" })
    const goalArea = await create("/api/areas", { name: "Goal metadata Area" })
    const goal = await create("/api/goals", { title: "Legacy Goal", area_id: goalArea.id })
    const projects = [
      await create("/api/projects", { title: "Legacy unfiled Project" }),
      await create("/api/projects", { title: "Goal associated NULL Project", goal_id: goal.id }),
    ]
    const due = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
    for (const project of projects) {
      expect(project.area_id).toBeNull()
      const existing = await create("/api/tasks", { title: "Existing " + project.title, placement: { projectId: project.id }, due_date: due })
      expect(existing).toMatchObject({ project_id: project.id, area_id: null })
      expect((await context.request.post(app + "/api/tasks", { headers, data: { title: "Rejected explicit conflict", placement: { areaId: remembered.id, projectId: project.id } } })).status()).toBe(400)
      const conflict = await context.request.get(app + `/boards/household?project=${project.id}&area=${remembered.id}`, { maxRedirects: 0 })
      expect(conflict.status()).toBe(404)
      expect(conflict.headers()["cache-control"]).toContain("no-store")
      const page = await context.newPage()
      page.setDefaultTimeout(8_000)
      for (const view of ["kanban", "table", "calendar", "timeline"]) {
        await page.goto(app + `/boards/household?area=${remembered.id}`)
        await expect(page.locator("#area-selector-trigger")).toHaveAttribute("data-selected-area-id", remembered.id)
        await page.goto(app + `/boards/household?project=${project.id}&view=${view}`)
        await expect(page.locator(`#tasks-view-${view}`)).toBeVisible()
        await expect(page.locator("#area-selector-trigger")).toHaveAttribute("data-selected-area-id", "")
        await expect(page).toHaveURL(url => !url.searchParams.get("area"))
        if (view === "kanban") await expect(page.locator(`.kanban-card[data-id="${existing.id}"]`)).toBeVisible()
        else if (view === "table") await expect(page.locator(`#task-table tr[data-id="${existing.id}"]`)).toBeVisible()
        else if (view === "timeline") await expect(page.locator(`#gantt-chart [data-task-id="${existing.id}"]`).first()).toBeVisible()
        else {
          await page.locator(`.cal-cell[data-date="${due}"]:not(.cal-other)`).press("Enter")
          await expect(page.locator(`#day-drawer-tasks [data-task-id="${existing.id}"]`)).toBeVisible()
        }
      }
      await page.goto(app + `/boards/household?project=${project.id}`)
      async function persisted(title: string) {
        const list = await (await context.request.get(app + "/api/tasks?project_id=" + project.id, { headers })).json()
        const listed = list.tasks.find((task: { title: string }) => task.title === title)
        expect(listed).toBeTruthy()
        const task = await (await context.request.get(app + "/api/tasks/" + listed.id, { headers })).json()
        expect(task).toMatchObject({ area_id: null, project_id: project.id })
        return task
      }
      const modalTitle = "Modal capture " + project.title
      await page.locator("#kanban-bar-new-task").click()
      await page.locator("#new-task-title-input").fill(modalTitle)
      const boardBeforeDetail = new URL(page.url())
      const gateInitialDetail = project === projects[0]
      const detailRequest = /\/api\/tasks\/[a-f0-9-]+$/
      let heldDetailRoute: Route | undefined
      let detailRequestHeld: ((route: Route) => void) | undefined
      const pendingDetailRequest = gateInitialDetail ? new Promise<Route>(resolve => { detailRequestHeld = resolve }) : undefined
      if (gateInitialDetail) {
        // Close must work before loading establishes canonical ticket history.
        await page.route(detailRequest, async route => {
          if (route.request().method() === "GET" && !heldDetailRoute) {
            heldDetailRoute = route
            detailRequestHeld!(route)
          } else await route.continue()
        })
      }
      await page.locator("#nt-split-toggle").click()
      await page.locator('[data-after-create="open"]').click()
      const modalSaved = page.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST")
      await page.locator("#submit-new-task-btn").click()
      expect((await modalSaved).status()).toBe(201)
      const modalTask = await persisted(modalTitle)
      await expect(page.locator(`.kanban-card[data-id="${modalTask.id}"]`)).toBeVisible()
      const detailOverlay = page.locator("#task-detail-overlay")
      if (gateInitialDetail) {
        await expect(detailOverlay).toHaveAttribute("data-open-task-id", modalTask.id)
        await expect(detailOverlay).toHaveAttribute("aria-label", "Task detail: loading...")
        expect((await pendingDetailRequest)!.request().url()).toBe(app + "/api/tasks/" + modalTask.id)
        expect(new URL(page.url()).searchParams.get("open")).toBe(modalTask.id)
      }
      await page.locator("#task-detail-overlay.active #td-close").click()
      if (gateInitialDetail) {
        await expect(page).toHaveURL(url => url.pathname === boardBeforeDetail.pathname && url.search === boardBeforeDetail.search && url.hash === boardBeforeDetail.hash)
        expect(new URL(page.url()).searchParams.get("project")).toBe(project.id)
        await expect(detailOverlay).not.toHaveAttribute("data-open-task-id")
        await expect(detailOverlay).not.toHaveClass(/\bactive\b/)
        await heldDetailRoute!.continue()
        await page.unroute(detailRequest)
      }
      const lane = page.locator('.kanban-column[data-status="pending"]')
      await lane.locator(":scope > .kanban-add-btn").click()
      const laneTitle = "Lane capture " + project.title
      await lane.locator(".kanban-inline-add input").fill(laneTitle)
      const laneSaved = page.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST")
      await lane.locator(".quick-add-btn").click()
      expect((await laneSaved).status()).toBe(201)
      const laneTask = await persisted(laneTitle)
      await expect(page.locator(`.kanban-card[data-id="${laneTask.id}"]`)).toBeVisible()
      if (gateInitialDetail) {
        await expect(detailOverlay).not.toHaveClass(/\bactive\b/)
        await expect(page).toHaveURL(url => url.pathname === boardBeforeDetail.pathname && url.search === boardBeforeDetail.search && url.hash === boardBeforeDetail.hash)
      }
      const draftTitle = "Draft capture " + project.title
      await page.locator("#kanban-bar-new-task").click()
      await page.locator("#new-task-title-input").fill(draftTitle)
      await page.locator("#nt-draft-toggle").click()
      await page.locator("#nt-draft-save").click()
      await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")
      await page.goto(app + "/boards/household?area=" + remembered.id)
      await page.locator("#kanban-bar-new-task").click()
      await page.locator("#nt-draft-toggle").click()
      await page.locator("#nt-draft-resume").click()
      await expect(page.locator("#new-task-title-input")).toHaveValue(draftTitle)
      const published = page.waitForResponse(response => response.url().endsWith("/api/task-drafts") && response.request().method() === "PUT" && response.request().postDataJSON().action === "publish")
      await page.locator("#submit-new-task-btn").click()
      expect((await published).status()).toBe(201)
      await persisted(draftTitle)
      await page.close()
    }
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
