import { DatabaseSync } from "node:sqlite"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built App")

test("Household picker and every task view retain context; modal, lane and draft capture keep Project placement; failed catalog retries a remembered Area", async () => {
  test.setTimeout(90_000)
  const work = await mkdtemp(join(tmpdir(), "household-workspace-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  let renamed = false
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const headers = { origin }
    async function create(path: string, data: object) {
      const response = await context.request.post(app + path, { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      return await response.json()
    }
    const area = await create("/api/areas", { name: "Workshop context" })
    const other = await create("/api/areas", { name: "Other context" })
    const project = await create("/api/projects", { title: "Scoped Project", area_id: area.id })
    const task = await create("/api/tasks", { title: "Existing scoped work", placement: { projectId: project.id }, due_date: "2031-07-08" })
    const page = await context.newPage()
    page.setDefaultTimeout(8_000)
    await page.goto(app + "/boards/household")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await page.locator("#area-selector-trigger").click()
    await page.getByRole("option", { name: "Workshop context", exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname.endsWith("/boards/household") && url.searchParams.get("area") === area.id)
    await expect(page.locator(`.kanban-card[data-id="${task.id}"]`)).toBeVisible()
    for (const query of [`area=${area.id}`, `project=${project.id}`]) {
      for (const view of ["kanban", "table", "calendar", "timeline"]) {
        const response = await page.goto(app + `/boards/household?${query}&view=${view}`)
        expect(response?.status()).toBe(200)
        await expect(page.locator(`#tasks-view-${view}`)).toBeVisible()
      }
    }
    for (const scope of [`area=${area.id}`, `project=${project.id}`]) {
      const planningResponse = await page.goto(app + `/boards/household?${scope}&view=groups`)
      expect(planningResponse?.status(), scope).toBe(200)
      const sections = scope.startsWith("area=") ? "Area sections" : "Project sections"
      await page.getByRole("navigation", { name: sections }).getByRole("link", { name: "Tasks", exact: true }).click()
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
      await expect(page.locator(`.kanban-card[data-id="${task.id}"]`)).toBeVisible()
    }
    for (const legacy of [`/areas/${area.id}#tasks`, `/projects/${project.id}#tasks`]) {
      await page.goto(app + legacy)
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    }
    await page.goto(app + `/boards/household?project=${project.id}`)
    await page.locator("#kanban-bar-new-task").click()
    await page.locator("#new-task-title-input").fill("Modal Project capture")
    const saved = page.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST")
    await page.locator("#submit-new-task-btn").click()
    const modalTask = await (await saved).json()
    expect(modalTask).toMatchObject({ project_id: project.id, area_id: area.id })
    await expect(page.locator(`.kanban-card[data-id="${modalTask.id}"]`)).toBeVisible()
    await page.locator("#task-detail-overlay.active #td-close").click()
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    const lane = page.locator('.kanban-column[data-status="pending"]')
    await lane.locator(":scope > .kanban-add-btn").click()
    await lane.locator(".kanban-inline-add input").fill("Lane Project capture")
    const added = page.waitForResponse(response => response.url().endsWith("/api/tasks") && response.request().method() === "POST")
    await lane.locator(".quick-add-btn").click()
    expect((await added).status()).toBe(201)
    const persistedLane = await (await context.request.get(app + "/api/tasks?project_id=" + project.id)).json()
    const listedLane = persistedLane.tasks.find((task: { title: string }) => task.title === "Lane Project capture")
    expect(listedLane).toBeTruthy()
    const laneTask = await (await context.request.get(app + "/api/tasks/" + listedLane.id)).json()
    expect(laneTask).toMatchObject({ project_id: project.id, area_id: area.id })
    await expect(page.locator(`.kanban-card[data-id="${laneTask.id}"]`)).toBeVisible()
    await page.locator("#kanban-bar-new-task").click()
    await page.locator("#new-task-title-input").fill("Draft Project capture")
    await page.locator("#nt-draft-toggle").click()
    await page.locator("#nt-draft-save").click()
    await expect(page.locator("#nt-draft-status")).toHaveText("Draft saved.")
    await page.goto(app + `/boards/household?area=${other.id}`)
    await page.locator("#kanban-bar-new-task").click()
    await page.locator("#nt-draft-toggle").click()
    await page.locator("#nt-draft-resume").click()
    await expect(page.locator("#new-task-title-input")).toHaveValue("Draft Project capture")
    const published = page.waitForResponse(response => response.url().endsWith("/api/task-drafts") && response.request().method() === "PUT" && response.request().postDataJSON().action === "publish")
    await page.locator("#submit-new-task-btn").click()
    const receipt = await (await published).json()
    const persisted = await (await context.request.get(app + "/api/tasks/" + receipt.receipt.taskId)).json()
    expect(persisted).toMatchObject({ project_id: project.id, area_id: area.id })
    await page.evaluate(value => localStorage.setItem("meitheal-selected-area", JSON.stringify({ areaId: value, areaName: "Workshop context", areaIcon: "📁" })), area.id)
    // The live fixture can still be writing when failure injection changes its schema.
    const db = new DatabaseSync(join(work, "pins.db"), { timeout: 5_000 })
    db.exec("ALTER TABLE areas RENAME TO areas_catalog_unavailable")
    renamed = true
    db.close()
    await page.goto(app + "/boards/household")
    await page.locator("#area-selector-trigger").click()
    await expect(page.locator("[data-area-catalog-feedback]")).toContainText("unavailable")
    await expect(page.locator("[data-area-catalog-retry]")).toBeVisible()
    await expect(page.locator("#area-selector-trigger")).toHaveAttribute("data-selected-area-id", area.id)
    const repaired = new DatabaseSync(join(work, "pins.db"), { timeout: 5_000 })
    repaired.exec("ALTER TABLE areas_catalog_unavailable RENAME TO areas")
    repaired.close()
    renamed = false
    await page.locator("[data-area-catalog-retry]").click()
    await expect(page.locator("#area-selector-dropdown")).toHaveAttribute("data-area-catalog-ready", "true")
    await expect(page.locator("#area-selector-trigger")).toHaveText(/Workshop context/)
    await expect(page.locator(`.kanban-card[data-id="${task.id}"]`)).toBeVisible()
    await expect(page).toHaveURL(url => url.searchParams.get("area") === area.id)
  } finally {
    if (renamed) {
      const db = new DatabaseSync(join(work, "pins.db"), { timeout: 5_000 })
      db.exec("ALTER TABLE areas_catalog_unavailable RENAME TO areas")
      db.close()
    }
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
