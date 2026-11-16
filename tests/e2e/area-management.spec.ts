import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
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
    const created = await context.request.post(appUrl + "/api/areas", {
      headers: { origin }, data: { name: "Workshop fixture" },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { id: areaId } = await created.json() as { id: string }
    expect((await page.goto(appUrl + "/planning#spaces"))?.ok()).toBe(true)
    const menu = page.locator("#area-menu-dropdown")
    await expect(menu).toBeAttached()
    await page.getByRole("button", { name: /Area options.*Workshop fixture/i }).press("Enter")
    const manage = menu.getByRole("link", { name: "Edit Area" })
    const editorUrl = `${appUrl}/areas/${areaId}#settings`
    await expect(manage).toHaveAttribute("href", prefix + "/areas/" + areaId + "#settings")
    await expect(manage).toBeFocused()
    await manage.press("Enter")
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

    const missing = await context.request.get(appUrl + "/areas/nonexistent", { maxRedirects: 0 })
    expect(missing.status()).toBe(302)
    expect(new URL(missing.headers().location!, origin).href).toBe(appUrl + "/planning#spaces")

    await page.setViewportSize({ width: 320, height: 780 })
    await expect(save).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)

    const project = await context.request.post(appUrl + "/api/projects", {
      headers: { origin }, data: { title: "Tool storage", area_id: areaId },
    })
    expect(project.status()).toBe(201)
    const { id: projectId } = await project.json() as { id: string }
    await page.setViewportSize({ width: 1240, height: 780 })
    await page.goto(appUrl + "/planning#spaces")
    const plan = page.locator("#planning-section-spaces")
    await plan.getByRole("link", { name: /Tool storage/ }).click()
    await expect(page).toHaveURL(`${appUrl}/projects/${projectId}`)
    await expect(page.locator("#section-overview")).toBeVisible()
    await page.getByRole("button", { name: "Project options - Tool storage" }).press("Enter")
    const editProject = page.getByRole("link", { name: "Edit Project", exact: true })
    await expect(editProject).toHaveAttribute("href", `${prefix}/projects/${projectId}#settings`)
    await expect(editProject).toBeFocused()
    await editProject.press("Enter")
    await expect(page).toHaveURL(`${appUrl}/projects/${projectId}#settings`)
    await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible()
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

test("Area and Project pages show associated Goals and keep the All Goals view", async ({ page, request }) => {
  page.setDefaultTimeout(6_000)
  const stamp = crypto.randomUUID().slice(0, 8)
  const areas: string[] = []
  const goals: string[] = []
  let projectId: string | undefined

  async function create(path: string, data: object) {
    const response = await request.post(path, { data })
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
    await page.getByRole("navigation", { name: "Area sections" }).getByRole("link", { name: /Goals/ }).click()
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
    await expect(page).toHaveURL(new RegExp(`/areas/${work}#goals$`))
    const newCard = goalList.locator(".goals-tab__card").filter({ hasText: "Created within Work " + stamp })
    await expect(newCard).toBeVisible()
    goals.push((await newCard.getAttribute("data-goal-id"))!)
    await goalList.getByRole("link", { name: "All Goals" }).click()
    await expect(goalList.locator(`[data-goal-id="${homeGoal}"].goals-tab__card`)).toBeVisible()

    await page.goto(`/projects/${projectId}#settings`)
    const settings = page.locator("#section-settings")
    const projectArea = settings.getByLabel("Area", { exact: true })
    await expect(projectArea).toHaveValue(work)
    await expect(settings.getByLabel("Goal", { exact: true })).toHaveValue(unlinkedGoal)
    await projectArea.selectOption(home)
    await settings.getByRole("button", { name: "Save Changes" }).click()
    await expect(page.locator(`.project-breadcrumb a[href="/areas/${home}"]`)).toHaveCount(1)
    await page.locator(".project-tabs").getByRole("tab", { name: "Overview" }).click()
    await page.locator(".project-breadcrumb").getByRole("link", { name: /Learn to cycle/ }).click()
    await expect(goalList.locator(`[data-goal-id="${unlinkedGoal}"].goals-tab__card`)).toBeVisible()
    await expect(goalList.locator(".goals-tab__card")).toHaveCount(1)
    const projectGoals = await request.get(`/api/goals?project_id=${projectId}`)
    expect((await projectGoals.json()).goals.map((goal: { id: string }) => goal.id)).toEqual([unlinkedGoal])
  } finally {
    if (projectId) await request.delete(`/api/projects/${projectId}`)
    for (const id of goals) await request.delete(`/api/goals/${id}`)
    for (const id of areas) await request.delete(`/api/areas/${id}`)
  }
})

test("Area Routines open the existing editor in context and keep the generated task in that Area", async ({ page, request }) => {
  const name = "Routine scope " + Date.now()
  const created = await request.post("/api/areas", { data: { name } })
  expect(created.status()).toBe(201)
  const { id: area } = await created.json()
  let routineId: string | undefined
  let taskId: string | undefined
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
    routineId = (await response.json()).id
    await expect(editor).toBeHidden()
    const scoped = await request.get(`/api/habits?area_id=${area}`)
    expect((await scoped.json()).habits.map((routine: { id: string }) => routine.id)).toEqual([routineId])
    const defaultArea = await request.get("/api/habits?area_id=default")
    expect((await defaultArea.json()).habits.map((routine: { id: string }) => routine.id)).not.toContain(routineId)
    const updated = await request.post("/api/habits", {
      data: { action: "update", templateId: routineId, templateJson: { checklists: [] } },
    })
    expect(updated.ok()).toBe(true)
    const completed = await request.post("/api/habits", { data: { action: "complete", templateId: routineId } })
    expect(completed.ok()).toBe(true)
    taskId = (await completed.json()).taskId
    const task = await request.get(`/api/tasks/${taskId}`)
    expect((await task.json()).area_id).toBe(area)
    await expect(page.getByRole("link", { name: "All Routines" })).toBeVisible()
  } finally {
    if (taskId) await request.delete(`/api/tasks/${taskId}`)
    if (routineId) await request.post("/api/habits", { data: { action: "delete", templateId: routineId } })
    await request.delete(`/api/areas/${area}`)
  }
})
