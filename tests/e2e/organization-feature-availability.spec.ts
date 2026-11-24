import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Timeline All Areas links survive filtering, reload and Back when Areas is unavailable", async ({}, testInfo) => {
  test.setTimeout(60_000)
  const work = await mkdtemp(join(tmpdir(), "organization-timeline-scope-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    const headers = { origin }
    browser = await launchPinBrowser(work)
    const admin = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    const member = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    const other = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    for (const [context, user] of [[admin, "admin"], [member, "member"], [other, "member-two"]] as const) {
      await context.addCookies([{ name: "feedback-fixture", value: user, url: origin }])
    }

    const household = await currentBoardWriteHeaders(member.request, "household", headers, app)
    const areaCreated = await member.request.post(app + "/api/areas", { headers: household, data: { name: "Timeline restricted Area" } })
    expect(areaCreated.status()).toBe(201)
    const areaId = (await areaCreated.json()).id
    const directory = await member.request.get(app + "/api/boards")
    const boardCreated = await member.request.post(app + "/api/boards", {
      headers: { ...headers, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! },
      data: { name: "Timeline restricted Board" },
    })
    expect(boardCreated.status()).toBe(201)
    const boardId = (await boardCreated.json()).id
    const prefix = "Timeline All Areas access"
    const ids: string[] = []
    for (const [suffix, status] of [["Current", "active"], ["Later", "pending"]]) {
      const created = await member.request.post(app + "/api/tasks", { headers: household, data: {
        title: `${prefix} ${suffix}`, status,
        start_date: new Date().toISOString().slice(0, 10),
        due_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      } })
      expect(created.status(), await created.text()).toBe(201)
      ids.push((await created.json()).id)
    }
    const endpoint = app + "/api/organization-features"
    const current = await admin.request.get(endpoint)
    const settings = await current.json()
    const saved = await admin.request.put(endpoint, {
      headers: { ...headers, "x-meitheal-area-admin": current.headers()["x-meitheal-area-admin"]! },
      data: { feature: "groups", audience: "selected", users: ["fixture-member-two"], revision: settings.features.groups.revision },
    })
    expect(saved.status(), await saved.text()).toBe(204)

    for (const path of ["/boards/household", "/api/boards/household", `/boards/${boardId}`, `/api/boards/${boardId}`]) {
      for (const query of ["", "?area="]) expect((await member.request.get(app + path + query)).status(), path + query).toBe(200)
      for (const query of [`?area=${areaId}`, "?area=%20", `?area=&area=${areaId}`]) {
        expect((await member.request.get(app + path + query)).status(), path + query).toBe(404)
      }
    }
    expect((await member.request.get(app + "/api/boards/household?view=groups")).status()).toBe(404)
    expect((await member.request.get(app + "/api/areas")).status()).toBe(404)
    expect((await other.request.get(app + "/api/areas")).status()).toBe(200)
    for (const path of [`/boards/${boardId}?area=`, `/api/boards/${boardId}?area=`]) {
      expect((await other.request.get(app + path)).status(), "Board membership still required").toBe(404)
    }

    const page = await member.newPage()
    expect((await page.goto(app + "/boards/household?view=timeline#timeline"))?.status()).toBe(200)
    await expect(page.locator("#area-selector-trigger")).toHaveCount(0)
    const timeline = page.locator("#tasks-view-timeline")
    const toolbar = timeline.getByRole("toolbar", { name: "Filter tasks" })
    const search = toolbar.getByRole("textbox", { name: "Filter by text" })
    const groupBy = toolbar.locator('details[aria-label="Group tasks by"]')
    const currentTask = timeline.locator(`.gantt-bar[data-task-id="${ids[0]}"]`)
    const laterTask = timeline.locator(`.gantt-bar[data-task-id="${ids[1]}"]`)
    await search.fill(prefix)
    await groupBy.locator("summary").click()
    await groupBy.getByRole("button", { name: "By Status", exact: true }).click()
    await toolbar.getByRole("combobox", { name: "Filter by status" }).selectOption("active")
    await expect(page).toHaveURL(url => url.searchParams.get("area") === "" && url.searchParams.get("groupBy") === "status")
    await expect(currentTask).toBeVisible()
    await expect(laterTask).toHaveCount(0)

    const timelineUrl = page.url()
    expect((await page.reload())?.status()).toBe(200)
    await expect(search).toHaveValue(prefix)
    await expect(currentTask).toBeVisible()
    await expect(laterTask).toHaveCount(0)
    await page.locator('[data-view-tab="table"]').click()
    await expect(page.locator("#tasks-view-table")).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(timelineUrl)
    await expect(search).toHaveValue(prefix)
    await expect(groupBy.locator("summary")).toContainText("Status")
    await expect(currentTask).toBeVisible()
    await expect(laterTask).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath("restricted-timeline.png"), fullPage: true })
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

