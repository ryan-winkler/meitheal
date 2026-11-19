import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base, type BrowserContext, type Page } from "@playwright/test"
import { boardNavigationLinks, readBoardNavigationContext } from "../../apps/web/src/lib/board-workspace"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

base("Board navigation preserves placement and never maps a named workspace to Household", () => {
  const context = readBoardNavigationContext(new URL("https://example.test/boards/work?project=lighting&from=study&view=groups&section=goals"))!
  const links = boardNavigationLinks(context)
  for (const href of [links.tasks, links.planning]) {
    const url = new URL(href, "https://example.test")
    expect(url.pathname).toBe("/boards/work")
    expect(url.searchParams.get("project")).toBe("lighting")
    expect(url.searchParams.get("from")).toBe("study")
  }
  for (const href of [links.dashboard, links.today, links.upcoming, links.progress, links.pillars, links.routines]) {
    const url = new URL(href, "https://example.test")
    expect(url.searchParams.get("board_id")).toBe("work")
    expect(url.searchParams.get("project_id")).toBe("lighting")
  }
  for (const href of [links.activity, links.mentionInbox, links.pinned, links.review]) {
    expect(new URL(href, "https://example.test").searchParams.get("board_id")).toBe("work")
  }
  expect(new URL(links.tasks, "https://example.test").searchParams.has("section")).toBe(false)
  expect(new URL(links.progress, "https://example.test").hash).toBe("#goals")
  expect(readBoardNavigationContext(new URL("https://example.test/boards"))).toBeUndefined()
  const household = boardNavigationLinks({ boardId: "household", area: "study", project: "lighting" })
  expect(household.progress).toBe("/progress?board_id=household&project_id=lighting#goals")
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

for (const kind of ["Household", "named"] as const) {
  test(`${kind} Board preserves its own Epic ticket, Project Area and keyboard swimlanes`, async ({ boards }) => {
    test.setTimeout(45_000)
    const { page, app } = boards
    const workspace = kind === "named" ? await namedWorkspace(boards) : null
    const boardId: string = workspace?.board.id ?? "household"
    const scoped = { ...boards, headers: { ...boards.headers, "x-meitheal-board-id": boardId } }
    const area = workspace?.area ?? await post(scoped, "/areas", { name: "Study" })
    const project = workspace?.project ?? await post(scoped, "/projects", { title: "Desk light", area_id: area.id })
    const otherArea = await post(scoped, "/areas", { name: "Garden" })
    const epic = await post(scoped, "/tasks", { title: "Restore the study", task_type: "epic", status: "complete" })
    const child = await post(scoped, "/tasks", { title: "Grouping fixture study", parent_id: epic.id, project_id: project.id })
    const other = await post(scoped, "/tasks", { title: "Grouping fixture garden", area_id: otherArea.id })
    expect(epic.ticket_key).toMatch(/^[A-Z0-9]+-\d+$/)
    if (kind === "Household") expect(epic.ticket_key).toMatch(/^MTH-/)
    else expect(epic.ticket_key).not.toMatch(/^MTH-/)

    const search = "Grouping fixture"
    await page.goto(`${app}/boards/${boardId}?${new URLSearchParams({ search, groupBy: "none" })}#kanban`)
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await page.locator("#kanban-group-by-dropdown summary").click()
    await page.getByRole("button", { name: "By Epic", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "epic")
    const group = (key: string) => page.locator(`.swimlane-group[data-swimlane-type="${key}"]`).filter({ has: page.locator(".kanban-card") })
    const epicGroup = group(`epic:${epic.id}`)
    const childCard = page.locator(`.kanban-card[data-id="${child.id}"]`)
    const otherCard = page.locator(`.kanban-card[data-id="${other.id}"]`)
    const epicLabel = `${epic.title} (${epic.ticket_key})`
    const heading = epicGroup.locator(".swimlane-header")
    await expect(epicGroup.locator(".swimlane-label")).toHaveText(epicLabel)
    await expect(epicGroup.locator(`.kanban-card[data-id="${child.id}"]`)).toBeVisible()
    await heading.press("Enter")
    await expect(heading).toBeFocused()
    await expect(childCard).toBeHidden()
    await expect(otherCard).toBeVisible()
    await page.reload()
    await expect(heading).toHaveAttribute("aria-expanded", "false")
    await heading.press("Space")
    await expect(childCard).toBeVisible()

    const views = page.getByRole("navigation", { name: "Task views" })
    await views.getByRole("link", { name: "Table", exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname.endsWith(`/boards/${boardId}`) && url.searchParams.get("search") === search)
    await expect(page.locator(`.group-header-row[data-group-key="epic:${epic.id}"] .group-label`)).toHaveText(epicLabel)
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page).toHaveURL(url => url.pathname.endsWith(`/boards/${boardId}`) && url.searchParams.get("groupBy") === "epic" && url.searchParams.get("search") === search)
    await expect(epicGroup.locator(".swimlane-label")).toHaveText(epicLabel)
    await expect(epicGroup.locator(`.kanban-card[data-id="${child.id}"]`)).toBeVisible()
    await page.locator("#kanban-group-by-dropdown summary").click()
    await page.getByRole("button", { name: "By Area", exact: true }).click()
    await expect(group(area.id).locator(`.kanban-card[data-id="${child.id}"]`)).toBeVisible()
    await expect(group(otherArea.id).locator(`.kanban-card[data-id="${other.id}"]`)).toBeVisible()
  })
}

test("a committed Goal share returns a receipt and appears in the receiving Board", async ({ boards }) => {
  const source = await post(boards, "/boards", { name: "Sharing source" })
  const target = await post(boards, "/boards", { name: "Sharing destination" })
  const scoped = (id: string) => ({ ...boards, headers: { ...boards.headers, "x-meitheal-board-id": id } })
  const area = await post(scoped(target.id), "/areas", { name: "Receiving study" })
  const title = "Cross-Board fixture Goal"
  const goal = await post(scoped(source.id), "/goals", { title })
  const change = { action: "goal-share", id: goal.id, enabled: true,
    target: { kind: "area", boardId: target.id, areaId: area.id } }
  const receipt = await post(boards, `/boards/${source.id}/planning`, change)
  expect(receipt).toEqual({ ok: true, accessPending: false })
  const repeated = await post(boards, `/boards/${source.id}/planning`, change)
  expect(repeated).toEqual(receipt)
  const receiving = await boards.member.request.get(`${boards.app}/api/goals?board_id=${target.id}&area_id=${area.id}`)
  expect(receiving.ok()).toBe(true)
  expect((await receiving.json()).goals).toEqual([expect.objectContaining({ id: goal.id, title, shared: true })])
})

test("Household is a peer Board and every scoped workspace destination retains the selected Board and Project", async ({ boards }, info) => {
  test.setTimeout(90_000)
  const { page, app } = boards
  const { board, project, area } = await namedWorkspace(boards)
  await page.goto(app + "/boards")
  const grid = page.locator(".board-directory-grid")
  await expect(grid.locator(':scope > [data-board-card="household"]')).toHaveCount(1)
  await expect(grid.locator(`:scope > [data-board-card="${board.id}"]`)).toHaveCount(1)
  await expect(page.getByRole("navigation", { name: "Planning", exact: true })).toHaveCount(0)
  const sameSidebarRows = page.locator("[data-sidebar-boards] > [data-named-board-shortcut]")
  await expect(sameSidebarRows).toHaveCount(2)
  for (const id of ["household", board.id]) {
    const row = sameSidebarRows.and(page.locator(`[data-named-board-shortcut="${id}"]`))
    await expect(row.locator(".sidebar-board-row")).toHaveCSS("border-top-width", "0px")
    await expect(row.getByRole("button", { name: /^Areas in / })).toBeVisible()
  }
  await page.screenshot({ path: info.outputPath("one-board-collection.png"), fullPage: true })

  await page.goto(app + `/boards/${board.id}?project=${project.id}&from=${area.id}#kanban`)
  const workspace = page.getByRole("navigation", { name: "Board workspace", exact: true })
  const main = (key: string) => page.locator(`.sidebar [data-page="${key}"]`).first()
  await expect(page.locator("#tasks-submenu-toggle")).toBeVisible()
  for (const key of ["dashboard", "today", "upcoming", "progress"]) {
    await expect.poll(async () => {
      const href = (await main(key).getAttribute("href"))!
      const url = new URL(href, app)
      return [url.searchParams.get("board_id"), url.searchParams.get("project_id")]
    }).toEqual([board.id, project.id])
  }
  for (const key of ["tasks", "planning"]) {
    const url = new URL((await main(key).getAttribute("href"))!, app)
    expect(url.pathname).toContain("/boards/" + board.id)
    expect(url.searchParams.get("project")).toBe(project.id)
  }
  await workspace.getByRole("link", { name: "Goals", exact: true }).click()
  await expect(page.locator("#goals-tab-root")).toContainText("Better lighting")
  expect(new URL(page.url()).searchParams.get("project_id")).toBe(project.id)
  expect(new URL(page.url()).hash).toBe("#goals")
  await workspace.getByRole("link", { name: "Routines", exact: true }).click()
  await expect(page.locator("#habits-shell")).toContainText("Check desk")
  expect(new URL(page.url()).searchParams.get("project_id")).toBe(project.id)
  await main("planning").click()
  await expect(page.getByRole("heading", { name: "Desk light", exact: true, level: 1 })).toBeVisible()
  expect(new URL(page.url()).searchParams.get("project")).toBe(project.id)
  await main("tasks").click()
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  const inProjectView = (view: string) => page.waitForURL(url => url.pathname.endsWith("/boards/" + board.id) &&
    url.searchParams.get("project") === project.id && (url.searchParams.get("view") === view || url.hash === "#" + view))
  await page.keyboard.press("c")
  await inProjectView("calendar")
  await page.keyboard.press("t")
  await inProjectView("table")
  await page.keyboard.press("?")
  await expect(page.locator("#shortcut-modal")).toBeVisible()
  await expect(page.locator('#shortcut-modal [data-shortcut-scope="tasks"]')).toHaveText([
    "Kanban view", "Table view", "Calendar view", "Timeline view",
  ])
  await page.keyboard.press("Escape")
  await page.keyboard.press("n")
  const title = page.locator("#new-task-title-input")
  await expect(title).toBeVisible()
  await title.fill("Project keyboard capture")
  const written = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname.endsWith("/api/tasks"))
  await page.locator("#submit-new-task-btn").click()
  const receipt = await written
  expect(receipt.status()).toBe(201)
  expect(await receipt.json()).toMatchObject({ title: "Project keyboard capture", area_id: area.id, project_id: project.id })
  const inspector = page.getByRole("dialog", { name: "Task detail: Project keyboard capture", exact: true })
  await expect(inspector).toBeVisible()
  await inspector.getByRole("button", { name: "Close detail", exact: true }).press("Enter")
  await expect(inspector).toBeHidden()
  await page.locator('[data-named-board-shortcut="household"]').getByRole("link", { name: "Household", exact: true }).click()
  await expect(page).toHaveURL(url => url.pathname.endsWith("/boards/household"))
  await expect(page.locator("#tasks-submenu-toggle")).toBeVisible()
  await expect.poll(async () => new URL((await main("today").getAttribute("href"))!, app).searchParams.get("board_id")).toBe("household")
  await main("planning").click()
  await expect(page).toHaveURL(app + "/boards/household?view=groups#groups")
  await page.goto(app + `/boards/${board.id}?project=${project.id}#kanban`)
  await expect(page.locator("#tasks-submenu-toggle")).toBeVisible()
  await page.reload()
  await expect.poll(async () => new URL((await main("progress").getAttribute("href"))!, app).searchParams.get("board_id")).toBe(board.id)
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
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const response = await request.post("/api/areas", { headers, data: { name: "Direct study" } })
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
