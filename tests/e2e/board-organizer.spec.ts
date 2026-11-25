import { DatabaseSync } from "node:sqlite"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test, type Locator } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built app")

test("Household Areas organize capture and Projects inside the Board", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const name = "Workshop " + crypto.randomUUID().slice(0, 6)

  await page.goto("/boards/household?view=groups")
  await expect(page.getByRole("heading", { name: "Areas", exact: true })).toBeVisible()
  await page.locator("#main-content").getByText("New Area", { exact: true }).click()
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name)
  await page.getByRole("button", { name: "Create Area", exact: true }).click()
  const group = page.locator("#groups").getByRole("link", { name, exact: false })
  await expect(group).toBeVisible()
  await group.click()
  await expect(page).toHaveURL(/\/boards\/household\?area=/)
  const groupId = new URL(page.url()).searchParams.get("area")!
  await page.goto(`/boards/household?area=${groupId}&view=groups#group-settings`)
  await page.getByRole("navigation", { name: "Area sections" }).getByRole("link", { name: "Tasks", exact: true }).click()
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  await page.locator("#kanban-bar-new-task").click()
  await page.locator("#new-task-title-input").fill("Replace workshop light")
  const submitted = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/api/tasks"))
  await page.locator("#submit-new-task-btn").click()
  const created = await submitted
  expect(created.status()).toBe(201)
  expect(await created.json()).toMatchObject({ title: "Replace workshop light", area_id: groupId })
  await expect(page.locator(".kanban-card").filter({ hasText: "Replace workshop light" })).toBeVisible()
  await page.goto(`/boards/household?area=${groupId}&view=groups&offset=1#tasks`)
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  await expect(page.locator(".kanban-card").filter({ hasText: "Replace workshop light" })).toBeVisible()

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

  await page.goto(`/boards/household?project=${project.id}&view=groups#tasks`)
  await expect(page.getByText("Fit dimmer", { exact: true })).toBeVisible()
  await page.goto(`/boards/household?project=${project.id}&from=${groupId}&view=groups#overview`)
  const back = page.getByRole("banner").getByRole("link", { name, exact: true })
  await expect(back).toHaveAttribute("href", `/boards/household?area=${groupId}`)
  await expect(page.locator('#sidebar [data-page="boards"]')).toBeVisible()
  await expect(page.locator('#sidebar [data-page="areas"]')).toHaveCount(0)
})

