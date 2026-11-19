import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Area options open the editor and save within Home Assistant ingress", async () => {
  const work = await mkdtemp(join(tmpdir(), "area-test-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    context.setDefaultTimeout(6_000)
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    const appUrl = origin + prefix
    expect((await page.goto(appUrl + "/fixture"))?.status()).toBe(200)
    const headers = await currentBoardWriteHeaders(context.request, "household", { origin }, appUrl)
    const created = await context.request.post(appUrl + "/api/areas", {
      headers, data: { name: "Workshop fixture" },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { id: areaId } = await created.json() as { id: string }
    // Planning and saved Area links now converge on the Board's ordinary groups workspace.
    expect((await page.goto(appUrl + "/planning#spaces"))?.ok()).toBe(true)
    await expect(page).toHaveURL(appUrl + "/boards")
    const board = page.locator('[data-board-card="household"]')
    const boardLink = board.getByRole("link", { name: "Household", exact: true }).first()
    await expect(boardLink).toBeVisible()
    await boardLink.press("Enter")
    await expect(page).toHaveURL(url => url.pathname === prefix + "/boards/household")
    const editorUrl = `${appUrl}/boards/household?area=${areaId}&view=groups#group-settings`
    await page.goto(`${appUrl}/areas/${areaId}#settings`)
    await expect(page).toHaveURL(editorUrl)

    const name = page.getByRole("textbox", { name: "Name", exact: true })
    await name.fill("Workshop renamed")
    const save = page.getByRole("button", { name: "Save Changes" })
    const areaApi = appUrl + "/api/areas/" + areaId
    await page.route(areaApi, async route => {
      expect(route.request().method()).toBe("PUT")
      await route.fulfill({ status: 503 })
    })
    await save.click()
    await expect(page.getByRole("alert")).toContainText("Could not save the Area")
    await expect(name).toHaveValue("Workshop renamed")
    await page.unroute(areaApi)
    await save.click()
    await expect(page.getByRole("heading", { name: /Workshop renamed/ })).toBeVisible()
    await expect(page).toHaveURL(editorUrl)
    await expect(name).toHaveValue("Workshop renamed")
    const tabs = page.getByRole("tablist", { name: "Area sections" })
    const settingsTab = tabs.getByRole("tab", { name: /Settings/ })
    await expect(settingsTab).toHaveAttribute("aria-selected", "true")
    await settingsTab.press("Home")
    await expect(tabs.getByRole("tab", { name: /Overview/ })).toBeFocused()
    const overview = page.getByRole("tabpanel", { name: /Overview/ })
    await expect(overview).toBeVisible()
    await overview.getByRole("link", { name: /Projects/ }).press("Enter")
    await expect(page.getByRole("tabpanel", { name: /Projects/ })).toBeFocused()
    await settingsTab.click()

    const missing = await context.request.get(appUrl + "/areas/nonexistent", { maxRedirects: 0 })
    expect(missing.status()).toBe(404)
    expect(missing.headers()["cache-control"]).toContain("no-store")

    await page.setViewportSize({ width: 320, height: 780 })
    await expect(save).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)

    const project = await context.request.post(appUrl + "/api/projects", {
      headers, data: { title: "Tool storage", area_id: areaId },
    })
    expect(project.status()).toBe(201)
    const { id: projectId } = await project.json() as { id: string }
    await page.setViewportSize({ width: 1240, height: 780 })
    await page.goto(`${appUrl}/projects/${projectId}`)
    await expect(page.locator("#section-overview")).toBeVisible()
    const sidebar = page.locator("[data-sidebar-boards]")
    const boards = page.locator("[data-sidebar-boards-toggle]")
    if (await boards.getAttribute("aria-expanded") !== "true") await boards.press("Enter")
    const groupToggle = sidebar.getByRole("button", { name: "Areas in Household", exact: true })
    if (await groupToggle.getAttribute("aria-expanded") !== "true") await groupToggle.press("Enter")
    const group = sidebar.locator(`[data-group-choice="${areaId}"]`)
    const projectToggle = group.getByRole("button", { name: "Projects in Workshop renamed", exact: true })
    if (await projectToggle.getAttribute("aria-expanded") !== "true") await projectToggle.press("Enter")
    const projectLink = group.getByRole("link", { name: "Tool storage", exact: true })
    await expect(projectLink).toBeVisible()
    await projectLink.press("Enter")
    await expect(page).toHaveURL(url => url.pathname === prefix + "/boards/household" &&
      url.searchParams.get("project") === projectId && url.searchParams.get("from") === areaId)
    await page.getByRole("navigation", { name: "Board workspace" })
      .getByRole("link", { name: "Areas & Projects", exact: true }).press("Enter")
    await page.locator(".project-tabs").getByRole("tab", { name: "Settings" }).press("Enter")
    await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible()
    const legacyProjectSettings = `${appUrl}/boards/household?project=${projectId}&view=groups#project-settings`
    await page.goto(`${appUrl}/projects/${projectId}#settings`)
    await expect(page).toHaveURL(legacyProjectSettings)
    await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible()

    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      db.exec("DELETE FROM areas WHERE id = 'default'")
    } finally {
      db.close()
    }
    expect((await context.request.get(appUrl + "/api/areas/default")).status()).toBe(404)
    const missingArea = await context.request.post(appUrl + "/api/habits", {
      headers, data: { name: "Unassigned Routine", area_id: "default" },
    })
    expect(missingArea.status()).toBe(400)
    const unassigned = await context.request.post(appUrl + "/api/habits", {
      headers, data: { name: "Unassigned Routine", area_id: null },
    })
    expect(unassigned.status(), await unassigned.text()).toBe(201)
    const { id: unassignedId } = await unassigned.json()
    const unassignedList = await context.request.get(appUrl + "/api/habits?board_id=household")
    expect(unassignedList.status()).toBe(200)
    const savedRoutine = (await unassignedList.json()).habits.find((routine: { id: string }) => routine.id === unassignedId)
    expect(savedRoutine).toBeDefined()
    expect(JSON.parse(savedRoutine.template_json)).toMatchObject({ area_id: null })
    const unassignedCompletion = await context.request.post(appUrl + "/api/habits", {
      headers, data: { action: "complete", templateId: unassignedId },
    })
    expect(unassignedCompletion.status()).toBe(200)
    await page.goto(appUrl + "/habits?new=1")
    await expect(page.getByRole("dialog", { name: "New Routine" }).getByLabel("Area")).toHaveValue("")
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

test("Area and Project pages show associated Goals and keep the All Goals view", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  page.setDefaultTimeout(6_000)
  const stamp = crypto.randomUUID().slice(0, 8)
  const areas: string[] = []
  const goals: string[] = []
  let projectId: string | undefined

  async function create(path: string, data: object) {
    const response = await request.post(path, { headers, data })
    expect(response.status(), await response.text()).toBe(201)
    return (await response.json()).id as string
  }

  try {
    const work = await create("/api/areas", { name: "Work " + stamp })
    areas.push(work)
    const home = await create("/api/areas", { name: "Home " + stamp })
    areas.push(home)
    const workGoal = await create("/api/goals", { title: "Finish the class " + stamp, area_id: work })
    goals.push(workGoal)
    const homeGoal = await create("/api/goals", { title: "Keep the garden " + stamp, area_id: home })
    goals.push(homeGoal)
    const unlinkedGoal = await create("/api/goals", { title: "Learn to cycle " + stamp })
    goals.push(unlinkedGoal)
    projectId = await create("/api/projects", { title: "Start Tuesday " + stamp, area_id: work, goal_id: unlinkedGoal })

    await page.goto(`/areas/${work}`)
    await page.getByRole("navigation", { name: "Area sections" }).getByRole("tab", { name: /Goals/ }).click()
    const areaGoals = page.locator("#section-goals")
    await expect(areaGoals.getByRole("heading", { name: "Finish the class " + stamp })).toBeVisible()
    await expect(areaGoals.getByRole("heading", { name: "Learn to cycle " + stamp })).toBeVisible()
    await expect(areaGoals.getByText("Keep the garden " + stamp)).toHaveCount(0)
    const goalList = page.locator("#goals-tab-root")
    await expect(goalList.locator(`[data-goal-id="${workGoal}"].goals-tab__card`)).toBeVisible()
    await expect(goalList.locator(`[data-goal-id="${homeGoal}"].goals-tab__card`)).toHaveCount(0)
    await goalList.getByRole("button", { name: "+ New Goal" }).click()
    await goalList.getByRole("textbox", { name: "New goal title" }).fill("Created within Work " + stamp)
    const goalReceipt = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/goals" && response.request().method() === "POST",
    )
    await goalList.getByRole("button", { name: "Create", exact: true }).click()
    const linkedGoal = await goalReceipt
    expect(linkedGoal.status()).toBe(201)
    expect(linkedGoal.request().postDataJSON().area_id).toBe(work)
    await expect(page).toHaveURL(new RegExp(`/boards/household\\?area=${work}&view=groups#goals$`))
    const newCard = goalList.locator(".goals-tab__card").filter({ hasText: "Created within Work " + stamp })
    await expect(newCard).toBeVisible()
    goals.push((await newCard.getAttribute("data-goal-id"))!)
    await goalList.getByRole("link", { name: "All Goals" }).click()
    await expect(goalList.locator(`[data-goal-id="${homeGoal}"].goals-tab__card`)).toBeVisible()

    await page.goto(`/projects/${projectId}#settings`)
    const settings = page.locator("#section-project-settings")
    const projectArea = settings.getByLabel("Area", { exact: true })
    await expect(projectArea).toHaveValue(work)
    await expect(settings.getByLabel("Goal", { exact: true })).toHaveValue(unlinkedGoal)
    await projectArea.selectOption(home)
    await settings.getByRole("button", { name: "Save Changes" }).click()
    await expect(page.locator(`.project-breadcrumb a[href="/boards/household?area=${home}"]`)).toHaveCount(1)
    await page.locator(".project-tabs").getByRole("tab", { name: "Overview" }).click()
    await page.locator(".project-breadcrumb").getByRole("link", { name: /Learn to cycle/ }).click()
    await expect(goalList.locator(`[data-goal-id="${unlinkedGoal}"].goals-tab__card`)).toBeVisible()
    await expect(goalList.locator(".goals-tab__card")).toHaveCount(1)
    const projectGoals = await request.get(`/api/goals?project_id=${projectId}`)
    expect((await projectGoals.json()).goals.map((goal: { id: string }) => goal.id)).toEqual([unlinkedGoal])
  } finally {
    if (projectId) await request.delete(`/api/projects/${projectId}`, { headers: { ...headers, "content-type": "application/json" } })
    for (const id of goals) await request.delete(`/api/goals/${id}`, { headers: { ...headers, "content-type": "application/json" } })
    for (const id of areas) await request.delete(`/api/areas/${id}`, { headers: { ...headers, "content-type": "application/json" } })
  }
})

