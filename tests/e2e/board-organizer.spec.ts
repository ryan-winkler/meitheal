import { DatabaseSync } from "node:sqlite"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built app")

test("Household Groups organize capture and Projects inside the Board", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const name = "Workshop " + crypto.randomUUID().slice(0, 6)

  await page.goto("/boards/household?view=groups")
  await expect(page.getByRole("heading", { name: "Groups", exact: true })).toBeVisible()
  await page.getByText("New group", { exact: true }).click()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name)
  await page.getByRole("button", { name: "Create group", exact: true }).click()
  await expect(page).toHaveURL(/\/boards\/household\?area=/)
  const groupId = new URL(page.url()).searchParams.get("area")!
  await page.getByRole("tab", { name: /Tasks/ }).click()
  const taskPanel = page.getByRole("tabpanel", { name: /Tasks/ })
  await taskPanel.getByText("New task", { exact: true }).click()
  await taskPanel.getByRole("textbox", { name: "Title" }).fill("Replace workshop light")
  await taskPanel.getByRole("button", { name: "Create task" }).click()
  await expect(taskPanel.getByRole("link", { name: "Replace workshop light" })).toBeVisible()
  await page.goto(`/boards/household?area=${groupId}&offset=1#tasks`)
  await taskPanel.getByRole("link", { name: "Previous tasks" }).click()
  await expect(taskPanel.getByRole("link", { name: "Replace workshop light" })).toBeVisible()

  const projectResponse = await request.post("/api/projects", {
    headers, data: { title: "Improve lighting", area_id: groupId },
  })
  expect(projectResponse.status()).toBe(201)
  const project = await projectResponse.json()
  const capture = await request.post("/api/tasks", {
    headers, data: { title: "Fit dimmer", placement: { projectId: project.id } },
  })
  expect(capture.status()).toBe(201)
  const saved = await capture.json()
  expect(saved).toMatchObject({ title: "Fit dimmer", area_id: groupId, project_id: project.id })
  expect((await request.post("/api/tasks", {
    headers, data: { title: "Invalid placement", placement: { areaId: "missing" } },
  })).status()).toBe(404)

  await page.goto(`/boards/household?project=${project.id}#tasks`)
  await expect(page.getByText("Fit dimmer", { exact: true })).toBeVisible()
  await page.goto(`/boards/household?project=${project.id}&from=${groupId}#tasks`)
  await expect(page.getByRole("link", { name: "← " + name, exact: true })).toHaveAttribute("href", `/boards/household?area=${groupId}`)
  await expect(page.locator('#sidebar [data-page="boards"]')).toBeVisible()
  await expect(page.locator('#sidebar [data-page="areas"]')).toHaveCount(0)
})

