import { type ChildProcess } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built app")
test.use({ trace: "retain-on-failure" })

let work: string
let child: ChildProcess
let browser: Browser
let context: BrowserContext
let page: Page
let app: string
let origin: string
let boardId: string
let areaId: string
let headers: Record<string, string>
let fixtureLog = ""

test.beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "board-project-pagination-"))
  child = startCoreFixture(work, false, undefined, undefined, work)
  const recordLog = (chunk: Buffer) => { fixtureLog = (fixtureLog + chunk.toString()).slice(-65_536) }
  child.stdout?.on("data", recordLog)
  child.stderr?.on("data", recordLog)
  const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
  origin = `https://127.0.0.1:${fixture.port}`
  app = origin + fixture.configuredPath
  browser = await launchPinBrowser(work)
  const owner = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
  await owner.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
  const directory = await owner.request.get(app + "/api/boards")
  expect(directory.ok()).toBe(true)
  headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
  const created = await owner.request.post(app + "/api/boards", { headers, data: { name: "Pagination Board" } })
  expect(created.status(), await created.text()).toBe(201)
  boardId = (await created.json()).id
  const area = await owner.request.post(`${app}/api/boards/${boardId}/planning`, {
    headers, data: { action: "area", title: "Workbench" },
  })
  expect(area.ok(), await area.text()).toBe(true)
  const planning = await (await owner.request.get(`${app}/api/boards/${boardId}`)).json()
  areaId = planning.planning.areas.find((row: { name: string }) => row.name === "Workbench").id
  const db = new DatabaseSync(join(work, "pins.db"))
  try {
    const insert = db.prepare("INSERT INTO projects (id, title, area_id, owner_board_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 1)")
    for (let index = 0; index < 65; index++) {
      insert.run(`paging-${index}`, `Project ${String(index).padStart(2, "0")}${index === 0 ? " <img src=x onerror=alert(1)>" : ""}`, areaId, boardId, index)
    }
  } finally { db.close() }
  await owner.close()
})

test.beforeEach(async () => {
  context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, viewport: { width: 1240, height: 900 }, serviceWorkers: "block" })
  await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
  page = await context.newPage()
  page.setDefaultTimeout(8_000)
  await page.goto(`${app}/boards/${boardId}?area=${areaId}`)
})

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page) {
    await page.screenshot({ path: info.outputPath("pagination-failure.png"), fullPage: true })
    await info.attach("fixture-runtime.log", { body: fixtureLog, contentType: "text/plain" })
  }
  await context?.close()
})

test.afterAll(async () => {
  await browser?.close()
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await once(child, "exit")
  }
  if (work) await rm(work, { recursive: true, force: true })
})

const projects = () => page.locator(`[data-board-projects="${areaId}"]`)
const projectRow = () => projects().locator("..")
const links = () => projects().locator(":scope > [data-group-choice]")
const projectLinks = () => links().locator("a[data-project-id]")
const pager = () => projects().getByRole("button", { name: "Show more Projects", exact: true })
const projectRequest = (url: string) => {
  const parsed = new URL(url)
  return parsed.pathname.endsWith(`/api/boards/${boardId}`) && parsed.searchParams.get("area") === areaId
}

async function openProjects() {
  await page.getByRole("button", { name: "Projects in Workbench", exact: true }).press("Enter")
}

test("announces initial Project loading and cancels a closed disclosure", async () => {
  const held = deferred<void>()
  const release = deferred<void>()
  await page.route(url => projectRequest(url.href), async route => {
    held.resolve()
    await release.promise
    await route.continue().catch(() => {})
  })
  try {
    await openProjects()
    await held.promise
    await expect(projects()).toHaveAttribute("aria-busy", "true")
    await expect(projectRow().locator(':scope > [role="status"]')).toHaveText("Loading Projects…")
    await expect(projects().locator('[role="status"]')).toHaveCount(0)
    await page.getByRole("button", { name: "Projects in Workbench", exact: true }).press("Enter")
    release.resolve()
    await expect(projects()).toBeHidden()
    await expect(projectRow().locator(':scope > [role="status"]')).toHaveCount(0)
    await expect(links()).toHaveCount(0)
    await page.unrouteAll({ behavior: "wait" })
    await openProjects()
    await expect(links()).toHaveCount(30)
    await expect(projects()).toHaveAttribute("aria-busy", "false")
  } finally { release.resolve() }
})