test("Area Routines open the existing editor in context and keep the generated task in that Area", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const name = "Routine scope " + Date.now()
  const created = await request.post("/api/areas", { headers, data: { name } })
  expect(created.status()).toBe(201)
  const { id: area } = await created.json()
  let routineId: string | undefined
  let taskId: string | undefined
  let nextArea: string | undefined
  try {
    await page.goto(`/areas/${area}#routines`)
    await page.getByRole("link", { name: "New Routine", exact: true }).click()
    const editor = page.getByRole("dialog", { name: "New Routine" })
    await expect(editor.getByLabel("Area", { exact: true })).toHaveValue(area)
    await editor.locator("#habit-name").fill(name)
    const receipt = page.waitForResponse(response => response.url().endsWith("/api/habits") && response.request().method() === "POST")
    await editor.locator("button[type=submit]").click()
    const response = await receipt
    expect(response.status()).toBe(201)
    await expect(editor).toBeHidden()
    const scoped = await request.get(`/api/habits?area_id=${area}`)
    const routines = (await scoped.json()).habits as Array<{ id: string; name: string }>
    expect(routines.map(routine => routine.name)).toEqual([name])
    routineId = routines[0]?.id
    const defaultArea = await request.get("/api/habits?area_id=default")
    expect((await defaultArea.json()).habits.map((routine: { id: string }) => routine.id)).not.toContain(routineId)
    await expect(page).toHaveURL(new RegExp(`/progress\\?board_id=household&area_id=${area}(?:&view=groups)?#routines$`))
    const routinesLink = page.locator("#progress-section-routines").getByRole("link", { name: "View Routines", exact: true })
    await expect(routinesLink).toBeVisible()
    await routinesLink.press("Enter")
    await expect(page).toHaveURL(url => url.pathname === "/habits" &&
      url.searchParams.get("board_id") === "household" && url.searchParams.get("area_id") === area)
    await expect(page.locator("#habits-list").getByText(name, { exact: true })).toBeVisible()

    const destination = await request.post("/api/areas", { headers, data: { name: name + " destination" } })
    expect(destination.status()).toBe(201)
    nextArea = (await destination.json()).id
    const moveRoutine = (areaId: string | null) => request.post("/api/habits", {
      headers, data: { action: "update", templateId: routineId, templateJson: { area_id: areaId, checklists: [] } },
    })
    const updated = await moveRoutine(nextArea!)

    expect(updated.ok()).toBe(true)
    const completed = await request.post("/api/habits", { headers, data: { action: "complete", templateId: routineId } })
    expect(completed.ok()).toBe(true)
    taskId = (await completed.json()).taskId
    const task = await request.get(`/api/tasks/${taskId}`)
    const occurrence = await task.json()
    expect(occurrence.area_id).toBe(nextArea)
    expect(occurrence.routine_occurrence).toBe(1)
    const changedDate = await request.put(`/api/tasks/${taskId}`, { headers, data: { due_date: "2000-01-01" } })
    expect(changedDate.status()).toBe(409)
    const changedKind = await request.put(`/api/tasks/${taskId}`, { headers, data: { task_kind: "standard_action" } })
    expect(changedKind.status()).toBe(409)
    expect((await (await request.get(`/api/tasks/${taskId}`)).json()).due_date).toBe(occurrence.due_date)
    expect((await moveRoutine(null)).ok()).toBe(true)
    const replay = await request.post("/api/habits", { headers, data: { action: "complete", templateId: routineId } })
    expect(await replay.json()).toMatchObject({ taskId, alreadyExisted: true })
    const original = await request.get(`/api/tasks/${taskId}`)
    expect((await original.json()).area_id).toBe(nextArea)
    await page.goto("/habits?area_id=&new=1")
    await expect(page).toHaveURL(url => url.pathname === "/boards/household" &&
      url.searchParams.get("view") === "groups" && !url.searchParams.has("new"))
    await expect(page.getByRole("dialog", { name: "New Routine" })).toHaveCount(0)
  } finally {
    if (taskId) await request.delete(`/api/tasks/${taskId}`, { headers: { ...headers, "content-type": "application/json" } })
    if (routineId) await request.post("/api/habits", { headers, data: { action: "delete", templateId: routineId } })
    if (nextArea) await request.delete(`/api/areas/${nextArea}`, { headers: { ...headers, "content-type": "application/json" } })
    await request.delete(`/api/areas/${area}`, { headers: { ...headers, "content-type": "application/json" } })
  }
})
