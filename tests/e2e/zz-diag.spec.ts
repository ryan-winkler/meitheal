import { type ChildProcess } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

test.beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "board-project-pagination-"))
  child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
  origin = `https://127.0.0.1:${fixture.port}`
  app = origin + fixture.configuredPath
  browser = await launchPinBrowser(work)
  const owner = await browser.newContext({ ignoreHTTPSErrors: true })
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
  context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1240, height: 900 }, serviceWorkers: "block" })
  await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
  page = await context.newPage()
  page.setDefaultTimeout(8_000)
  page.on("requestfailed", r => console.log("DIAG FAILED", r.url().slice(-80), r.failure()?.errorText))
  page.on("console", m => { if (m.type() !== "log") console.log("DIAG CONSOLE", m.type(), m.text().slice(0, 300)) })
  page.on("pageerror", e => console.log("DIAG PAGEERROR", e.message.slice(0, 300)))
  page.on("response", r => { if (r.url().includes("/api/")) console.log("DIAG RESP", r.status(), r.url().replace(/^https:\/\/[^/]+/, "").slice(0, 160)) })
  await page.goto(`${app}/boards/${boardId}?area=${areaId}`)
})

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page) await page.screenshot({ path: info.outputPath("pagination-failure.png"), fullPage: true })
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


test("diagnose sidebar Board disclosure", async () => {
  await page.waitForTimeout(6000)
  const state = await page.evaluate(() => ({
    hidden: document.hidden, online: navigator.onLine, width: innerWidth,
    nav: document.documentElement.dataset.appearanceNavigation ?? null,
    childrenHidden: document.querySelector<HTMLElement>("[data-sidebar-board-children]")?.hidden ?? null,
    toggleExpanded: document.querySelector("[data-sidebar-boards-toggle]")?.getAttribute("aria-expanded") ?? null,
    session: Object.fromEntries(Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)])),
    shortcuts: [...document.querySelectorAll("[data-named-board-shortcut]")].map(e => e.outerHTML.slice(0, 1500)),
    sidebarDisplay: getComputedStyle(document.querySelector("#sidebar") ?? document.body).display,
  }))
  console.log("DIAG STATE", JSON.stringify(state, null, 1))
  console.log("DIAG BUTTONS", JSON.stringify(await page.getByRole("button").evaluateAll(els => els.map(e => e.getAttribute("aria-label") ?? e.textContent?.trim()).filter(Boolean).slice(0, 80))))
})