test("retains the first Project page and retries the failed cursor with keyboard focus", async () => {
  // Regression: sidebar Project paging discarded existing choices and keyboard focus.
  // Found by /qa on 2026-11-18; source audit: board-f3fa-audit/UI-REVIEW.md.
  await openProjects()
  await expect(links()).toHaveCount(30)
  const attempted: string[] = []
  let fail = true
  await page.route(url => projectRequest(url.href) && url.searchParams.has("after"), async route => {
    attempted.push(new URL(route.request().url()).searchParams.get("after")!)
    if (fail) {
      fail = false
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary fixture failure" }) })
    } else await route.continue()
  })
  await pager().press("Enter")
  const retry = projects().getByRole("button", { name: "Try loading Projects again", exact: true })
  await expect(retry).toBeVisible()
  await expect(links()).toHaveCount(30)
  await expect(retry).toBeFocused()
  await expect(projectRow().locator(':scope > [role="status"]')).toContainText("Could not load Projects")
  await expect(projects().locator('[role="status"]')).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath("pagination-retry-after.png"), fullPage: true })
  const saved = page.waitForResponse(response => projectRequest(response.url()) && response.status() === 200 && new URL(response.url()).searchParams.has("after"))
  await retry.press("Enter")
  expect((await saved).ok()).toBe(true)
  await expect(links()).toHaveCount(60)
  expect(attempted).toHaveLength(2)
  expect(attempted[1]).toBe(attempted[0])
  await expect(projectLinks().nth(30)).toBeFocused()
  await page.screenshot({ path: test.info().outputPath("pagination-focus-after.png"), fullPage: true })
  await expect(projects().locator("img")).toHaveCount(0)
  await expect(projectLinks().first()).toContainText("<img src=x onerror=alert(1)>")
  await expect(projectLinks().first()).toHaveAttribute("href", `${new URL(app).pathname}/boards/${boardId}?project=paging-0&from=${areaId}`)
})

test("hands focus to new Projects only while the replaced pager still owns focus", async () => {
  await openProjects()
  await expect(links()).toHaveCount(30)
  await pager().press("Enter")
  await expect(links()).toHaveCount(60)
  await expect(projectLinks().nth(30)).toBeFocused()
  const held = deferred<void>()
  const release = deferred<void>()
  let requests = 0
  await page.route(url => projectRequest(url.href) && url.searchParams.has("after"), async route => {
    requests++
    held.resolve()
    await release.promise
    await route.continue()
  })
  try {
    await pager().press("Enter")
    await held.promise
    await page.keyboard.press("Enter")
    await page.keyboard.press("Shift+Tab")
    await expect(links().nth(59).getByRole("button", { name: "Add task to Project 59", exact: true })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(links().nth(59).getByRole("button", { name: "Project options - Project 59", exact: true })).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    const previous = projectLinks().nth(59)
    await expect(previous).toBeFocused()
    release.resolve()
    await expect(links()).toHaveCount(65)
    await expect(previous).toBeFocused()
    await expect(pager()).toHaveCount(0)
    expect(requests).toBe(1)
    expect(await links().evaluateAll(rows => new Set(rows.map(row => (row as HTMLElement).dataset.groupChoice)).size)).toBe(65)
  } finally { release.resolve() }
})

test("an empty initial failure retries from the first Project page", async () => {
  let fail = true
  const cursors: (string | null)[] = []
  await page.route(url => projectRequest(url.href), async route => {
    cursors.push(new URL(route.request().url()).searchParams.get("after"))
    if (fail) {
      fail = false
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
    } else await route.continue()
  })
  await openProjects()
  const retry = projects().getByRole("button", { name: "Try loading Projects again", exact: true })
  await expect(retry).toBeVisible()
  await expect(links()).toHaveCount(0)
  await retry.press("Enter")
  await expect(links()).toHaveCount(30)
  expect(cursors).toEqual([null, null])
  await expect(projectLinks().first()).toBeFocused()
})

for (const level of ["Area", "Project"] as const) {
  for (const moveOutside of [false, true]) {
    test(`an empty ${level} retry ${moveOutside ? "preserves outside focus" : "returns focus to its disclosure"}`, async () => {
      const board = page.locator(`[data-named-board-shortcut="${boardId}"]`)
      const toggle = board.getByRole("button", { name: level === "Area" ? "Areas in Pagination Board" : "Projects in Workbench", exact: true })
      await expect(board.getByRole("button", { name: "Projects in Workbench", exact: true })).toBeVisible()
      if (level === "Area") await toggle.press("Enter")
      const groups = level === "Area" ? board.locator(":scope > [data-board-groups]") : projects()
      const initialHeld = deferred<void>()
      const failInitial = deferred<void>()
      const retryHeld = deferred<void>()
      const emptyRetry = deferred<void>()
      const cursors: (string | null)[] = []
      await page.route(url => url.pathname.endsWith(`/api/boards/${boardId}`)
        && url.searchParams.get("view") === "groups"
        && (level === "Area" ? !url.searchParams.has("area") : url.searchParams.get("area") === areaId), async route => {
        cursors.push(new URL(route.request().url()).searchParams.get("after"))
        if (cursors.length === 1) {
          initialHeld.resolve()
          await failInitial.promise
          await route.fulfill({ status: 503, contentType: "application/json", body: "{}" })
        } else {
          retryHeld.resolve()
          await emptyRetry.promise
          await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], selected: null, next_cursor: null }) })
        }
      })
      try {
        await toggle.press("Enter")
        await initialHeld.promise
        await expect(groups).toHaveAttribute("aria-busy", "true")
        failInitial.resolve()
        const retry = groups.getByRole("button", { name: `Try loading ${level}s again`, exact: true })
        await expect(retry).toBeVisible()
        await expect(groups.locator(":scope > [data-group-choice]")).toHaveCount(0)
        await retry.press("Enter")
        await retryHeld.promise
        const outside = board.locator(":scope > .sidebar-board-row > a")
        if (moveOutside) {
          await outside.focus()
          await expect(outside).toBeFocused()
        }
        emptyRetry.resolve()
        await expect(groups).toHaveAttribute("aria-busy", "false")
        await expect(groups).toContainText(`No ${level}s yet`)
        await expect(groups.locator(":scope > [data-group-choice]")).toHaveCount(0)
        await expect(retry).toHaveCount(0)
        expect(cursors).toEqual([null, null])
        await test.info().attach("empty-retry-focus.json", {
          body: JSON.stringify(await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent }))),
          contentType: "application/json",
        })
        await expect(moveOutside ? outside : toggle).toBeFocused()
      } finally {
        failInitial.resolve()
        emptyRetry.resolve()
      }
    })
  }
}

