import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test"
import { boardNavigationLinks, readBoardNavigationContext } from "../../apps/web/src/lib/board-workspace"
import { shouldSkipBrowserSpecs } from "./_helpers"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

base("Board navigation preserves placement and never maps a named workspace to Household", () => {
  const context = readBoardNavigationContext(new URL("https://example.test/boards/work?project=lighting&from=study&view=groups&section=goals"))!
  const links = boardNavigationLinks(context)
  for (const href of Object.values(links)) {
    const url = new URL(href, "https://example.test")
    expect(url.pathname).toBe("/boards/work")
    expect(url.searchParams.get("project")).toBe("lighting")
    expect(url.searchParams.get("from")).toBe("study")
  }
  expect(new URL(links.tasks, "https://example.test").searchParams.has("section")).toBe(false)
  expect(new URL(links.progress, "https://example.test").searchParams.get("section")).toBe("goals")
  expect(readBoardNavigationContext(new URL("https://example.test/boards"))).toBeUndefined()
  const household = boardNavigationLinks({ boardId: "household", area: "study", project: "lighting" })
  expect(household.progress).toBe("/progress?board=household&project_id=lighting#goals")
})

type Fixture = { page: Page; member: BrowserContext; app: string; origin: string; headers: Record<string, string> }
const test = base.extend<{ boards: Fixture }>({
  boards: async ({}, use) => {
    const work = await mkdtemp(join(tmpdir(), "board-workspace-navigation-"))
    const child = startCoreFixture(work, false, undefined, undefined, work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser
    try {
      const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${fixture.port}`
      const app = origin + fixture.configuredPath
      browser = await launchPinBrowser(work)
      const member = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
      member.setDefaultTimeout(8_000)
      await member.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
      const directory = await member.request.get(app + "/api/boards")
      expect(directory.status()).toBe(200)
      const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
      await use({ page: await member.newPage(), member, app, origin, headers })
    } finally {
      await browser?.close()
      if (child.exitCode === null) {
        const stopped = once(child, "exit")
        child.kill("SIGTERM")
        await stopped
      }
      await rm(work, { recursive: true, force: true })
    }
  },
})

async function post(fixture: Fixture, path: string, data: object) {
  const response = await fixture.member.request.post(fixture.app + "/api" + path, { headers: fixture.headers, data })
  expect(response.ok(), await response.text()).toBe(true)
  return response.json()
}

async function namedWorkspace(fixture: Fixture) {
  const board = await post(fixture, "/boards", { name: "Workshop" })
  await post(fixture, `/boards/${board.id}/planning`, { action: "area", title: "Study" })
  let planning = await (await fixture.member.request.get(fixture.app + "/api/boards/" + board.id)).json()
  const area = planning.planning.areas[0]
  await post(fixture, `/boards/${board.id}/planning`, { action: "goal", areaId: area.id, title: "Better lighting" })
  planning = await (await fixture.member.request.get(fixture.app + "/api/boards/" + board.id)).json()
  const goal = planning.planning.goals[0]
  await post(fixture, `/boards/${board.id}/planning`, { action: "project", areaId: area.id, goalId: goal.id, title: "Desk light" })
  planning = await (await fixture.member.request.get(fixture.app + "/api/boards/" + board.id)).json()
  const project = planning.planning.projects[0]
  await post(fixture, `/boards/${board.id}/planning`, { action: "routine", areaId: area.id, projectId: project.id, title: "Check desk", cadence: "daily" })
  return { board, area, goal, project }
}

test("Household is a peer Board and every scoped workspace destination retains the selected Board and Project", async ({ boards }, info) => {
  test.setTimeout(90_000)
  const { page, app } = boards
  const { board, project, area } = await namedWorkspace(boards)
  await page.goto(app + "/boards")
  const grid = page.locator(".board-directory-grid")
  await expect(grid.locator(':scope > [data-board-card="household"]')).toHaveCount(1)
  await expect(grid.locator(`:scope > [data-board-card="${board.id}"]`)).toHaveCount(1)
  await expect(page.getByRole("navigation", { name: "Planning", exact: true })).toHaveCount(0)
  await expect(page.locator('[data-sidebar-household] .stree')).toHaveClass(/stree--board/)
  await expect(page.locator('[data-sidebar-household] .stree')).toHaveCSS("border-top-width", "0px")
  await page.screenshot({ path: info.outputPath("one-board-collection.png"), fullPage: true })

  await page.goto(app + `/boards/${board.id}?project=${project.id}&from=${area.id}#kanban`)
  const workspace = page.getByRole("navigation", { name: "Board workspace", exact: true })
  const main = (key: string) => page.locator(`.sidebar [data-page="${key}"]`).first()
  await expect(page.locator("#tasks-submenu-toggle")).toBeHidden()
  for (const key of ["dashboard", "today", "upcoming"]) await expect(main(key)).toContainText("Household")
  for (const key of ["tasks", "planning", "progress"]) {
    const href = await main(key).getAttribute("href")
    const url = new URL(href!, app)
    expect(url.pathname).toContain("/boards/" + board.id)
    expect(url.searchParams.get("project")).toBe(project.id)
  }
  await workspace.getByRole("link", { name: "Goals", exact: true }).click()
  await expect(page.locator("#goals-tab-root")).toContainText("Better lighting")
  expect(new URL(page.url()).searchParams.get("project")).toBe(project.id)
  expect(new URL(page.url()).searchParams.get("section")).toBe("goals")
  await workspace.getByRole("link", { name: "Routines", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Check desk", exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("project")).toBe(project.id)
  await main("planning").click()
  await expect(page.getByRole("heading", { name: "Desk light", exact: true, level: 1 })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("project")).toBe(project.id)
  await main("tasks").click()
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  expect(new URL(page.url()).pathname).toContain("/boards/" + board.id)
  const namedUrl = page.url()
  await page.keyboard.press("c")
  await page.keyboard.press("t")
  await expect(page).toHaveURL(namedUrl)
  await page.keyboard.press("?")
  await expect(page.locator("#shortcut-modal")).toBeVisible()
  await expect(page.locator("#shortcut-modal .shortcut-label").filter({ hasText: /^(Table|Calendar|Timeline)(?:\s|$)/ })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.keyboard.press("n")
  await expect(page.locator('#task-detail-overlay[data-named-board]')).toHaveClass(/active/)
  await expect(page.locator("#new-task-modal")).toHaveCount(0)
  await expect(page.locator('[data-named-inspector-create] input[name="projectId"]')).toHaveValue(project.id)
  await expect(page.locator('[data-named-inspector-create] input[name="areaId"]')).toHaveValue(area.id)
  await page.keyboard.press("Escape")
  await page.locator('[data-sidebar-household] .sidebar-household-link').click()
  await expect(page).toHaveURL(app + "/boards/household")
  await expect(page.locator("#tasks-submenu-toggle")).toBeVisible()
  await expect(main("today")).not.toContainText("Household")
  await main("planning").click()
  await expect(page).toHaveURL(app + "/boards/household?view=groups#groups")
  await page.goto(app + `/boards/${board.id}?project=${project.id}#kanban`)
  await expect(page.locator("#tasks-submenu-toggle")).toBeHidden()
  await page.reload()
  expect(new URL((await main("progress").getAttribute("href"))!, app).pathname).toContain("/boards/" + board.id)
})

test("Household Goals and Routines consume the Area scope and scoped navigation stays usable on phones and navbar", async ({ boards }, info) => {
  test.setTimeout(90_000)
  const { page, app } = boards
  const area = await post(boards, "/areas", { name: "Study" })
  const otherArea = await post(boards, "/areas", { name: "Garden" })
  await post(boards, "/goals", { title: "Study goal", area_id: area.id })
  await post(boards, "/goals", { title: "Garden goal", area_id: otherArea.id })
  await post(boards, "/habits", { name: "Study routine", area_id: area.id })
  await post(boards, "/habits", { name: "Garden routine", area_id: otherArea.id })
  for (const width of [320, 375]) {
    await page.setViewportSize({ width, height: 780 })
    await page.goto(app + `/boards/household?area=${area.id}#kanban`)
    const workspace = page.getByRole("navigation", { name: "Board workspace", exact: true })
    expect(new URL((await page.locator('#mobile-tab-bar [data-page="tasks"]').getAttribute("href"))!, app).searchParams.get("area")).toBe(area.id)
    await workspace.getByRole("link", { name: "Goals", exact: true }).click()
    await expect(page.locator("#goals-tab-root")).toContainText("Study goal")
    await expect(page.locator("#goals-tab-root")).not.toContainText("Garden goal")
    expect(new URL(page.url()).searchParams.get("area_id")).toBe(area.id)
    await workspace.getByRole("link", { name: "Routines", exact: true }).click()
    await expect(page.locator("#habits-shell")).toContainText("Study routine")
    await expect(page.locator("#habits-shell")).not.toContainText("Garden routine")
    expect(new URL(page.url()).searchParams.get("area_id")).toBe(area.id)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await page.screenshot({ path: info.outputPath(`scoped-routines-${width}.png`), fullPage: true })
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" })))
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-appearance-navigation", "navbar")
  await expect(page.getByRole("navigation", { name: "Board workspace", exact: true })).toBeVisible()
  await page.getByRole("navigation", { name: "Board workspace", exact: true }).getByRole("link", { name: "Tasks", exact: true }).click()
  expect(new URL(page.url()).searchParams.get("area")).toBe(area.id)
})


base("real Household Astro swaps retain the sidebar and update its scoped destinations", async ({ page, request, baseURL }) => {
  base.skip(shouldSkipBrowserSpecs(), "Requires the direct local Astro app")
  const response = await request.post("/api/areas", { data: { name: "Direct study" } })
  expect(response.status()).toBe(201)
  const area = await response.json()
  await page.goto(`/boards/household?area=${area.id}#kanban`)
  await page.locator("#sidebar").evaluate(node => { node.dataset.continuityProbe = "retained" })
  await page.evaluate(() => {
    const state = window as typeof window & { boardNavigationSwaps?: number }
    state.boardNavigationSwaps = 0
    document.addEventListener("astro:after-swap", () => { state.boardNavigationSwaps!++ })
  })
  await page.getByRole("navigation", { name: "Board workspace", exact: true }).getByRole("link", { name: "Goals", exact: true }).click()
  await expect(page.locator("#goals-tab-root")).toHaveAttribute("data-area-id", area.id)
  await expect(page.locator("#sidebar")).toHaveAttribute("data-continuity-probe", "retained")
  expect(await page.evaluate(() => (window as typeof window & { boardNavigationSwaps?: number }).boardNavigationSwaps)).toBeGreaterThan(0)
  const main = (key: string) => page.locator(`.sidebar [data-page="${key}"]`).first()
  expect(new URL((await main("tasks").getAttribute("href"))!, baseURL).searchParams.get("area")).toBe(area.id)
  await main("tasks").click()
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  await expect(page.locator("#sidebar")).toHaveAttribute("data-continuity-probe", "retained")
  await main("planning").click()
  expect(new URL(page.url()).searchParams.get("area")).toBe(area.id)
  await expect(page.locator("#sidebar")).toHaveAttribute("data-continuity-probe", "retained")
  await main("progress").click()
  await expect(page.locator("#goals-tab-root")).toHaveAttribute("data-area-id", area.id)
  await expect(page.locator("#sidebar")).toHaveAttribute("data-continuity-probe", "retained")
})