test("Administrators choose who can use each organization feature", async () => {
  // Starts its own Home Assistant core fixture; about 20 s of the default 30 s on hosted runners.
  test.slow()
  const work = await mkdtemp(join(tmpdir(), "organization-features-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    const headers = { origin }
    browser = await launchPinBrowser(work)
    const admin = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    const member = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    const other = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await admin.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    await member.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await other.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])

    const endpoint = app + "/api/organization-features"
    async function setFeature(feature: string, audience: string, users: string[] = []) {
      const current = await admin.request.get(endpoint)
      expect(current.status()).toBe(200)
      const settings = await current.json()
      const saved = await admin.request.put(endpoint, {
        headers: { ...headers, "x-meitheal-area-admin": current.headers()["x-meitheal-area-admin"]! },
        data: { feature, audience, users, revision: settings.features[feature].revision },
      })
      expect(saved.status(), await saved.text()).toBe(204)
    }
    expect((await member.request.get(endpoint)).status()).toBe(403)
    for (const enabled of [false, true]) {
      const saved = await admin.request.put(app + "/api/features", { headers, data: { feature: "gamification", enabled } })
      expect(saved.status()).toBe(200)
      const current = await (await member.request.get(app + "/api/features")).json()
      expect(current.features.find((feature: { name: string }) => feature.name === "gamification").enabled).toBe(enabled)
    }
    const household = await currentBoardWriteHeaders(member.request, "household", headers, app)
    const group = await member.request.post(app + "/api/areas", { headers: household, data: { name: "Hidden group fixture" } })
    expect(group.status()).toBe(201)
    const groupId = (await group.json()).id
    const projectTitle = "Organization policy project fixture"
    const project = await member.request.post(app + "/api/projects", { headers: household, data: { title: projectTitle } })
    expect(project.status(), await project.text()).toBe(201)
    const householdProjectId = (await project.json()).id
    const areaPickerPage = await member.newPage()
    await areaPickerPage.goto(app + "/boards/household")
    await areaPickerPage.locator("#area-selector-trigger").click()
    await expect(areaPickerPage.locator("#area-selector-dropdown").getByRole("option", { name: "Hidden group fixture", exact: true })).toBeVisible()
    await expect(areaPickerPage.locator("#area-selector-dropdown").getByRole("option", { name: projectTitle, exact: true })).toHaveCount(0)
    await areaPickerPage.close()
    const projectTaskTitle = "Project policy task fixture"
    const assignment = await member.request.post(app + "/api/tasks", {
      headers: household, data: { title: projectTaskTitle, project_id: householdProjectId },
    })
    expect(assignment.status(), await assignment.text()).toBe(201)
    await setFeature("groups", "nobody")
    expect((await member.request.get(app + "/api/boards/household?view=groups")).status()).toBe(404)
    expect((await member.request.post(app + "/api/tasks", {
      headers: household, data: { title: "Unavailable filing", placement: { areaId: groupId } },
    })).status()).toBe(404)
    await setFeature("goals", "nobody")
    await setFeature("routines", "selected", ["fixture-member"])
    await setFeature("planning", "selected", ["fixture-member"])
    await setFeature("projects", "selected", ["fixture-member-two"])
    for (const context of [admin, member, other]) {
      expect((await context.request.get(app + "/api/goals")).status()).toBe(404)
    }
    expect((await member.request.get(app + "/habits")).status()).toBe(200)
    expect((await other.request.get(app + "/habits")).status()).toBe(404)
    expect((await other.request.get(app + "/api/habits")).status()).toBe(404)
    expect((await other.request.get(app + "/api/%68abits")).status()).toBe(404)
    expect((await other.request.get(app + "/api/%67oals")).status()).toBe(404)
    expect((await other.request.get(app + "/planning")).status()).toBe(404)
    expect((await member.request.get(app + "/api/projects")).status()).toBe(404)
    expect((await other.request.get(app + "/api/projects")).status()).toBe(200)
    await setFeature("groups", "everyone")
    const noProjectsPage = await member.newPage()
    await noProjectsPage.goto(app + "/boards/household")
    const householdRow = noProjectsPage.locator('#sidebar [data-named-board-shortcut="household"]')
    await householdRow.getByRole("button", { name: "Areas in Household" }).click()
    const groupChoice = householdRow.locator(`[data-group-choice="${groupId}"]`)
    await expect(groupChoice.getByRole("link", { name: "Hidden group fixture" })).toBeVisible()
    await expect(groupChoice.getByRole("button", { name: /Projects in/ })).toHaveCount(0)
    await expect(householdRow.getByRole("link", { name: projectTitle })).toHaveCount(0)
    await noProjectsPage.close()
    await setFeature("groups", "nobody")
    const groupedPath = app + "/tasks?area=&groupBy=project&search=" + encodeURIComponent(projectTaskTitle)
    const allowedGrouping = await other.request.get(groupedPath)
    expect(allowedGrouping.status()).toBe(200)
    const allowedHtml = await allowedGrouping.text()
    expect(allowedHtml.includes(`data-project-label="${projectTitle}"`), "enabled Project label").toBe(true)
    expect(allowedHtml.includes(`data-project-group="project-${householdProjectId}"`), "enabled Project identity").toBe(true)
    const unavailableGrouping = await member.request.get(groupedPath)
    expect(unavailableGrouping.status()).toBe(200)
    const unavailableHtml = await unavailableGrouping.text()
    expect(unavailableHtml.includes(projectTaskTitle), "Household task remains available").toBe(true)
    expect(unavailableHtml.includes(projectTitle), "unavailable Project label").toBe(false)
    expect(unavailableHtml.includes("data-project-group="), "unavailable Project grouping metadata").toBe(false)
    const memberFeatures = await member.request.get(app + "/api/features")
    expect(memberFeatures.status()).toBe(200)
    expect(memberFeatures.headers()["cache-control"]).toContain("no-store")
    const flags = await (await other.request.get(app + "/api/features")).json()
    expect(flags.features.find((feature: {name: string}) => feature.name === "habits").enabled).toBe(false)
    expect((await admin.request.put(app + "/api/features", { headers, data: { feature: "habits", enabled: true } })).status()).toBe(409)
    expect((await admin.request.put(app + "/api/settings", { headers, data: { key: "feature_habits", value: true } })).status()).toBe(409)
    expect((await member.request.put(app + "/api/features", { headers, data: { feature: "habits", enabled: true } })).status()).toBe(403)
    const page = await other.newPage()
    await page.goto(app + "/progress")
    await expect(page.locator('[data-parent-section="goals"]')).toHaveCount(0)
    await expect(page.locator('[data-parent-section="routines"]')).toHaveCount(0)
    const labels = await (await other.request.get(app + "/api/organization-labels")).json()
    expect(labels.terms).not.toContain("goal")
    expect(labels.terms).not.toContain("routine")
    await page.goto(app + "/tasks?view=table")
    expect(await page.content()).not.toContain("Hidden group fixture")
    await expect(page.locator("#area-selector-trigger")).toHaveCount(0)
    await page.getByRole("textbox", { name: "Filter by text" }).fill("independent Table search")
    await expect(page).toHaveURL(url => url.searchParams.get("search") === "independent Table search")
    const bridge = await member.newPage()
    await bridge.goto(app + "/planning#spaces")
    await expect(bridge).toHaveURL(app + "/boards")
    await bridge.close()
    const workerContext = await browser.newContext({ ignoreHTTPSErrors: true })
    await workerContext.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    const workerPage = await workerContext.newPage()
    await workerPage.goto(app + "/fixture")
    await workerPage.evaluate(async app => {
      const cache = await caches.open("meitheal-api-v0.0.1")
      await cache.put(app + "/api/features", new Response("cached-private-fixture"))
      await navigator.serviceWorker.register(app + "/sw.js", { scope: new URL(app).pathname + "/" })
    }, app)
    await workerPage.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    await workerPage.evaluate(async app => {
      for (const name of await caches.keys()) {
        const cached = await (await caches.open(name)).match(app + "/api/features")
        if (cached) throw new Error("Old feature state survived cache activation")
      }
    }, app)
    await workerContext.setOffline(true)
    const offline = await workerPage.evaluate(async app => {
      const response = await fetch(app + "/api/features")
      return { status: response.status, body: await response.text() }
    }, app)
    expect(offline.status).toBe(503)
    expect(offline.body).not.toContain("cached-private-fixture")
    await workerContext.close()
    await setFeature("routines", "everyone")
    expect((await other.request.get(app + "/api/habits")).status()).toBe(200)

    for (const feature of ["groups", "projects", "goals", "routines", "pillars"]) await setFeature(feature, "everyone")
    const directory = await member.request.get(app + "/api/boards")
    const boardHeaders = { ...headers, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
    const boardCreated = await member.request.post(app + "/api/boards", { headers: boardHeaders, data: { name: "Feature authority fixture" } })
    expect(boardCreated.status()).toBe(201)
    const boardId = (await boardCreated.json()).id
    const planning = app + "/api/boards/" + boardId + "/planning"
    const change = (data: object) => member.request.post(planning, { headers: boardHeaders, data })
    expect((await change({ action: "area", title: "Operations" })).status()).toBe(200)
    let model = await (await member.request.get(app + "/api/boards/" + boardId)).json()
    const areaId = model.planning.areas[0].id
    for (const data of [
      { action: "goal", title: "Known goal", description: "", areaId },
      { action: "project", title: "Known project", description: "", areaId, goalId: null },
      { action: "routine", title: "Known routine", description: "", areaId, cadence: "daily" },
      { action: "pillar", title: "Known pillar", description: "" },
    ]) expect((await change(data)).status()).toBe(200)
    model = await (await member.request.get(app + "/api/boards/" + boardId)).json()
    const goalId = model.planning.goals[0].id
    const projectId = model.planning.projects[0].id
    const routine = model.planning.routines[0]
    const pillarId = model.planning.pillars[0].id
    const linkGoal = { action: "project-goal", id: projectId, goalId }
    const pillarGoal = { action: "pillar-link", pillarId, entityType: "goal", id: goalId, enabled: true }
    const pillarRoutine = { action: "pillar-link", pillarId, entityType: "routine", id: routine.id, enabled: true }
    for (const data of [linkGoal, pillarGoal, pillarRoutine]) expect((await change(data)).status()).toBe(200)
    const scoringTask = await member.request.post(app + "/api/tasks", { headers: household, data: { title: "Today score fixture", priority: 3 } })
    expect(scoringTask.status()).toBe(201)
    const scored = await member.request.patch(app + "/api/tasks/" + (await scoringTask.json()).id, { headers: household, data: { status: "done" } })
    expect(scored.status()).toBe(200)
    await page.goto(app + "/today")
    await expect(page.locator(".stat-xp")).toContainText("+30")
    await expect(page.locator(".stat-streak")).toBeVisible()
    await setFeature("goals", "nobody")
    await setFeature("routines", "nobody")
    await setFeature("achievements", "nobody")
    await page.reload()
    await expect(page.locator(".stat-xp, .stat-streak")).toHaveCount(0)
    for (const data of [linkGoal, pillarGoal, pillarRoutine,
      { action: "project", title: "Hidden goal link", description: "", areaId, goalId },
    ]) expect((await change(data)).status()).toBe(404)
    await page.goto(app + "/progress")
    await expect(page.locator('#sidebar a[data-page="progress"]')).toBeVisible()
    await setFeature("routines", "everyone")
    await setFeature("organizer", "nobody")
    expect((await member.request.get(app + "/api/areas")).status()).toBe(404)
    expect((await member.request.get(app + "/api/projects")).status()).toBe(404)
    for (const data of [
      { action: "area", title: "Unavailable organizer group" },
      { action: "project", title: "Unavailable organizer project", description: "", areaId, goalId: null },
    ]) expect((await change(data)).status()).toBe(404)
    // The independent library can still complete an eligible Routine.
    const checked = await change({ action: "routine-complete", id: routine.id, period: routine.period })
    expect(checked.status()).toBe(200)
    const occurrenceId = (await checked.json()).id
    const taskView = await (await member.request.get(app + "/api/boards/" + boardId)).json()
    const occurrence = taskView.tasks.find((task: { id: string }) => task.id === occurrenceId)
    const changedDate = await member.request.patch(app + "/api/boards/" + boardId + "/tickets/" + occurrenceId, {
      headers: boardHeaders, data: { version: occurrence.version, due_date: "2000-01-01" },
    })
    expect(changedDate.status()).toBe(409)
    expect(await changedDate.text()).toContain("original occurrence date")
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