for (const status of [401, 403, 404]) {
  test(`clears private sidebar projections after a ${status} Project response`, async () => {
    await openProjects()
    await expect(links()).toHaveCount(30)
    await page.route(url => projectRequest(url.href) && url.searchParams.has("after"), route => route.fulfill({
      status, contentType: "application/json", body: JSON.stringify({ error: "Board unavailable" }),
    }))
    await pager().press("Enter")
    await expect(page.locator(`[data-named-board-shortcut="${boardId}"]`)).toHaveCount(0)
    await expect(page.locator('[data-sidebar-boards] a[href*="project=paging-"]')).toHaveCount(0)
  })
}

test("a real account revocation removes the loaded private Project projection", async () => {
  test.setTimeout(100_000)
  const owner = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
  try {
    await owner.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const membership = `${app}/api/boards/${boardId}`
    const grantMember = () => owner.request.patch(membership, { headers, data: { action: "member", memberId: "fixture-member-two", role: "viewer" } })
    let grant = await grantMember()
    if (grant.status() === 429) {
      const retryAfter = Number(grant.headers()["retry-after"])
      expect(retryAfter).toBeGreaterThan(0)
      expect(retryAfter).toBeLessThanOrEqual(60)
      await setTimeout(retryAfter * 1000)
      grant = await grantMember()
    }
    expect(grant.status(), await grant.text()).toBe(200)
    await context.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    await page.goto(`${app}/boards/${boardId}?area=${areaId}`)
    await openProjects()
    await expect(links()).toHaveCount(30)
    const revoke = await owner.request.patch(membership, { headers, data: { action: "member", memberId: "fixture-member-two", role: null } })
    expect(revoke.status(), await revoke.text()).toBe(200)
    const denied = page.waitForResponse(response => projectRequest(response.url()) && new URL(response.url()).searchParams.has("after"))
    await pager().press("Enter")
    expect((await denied).status()).toBe(404)
    await expect(page.locator(`[data-named-board-shortcut="${boardId}"]`)).toHaveCount(0)
  } finally { await owner.close() }
})

test("an empty continuation retry retains its 30 loaded Projects and returns focus to the disclosure", async () => {
  await openProjects()
  await expect(links()).toHaveCount(30)
  const loadedIds = await links().evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.groupChoice))
  const cursors: (string | null)[] = []
  await page.route(url => projectRequest(url.href) && url.searchParams.has("after"), async route => {
    cursors.push(new URL(route.request().url()).searchParams.get("after"))
    await route.fulfill(cursors.length === 1
      ? { status: 503, contentType: "application/json", body: "{}" }
      : { status: 200, contentType: "application/json", body: JSON.stringify({ items: [], next_cursor: null }) })
  })
  await pager().press("Enter")
  const retry = projects().getByRole("button", { name: "Try loading Projects again", exact: true })
  await expect(retry).toBeFocused()
  await expect(links()).toHaveCount(30)
  await retry.press("Enter")
  await expect(retry).toHaveCount(0)
  await expect(pager()).toHaveCount(0)
  await expect(links()).toHaveCount(30)
  expect(await links().evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.groupChoice))).toEqual(loadedIds)
  expect(cursors).toHaveLength(2)
  expect(cursors[0]).toBeTruthy()
  expect(cursors[1]).toBe(cursors[0])
  await expect(page.getByRole("button", { name: "Projects in Workbench", exact: true })).toBeFocused()
})
