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
    await owner.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
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