test("Household Project detail uses Tabler icons and keeps custom Project icons", async ({ page, request, baseURL }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  const expectIcon = async (scope: Locator, name: string) => {
    const icon = scope.locator(`svg:has(use[href="#mt-icon-${name}"])`)
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute("aria-hidden", "true")
    await expect(page.locator(`symbol#mt-icon-${name} path`).first()).toBeAttached()
  }
  const banner = page.getByRole("banner")
  const breadcrumb = page.getByRole("navigation", { name: "Project breadcrumb" })
  const currentProject = breadcrumb.locator(".bc-current")
  const tabs = page.getByRole("tablist", { name: "Project sections" })
  const tab = (name: string) => tabs.getByRole("tab", { name, exact: true })
  const addTask = banner.getByRole("link", { name: "Add Task", exact: true })

  await page.goto("/projects/every-day")
  await expect(page).toHaveURL(new URL("/boards/household?project=every-day&view=groups", baseURL).href)
  await expectIcon(banner.getByRole("heading", { name: "Every Day", exact: true }), "sun")
  await expectIcon(currentProject, "sun")
  await expectIcon(breadcrumb, "chevron-down")
  const back = banner.getByRole("link", { name: "Household", exact: true })
  await expect(back).toHaveAttribute("href", "/boards/household")
  await expectIcon(back, "arrow-down")
  await expectIcon(addTask, "plus")
  await expectIcon(page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Tasks", exact: true }), "checkbox")
  for (const [label, icon] of [["Overview", "chart-bar"], ["Fields", "tag"], ["Settings", "settings"]] as const) {
    await expectIcon(tab(label), icon)
  }

  await page.setViewportSize({ width: 375, height: 740 })
  await page.getByRole("navigation", { name: "Project sections" }).getByRole("link", { name: "Tasks", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(tab("Overview")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(tab("Fields")).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/#fields$/)
  await expect(tab("Fields")).toHaveAttribute("aria-selected", "true")
  await expectIcon(page.locator(".fields-placeholder"), "tag")
  await addTask.click()
  await expect(page.getByRole("textbox", { name: "Title (required)", exact: true })).toBeVisible()

  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const goalTitle = "Fixture Goal"
  const goal = await request.post("/api/goals", { headers, data: { title: goalTitle } })
  expect(goal.status()).toBe(201)
  const { id: goalId } = await goal.json()
  const title = "A long Project title that still fits beside its icon on a narrow display"
  const project = await request.post("/api/projects", { headers, data: { title, goal_id: goalId } })
  expect(project.status()).toBe(201)
  const { id: projectId } = await project.json()
  const settings = `/projects/${projectId}#settings`
  const heading = banner.getByRole("heading", { name: title, exact: true })
  const iconInput = page.getByRole("textbox", { name: "Icon", exact: true })

  await page.goto(`/boards/household?project=${projectId}&view=groups`)
  await expectIcon(heading, "list-check")
  await expectIcon(currentProject, "list-check")
  await expectIcon(breadcrumb.getByRole("link", { name: goalTitle, exact: true }), "target")
  expect(await heading.locator(".truncate").evaluate(label => label.scrollWidth > label.clientWidth)).toBe(true)
  expect((await heading.locator("svg").boundingBox())?.width).toBe(18)

  await page.goto(settings)
  await expect(page).toHaveURL(/#project-settings$/)
  const goalSelect = page.getByRole("combobox", { name: "Goal", exact: true })
  await expect(goalSelect).toHaveValue(goalId)
  await expect(goalSelect.locator("option:checked")).toHaveText(goalTitle)
  await expect(iconInput).toHaveValue("📋")

  for (const icon of ["🧪", "toString"]) {
    const api = `/api/projects/${projectId}`
    expect((await request.put(api, { headers, data: { icon } })).status()).toBe(200)
    expect(await (await request.get(api)).json()).toMatchObject({ icon })
    await page.goto(`/boards/household?project=${projectId}&view=groups`)
    await expect(heading.locator("[aria-hidden=true]")).toHaveText(icon)
    await expect(currentProject.locator("[aria-hidden=true]")).toHaveText(icon)
    await tab("Settings").click()
    await expect(iconInput).toHaveValue(icon)
  }
})

test("Named Board disclosures follow the selected Area and current Home Assistant account", async () => {
  // This ingress journey loads multiple pages and authenticates two household members.
  test.setTimeout(60_000)
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
    const owner = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block", viewport: { width: 1240, height: 820 } })
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
    page.setDefaultTimeout(8_000)
    page.setDefaultNavigationTimeout(10_000)
    await page.goto(app + "/boards")
    const boardsParent = page.locator('#sidebar [data-sidebar-group="boards"]')
    await expect(boardsParent.getByRole("link", { name: "Household", exact: true })).toBeVisible()
    await expect(boardsParent.getByRole("link", { name: "Workshop Board", exact: true })).toBeVisible()
    await expect(boardsParent.locator('[data-sidebar-board-children] > [data-named-board-shortcut="household"]')).toHaveCount(1)
    await expect(boardsParent.locator('[data-sidebar-board-children] > [data-named-board-shortcut]')).toHaveCount(2)
    const parentToggle = boardsParent.locator("[data-sidebar-boards-toggle]")
    await parentToggle.press("Enter")
    await expect(boardsParent.getByRole("link", { name: "Household", exact: true })).toBeHidden()
    await parentToggle.press("Space")
    await expect(boardsParent.getByRole("link", { name: "Household", exact: true })).toBeVisible()
    const disclosure = page.getByRole("button", { name: "Areas in Workshop Board" })
    await expect(disclosure).toBeVisible()
    await disclosure.press("Enter")
    await expect(disclosure).toHaveAttribute("aria-expanded", "true")
    const group = page.locator("[data-sidebar-boards]").getByRole("link", { name: "Workbench" })
    await group.press("Enter")
    await expect(page).toHaveURL(new RegExp(path + "\\?area="))
    await expect(page.getByRole("navigation", { name: "Board location" }).getByRole("link", { name: "Workbench", exact: true })).toBeVisible()
    await expect(group).toHaveAttribute("aria-current", "page")
    await expect(disclosure).toHaveAttribute("aria-expanded", "true")
    await page.setViewportSize({ width: 320, height: 700 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)

    const selected = new URL(page.url()).searchParams.get("area")!
    const projectCreated = await owner.request.post(app + "/api" + path + "/planning", {
      headers, data: { action: "project", title: "Workbench checks", description: "", areaId: selected, goalId: null },
    })
    expect(projectCreated.status()).toBe(200)
    const otherArea = await owner.request.post(app + "/api" + path + "/planning", {
      headers, data: { action: "area", title: "Garden" },
    })
    expect(otherArea.ok(), await otherArea.text()).toBe(true)
    const planningView = await (await owner.request.get(app + "/api" + path)).json()
    const routineProject = planningView.planning.projects.find((row: { title: string }) => row.title === "Workbench checks").id
    const gardenId = planningView.planning.areas.find((row: { name: string }) => row.name === "Garden").id
    const bookmark = app + path + "?project=" + routineProject
    expect((await owner.request.get(bookmark + "&area=" + selected, { maxRedirects: 0 })).status()).toBe(200)
    const conflict = await owner.request.get(bookmark + "&area=" + gardenId, { maxRedirects: 0 })
    expect(conflict.status()).toBe(404)
    expect(conflict.headers()["cache-control"]).toContain("no-store")
    await page.setViewportSize({ width: 1240, height: 820 })
    await page.goto(app + path + "?area=" + selected)
    const projectsToggle = page.locator("[data-sidebar-boards]").getByRole("button", { name: "Projects in Workbench", exact: true })
    await projectsToggle.press("Enter")
    const projectLink = page.locator("[data-sidebar-boards]").getByRole("link", { name: "Workbench checks", exact: true })
    await expect(projectLink).toBeVisible()
    await projectLink.press("Enter")
    await expect(page).toHaveURL(new RegExp(path + "\\?project=" + routineProject + "&from=" + selected))
    await expect(projectLink).toHaveAttribute("aria-current", "page")
    const placement = new URLSearchParams({ board_id: id, project_id: routineProject })
    await page.goto(app + path + "?project=" + routineProject)
    const routines = page.getByRole("navigation", { name: "Board workspace" }).getByRole("link", { name: "Routines", exact: true })
    await routines.press("Enter")
    await expect(page).toHaveURL(url => url.pathname.endsWith("/progress") && url.hash === "#routines" &&
      url.searchParams.get("board_id") === id && url.searchParams.get("project_id") === routineProject)
    await page.getByRole("button", { name: "New Routine", exact: true }).first().click()
    const editor = page.getByRole("dialog", { name: "New Routine" })
    await expect(editor.getByLabel("Project", { exact: false })).toHaveValue(routineProject)
    await editor.locator("#habit-name").fill("Clean workbench")
    const routineCreated = page.waitForResponse(response => response.url().endsWith("/api/routines") &&
      response.request().method() === "POST", { timeout: 6_000 })
    await editor.locator("button[type=submit]").click()
    const routineSaved = await routineCreated
    expect(routineSaved.status()).toBe(201)
    expect(routineSaved.request().postDataJSON().project_id).toBe(routineProject)
    await expect(page.locator("#habits-list").getByText("Clean workbench", { exact: true })).toBeVisible()
    const workRoutines = `/api/boards/routines?${placement}`
    const checkins = await (await owner.request.get(app + workRoutines)).json()
    expect(checkins.items).toMatchObject([{ name: "Clean workbench", complete: false, canComplete: true }])
    const workToday = `${app}/today?${placement}`
    await page.goto(workToday)
    const routineList = page.locator("[data-board-routine-checkins]")
    await expect(routineList.getByRole("link", { name: "Clean workbench" })).toBeVisible()
    const administrator = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await administrator.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const rootDirectory = await administrator.request.get(app + "/api/boards")
    const rootSnapshot = await rootDirectory.json()
    const example = rootSnapshot.boards.find((candidate: { id: string }) => candidate.id === "household")
    expect(example).toBeTruthy()
    const removeHousehold = await administrator.request.patch(app + "/api/boards/household", {
      headers: { origin, "x-meitheal-board-session": rootDirectory.headers()["x-meitheal-board-session"]! },
      data: { action: "retire", revision: example.revision },
    })
    expect(removeHousehold.status(), await removeHousehold.text()).toBe(200)
    try {
      expect((await page.reload())?.status()).toBe(200)
      await expect(page).toHaveURL(workToday)
      await expect(routineList.getByRole("link", { name: "Clean workbench" })).toBeVisible()
      await expect(routineList.getByRole("button", { name: "Mark Clean workbench done" })).toBeEnabled()
      const retiredRoutineRead = await owner.request.get(app + "/api/habits?board_id=household")
      expect(retiredRoutineRead.status()).toBe(403)
      expect(await retiredRoutineRead.text()).not.toContain("Clean workbench")
    } finally {
      const pausedDirectory = await administrator.request.get(app + "/api/boards")
      const deleted = (await pausedDirectory.json()).deletedBoards.find((board: { id: string }) => board.id === "household")
      expect(deleted).toBeTruthy()
      const restoreHousehold = await administrator.request.patch(app + "/api/boards/household", {
        headers: { origin, "x-meitheal-board-session": pausedDirectory.headers()["x-meitheal-board-session"]! },
        data: { action: "restore", revision: deleted.revision },
      })
      expect(restoreHousehold.status(), await restoreHousehold.text()).toBe(200)
      await administrator.close()
    }
    await page.goto(workToday)
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
    const projectSettings = page.locator("#section-project-settings")
    await expect(projectSettings).toBeVisible()
    await projectSettings.getByRole("textbox", { name: "Title", exact: true }).fill("Updated unfiled fixture")
    await projectSettings.getByRole("button", { name: "Save Changes", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Updated unfiled fixture", exact: true }).first()).toBeVisible()
    const due = await owner.request.post(app + "/api" + path + "/tickets", {
      headers, data: { title: "Due Board work", due_date: "2000-01-01", placement: {} },
    })
    expect(due.status(), await due.text()).toBe(201)
    const task = await due.json()
    const duePath = `/api/boards/due-today?board_id=${id}`
    const dueList = await owner.request.get(app + duePath)
    expect(dueList.status()).toBe(200)
    expect((await dueList.json()).items).toContainEqual(expect.objectContaining({ id: task.id, title: "Due Board work" }))
    await page.goto(app + "/today?board_id=household")
    await expect(page.getByText("Due Board work", { exact: true })).toHaveCount(0)
    await page.goto(app + `/today?board_id=${id}`)
    await expect(page.getByRole("link", { name: "Due Board work", exact: true })).toBeVisible()
    const clearedDue = await owner.request.patch(app + "/api" + path + "/tickets/" + task.id, {
      headers, data: { version: task.version, due_date: null },
    })
    expect(clearedDue.status(), await clearedDue.text()).toBe(200)
    expect((await (await owner.request.get(app + duePath)).json()).items).toEqual([])
    await expect(routineList).toBeVisible()
    await owner.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(routineList).toBeHidden()
    await expect(page.getByText("Due Board work", { exact: true })).toHaveCount(0)
    for (const surface of [workRoutines, duePath]) {
      const denied = await owner.request.get(app + surface)
      expect(denied.status()).toBe(404)
      expect(denied.headers()["cache-control"]).toContain("no-store")
      expect(await denied.text()).not.toMatch(/Clean workbench|Due Board work/)
    }
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