test("Named Board disclosures follow the selected Group and current Home Assistant account", async () => {
  const work = await mkdtemp(join(tmpdir(), "board-sidebar-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const owner = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, viewport: { width: 1240, height: 820 } })
    await owner.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const directory = await owner.request.get(app + "/api/boards")
    expect(directory.ok()).toBe(true)
    const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
    const board = await owner.request.post(app + "/api/boards", { headers, data: { name: "Workshop Board" } })
    expect(board.status(), await board.text()).toBe(201)
    const { id } = await board.json()
    const path = `/boards/${id}`
    const createGroup = await owner.request.post(app + "/api" + path + "/planning", {
      headers, data: { action: "area", title: "Workbench" },
    })
    expect(createGroup.ok(), await createGroup.text()).toBe(true)

    const page = await owner.newPage()
    await page.goto(app + "/boards")
    const disclosure = page.getByRole("button", { name: "Groups in Workshop Board" })
    await expect(disclosure).toBeVisible()
    await disclosure.press("Enter")
    await expect(disclosure).toHaveAttribute("aria-expanded", "true")
    const group = page.locator("[data-sidebar-boards]").getByRole("link", { name: "Workbench" })
    await group.press("Enter")
    await expect(page).toHaveURL(new RegExp(path + "\\?area="))
    await expect(page.getByRole("heading", { name: "Workbench", exact: true })).toBeVisible()
    await expect(group).toHaveAttribute("aria-current", "page")
    await expect(disclosure).toHaveAttribute("aria-expanded", "true")
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)

    const selected = new URL(page.url()).searchParams.get("area")!
    const projectCreated = await owner.request.post(app + "/api" + path + "/planning", {
      headers, data: { action: "project", title: "Workbench checks", description: "", areaId: selected, goalId: null },
    })
    expect(projectCreated.status()).toBe(200)
    const planningView = await (await owner.request.get(app + "/api" + path)).json()
    const routineProject = planningView.planning.projects.find((row: { title: string }) => row.title === "Workbench checks").id
    await page.goto(app + path + "?project=" + routineProject + "&view=groups#routines")
    await page.getByText("New Routine", { exact: true }).click()
    const routineForm = page.locator('form[data-board-form="planning"]').filter({ has: page.locator('input[name="action"][value="routine"]') }).last()
    await routineForm.getByRole("textbox", { name: "Title", exact: true }).fill("Clean workbench")
    const routineCreated = page.waitForResponse(response => response.url().endsWith(path + "/planning") && response.request().method() === "POST", { timeout: 6_000 })
    await routineForm.getByRole("button", { name: "Create Routine", exact: true }).click()
    const routineSaved = await routineCreated
    expect(routineSaved.status()).toBe(200)
    await expect(page.getByText("Clean workbench", { exact: true }).first()).toBeVisible()
    expect(routineSaved.request().postDataJSON().projectId).toBe(routineProject)
    const checkins = await (await owner.request.get(app + "/api/boards/routines")).json()
    expect(checkins.items).toMatchObject([{ name: "Clean workbench", complete: false, canComplete: true }])
    await page.setViewportSize({ width: 1240, height: 820 })
    await page.goto(app + "/habits#habits-library")
    const routineList = page.locator("[data-board-routine-checkins]")
    await expect(routineList.getByRole("link", { name: "Clean workbench" })).toBeVisible()
    await page.goto(app + "/today")
    // Lose the acknowledgement after the server commits; refreshing must reconcile the same occurrence.
    await page.route(app + "/api" + path + "/planning", async route => {
      expect(route.request().postDataJSON()).toMatchObject({ action: "routine-complete", period: checkins.items[0].period })
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      await route.abort("failed")
    }, { times: 1 })
    await routineList.getByRole("button", { name: "Mark Clean workbench done" }).click()
    await expect(routineList).toContainText("Done")
    const completedView = await (await owner.request.get(app + "/api" + path)).json()
    const occurrence = completedView.tasks.find((row: { title: string; routine: boolean }) => row.title === "Clean workbench" && row.routine)
    expect(occurrence).toBeTruthy()
    expect(completedView.tasks.filter((row: { routine: boolean }) => row.routine)).toHaveLength(1)
    await expect(routineList).toContainText("Done")
    const occurrenceResponse = await owner.request.get(app + "/api" + path + "?view=tasks&ticket=" + occurrence.id, { timeout: 6_000 })
    expect(occurrenceResponse.status(), await occurrenceResponse.text()).toBe(200)
    const occurrenceView = await occurrenceResponse.json()
    expect(occurrenceView.tasks[0].placement).toMatchObject({ areaId: selected, projectId: routineProject })
    const legacy = new DatabaseSync(join(work, "pins.db"))
    try {
      legacy.prepare("INSERT INTO projects (id, owner_board_id, title, created_at, updated_at) VALUES (?, ?, ?, 1, 1)")
        .run("unfiled-fixture", id, "Unfiled fixture")
    } finally {
      legacy.close()
    }
    await page.goto(app + path + "?project=unfiled-fixture&view=groups#project-settings")
    const projectSettings = page.locator("#project-settings")
    await expect(projectSettings).toBeVisible()
    await projectSettings.getByRole("textbox", { name: "Name", exact: true }).fill("Updated unfiled fixture")
    await projectSettings.getByRole("button", { name: "Save Project", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Updated unfiled fixture", exact: true }).first()).toBeVisible()
    const due = await owner.request.post(app + "/api" + path + "/tickets", {
      headers, data: { title: "Due Board work", due_date: "2000-01-01", placement: {} },
    })
    expect(due.status(), await due.text()).toBe(201)
    const task = await due.json()
    const dueList = await owner.request.get(app + "/api/boards/due-today")
    expect(dueList.status()).toBe(200)
    expect((await dueList.json()).items).toContainEqual(expect.objectContaining({ id: task.id, title: "Due Board work" }))
    await page.goto(app + "/today")
    const boardWork = page.locator("[data-today-board-work]")
    await expect(boardWork.getByRole("link", { name: "Due Board work" })).toHaveAttribute("href", fixture.configuredPath + path + "?ticket=" + task.id)
    expect(await boardWork.locator('input,button,[data-task-id]').count()).toBe(0)
    const clearedDue = await owner.request.patch(app + "/api" + path + "/tickets/" + task.id, {
      headers, data: { version: task.version, due_date: null },
    })
    expect(clearedDue.status(), await clearedDue.text()).toBe(200)
    expect((await (await owner.request.get(app + "/api/boards/due-today")).json()).items).toEqual([])
    await owner.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(routineList).toBeHidden()
    expect((await (await owner.request.get(app + "/api/boards/routines")).json()).items).toEqual([])
    expect((await (await owner.request.get(app + "/api/boards/due-today")).json()).items).toEqual([])
    const inaccessible = await owner.request.get(app + "/api" + path + "?view=groups&selected=" + selected)
    expect(inaccessible.status()).toBe(404)
    await page.goto(app + "/boards")
    await expect(page.getByRole("link", { name: "Workshop Board", exact: true })).toHaveCount(0)
    await expect(group).toHaveCount(0)
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
