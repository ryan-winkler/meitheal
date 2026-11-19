import { execFileSync, fork } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type APIRequestContext } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built app and an isolated ingress fixture")

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
let fixtureDir: string
let server: ReturnType<typeof fork>
let request: APIRequestContext
let origin: string
let prefix: string

test.beforeAll(async ({ playwright }) => {
  fixtureDir = await mkdtemp(join(tmpdir(), "meitheal-work-surfaces-"))
  const env = {
    PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(fixtureDir, "meitheal.db")}`,
    MEITHEAL_ACTIVE_MEMBER_FIXTURE: "1",
  }
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
  server = fork(fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url)), {
    cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"],
  })
  const [info] = await once(server, "message", { signal: AbortSignal.timeout(10000) })
  origin = `http://127.0.0.1:${info.port}`
  prefix = info.configuredPath
  request = await playwright.request.newContext({ extraHTTPHeaders: { cookie: "feedback-fixture=admin", origin } })
})

test.afterAll(async () => {
  await request?.dispose()
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, "exit")
    server.kill()
    await exited
  }
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true })
})

test("Kanban color picker is visible, saves, reloads, rejects failed changes and clears", async ({ browser }) => {
  const base = origin + prefix
  const created = await request.post(base + "/api/tasks", { data: { title: "Household card color fixture", status: "active" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const context = await browser.newContext({ viewport: { width: 320, height: 844 }, serviceWorkers: "block", reducedMotion: "reduce", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    await page.goto(base + "/tasks#kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const card = page.locator(`.kanban-card[data-id="${id}"]`)
    const color = card.getByRole("button", { name: /^Set color for:/ })
    await color.click()
    const red = page.getByRole("radio", { name: "Set color: Red", exact: true })
    await expect(red).toBeVisible()
    await expect(red).toHaveCSS("background-color", "rgb(239, 68, 68)")
    await expect.poll(() => red.evaluate(element => {
      const box = element.getBoundingClientRect()
      return box.width >= 44 && box.height >= 44 && box.left >= 0 && box.right <= innerWidth
        && element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
    })).toBe(true)
    await red.click()
    await expect(card).toHaveCSS("border-inline-start-color", "rgb(239, 68, 68)")
    await page.reload()
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await expect(card).toHaveCSS("border-inline-start-color", "rgb(239, 68, 68)")
    await color.click()
    await expect(red).toHaveAttribute("aria-checked", "true")
    await page.route(`**/api/tasks/${id}`, route => route.fulfill({ status: 503, json: { error: "Fixture rejected the color change" } }), { times: 1 })
    await page.getByRole("radio", { name: "Set color: Blue", exact: true }).click()
    await expect(page.locator("#toast-container")).toContainText("Failed to set color")
    await expect(card).toHaveCSS("border-inline-start-color", "rgb(239, 68, 68)")
    await color.click()
    await page.getByRole("button", { name: /Clear color/ }).click()
    await expect(color).toHaveAttribute("data-color", "")
    expect((await (await request.get(base + `/api/tasks/${id}`)).json()).color).toBeNull()
    await page.reload()
    await expect(color).toHaveAttribute("data-color", "")
  } finally {
    await context.close()
    await request.delete(base + `/api/tasks/${id}`)
  }
})

test("legacy Projects stays inside ingress and reaches Boards", async ({ browser }) => {
  for (const route of ["/projects", "/projects/no-such-project", "/areas"]) {
    const response = await request.get(origin + prefix + route, { maxRedirects: 0 })
    expect(response.status()).toBe(302)
    expect(response.headers().location).toMatch(new RegExp("^" + prefix + "/"))
  }
  const context = await browser.newContext({ extraHTTPHeaders: { cookie: "feedback-fixture=admin" } })
  try {
    const page = await context.newPage()
    const response = await page.goto(origin + prefix + "/projects")
    expect(response!.status()).toBe(200)
    await expect(page).toHaveURL(origin + prefix + "/boards")
    await expect(page.getByRole("heading", { name: "Boards", exact: true })).toBeVisible()
    await page.locator("#sidebar").getByRole("link", { name: "Today", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(prefix + "/today"))
  } finally { await context.close() }
})

test("Home Assistant panel address follows embedded routes, bookmarks and Back", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const hostPath = origin + "/fixture-ha-panel"
    await page.route(hostPath + "**", route => route.fulfill({
      contentType: "text/html",
      body: `<home-assistant></home-assistant><iframe title="Meitheal" src="${origin}${prefix}/" style="width:100%;height:900px;border:0"></iframe>`,
    }))
    await page.goto(hostPath + "?meitheal=" + encodeURIComponent("/tasks#kanban"))
    const app = page.frameLocator("iframe")
    await expect(app.locator("#tasks-view-kanban")).toBeVisible()
    await app.locator("#sidebar").getByRole("link", { name: "Today", exact: true }).click()
    await expect.poll(() => new URL(page.url()).searchParams.get("meitheal")).toBe("/today")
    await expect(app.locator("#today-overview")).toBeVisible()
    await page.reload()
    await expect(app.locator("#today-overview")).toBeVisible()
    await app.locator("#sidebar").getByRole("link", { name: "Tasks", exact: true }).click()
    await expect(app.locator("#tasks-view-kanban")).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get("meitheal")).toBe("/tasks#kanban")
    await page.goBack()
    await expect(app.locator("#today-overview")).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get("meitheal")).toBe("/today")
    await app.getByRole("link", { name: "Meitheal Home", exact: true }).click()
    await expect(app.locator("#dashboard-shell")).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get("meitheal")).toBe("/?view=dashboard")
  } finally { await context.close() }
})

test("an explicit Home Assistant panel bookmark wins over setup and same-account ingress state", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const scope = createHash("sha256").update("meitheal-workspace\0").update("fixture-admin").digest("hex")
    await page.addInitScript(({ key, ingress }) => {
      if (location.pathname !== ingress + "/") return
      sessionStorage.setItem("meitheal-navigation-state:" + key, JSON.stringify({ path: "/today", scrollY: 0, timestamp: Date.now() }))
      localStorage.setItem("meitheal-workspace-v1:" + key, JSON.stringify({ firstPage: "tasks", acknowledged: true }))
    }, { key: scope, ingress: prefix })
    const hostPath = origin + "/fixture-ha-priority"
    await page.route(hostPath + "**", route => route.fulfill({
      contentType: "text/html",
      body: `<home-assistant></home-assistant><iframe title="Meitheal" src="${origin}${prefix}/" style="width:100%;height:900px;border:0"></iframe>`,
    }))
    await page.goto(hostPath + "?meitheal=" + encodeURIComponent("/?view=dashboard"))
    const frame = page.frameLocator("iframe")
    await expect(frame.locator("#dashboard-shell")).toBeVisible()
    await expect(frame.locator("html")).toHaveAttribute("data-workspace-scope", scope)
    await expect.poll(() => new URL(page.url()).searchParams.get("meitheal")).toBe("/?view=dashboard")
  } finally { await context.close() }
})

test("setup preferences remain separate for two Home Assistant accounts in one browser", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
  const url = origin + prefix + "/setup"
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const response = await page.goto(url)
    expect(response?.headers()["cache-control"]).toContain("no-store")
    const firstScope = await page.locator("html").getAttribute("data-workspace-scope")
    expect(firstScope).toMatch(/^[a-f0-9]{64}$/)
    await page.getByRole("combobox", { name: "Theme" }).selectOption("dark")
    await page.getByRole("button", { name: "Use Simple" }).click()
    await expect(page).toHaveURL(new RegExp(prefix + "/\\?view=dashboard"))

    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await page.goto(url)
    const otherScope = await page.locator("html").getAttribute("data-workspace-scope")
    expect(otherScope).toMatch(/^[a-f0-9]{64}$/)
    expect(otherScope).not.toBe(firstScope)
    await page.getByRole("combobox", { name: "Theme" }).selectOption("light")
    await page.getByRole("button", { name: "Use Simple" }).click()
    await expect(page).toHaveURL(new RegExp(prefix + "/\\?view=dashboard"))
    const values = await page.evaluate(keys => keys.map(key =>
      JSON.parse(localStorage.getItem("meitheal-workspace-v1:" + key) ?? "null")?.theme), [firstScope, otherScope])
    expect(values).toEqual(["dark", "light"])
  } finally { await context.close() }
})

test("a reflected panel route expires on account change but an opened bookmark still wins", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    const page = await context.newPage()
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const hostPath = origin + "/fixture-ha-account"
    const bookmark = hostPath + "?meitheal=" + encodeURIComponent("/today")
    await page.route(hostPath + "**", route => route.fulfill({
      contentType: "text/html",
      body: `<home-assistant></home-assistant><iframe title="Meitheal" src="${prefix}//" style="width:100%;height:900px;border:0"></iframe>`,
    }))
    await page.goto(hostPath)
    const app = page.frameLocator("iframe")
    await expect(app.getByRole("link", { name: "Set up Meitheal" })).toBeVisible()
    await app.locator("#sidebar").getByRole("link", { name: "Today", exact: true }).click()
    await expect(app.locator("#today-overview")).toBeVisible()
    await expect(page).toHaveURL(bookmark)
    const memberScope = createHash("sha256").update("meitheal-workspace\0").update("fixture-member").digest("hex")
    await page.evaluate(scope => {
      localStorage.setItem("meitheal-workspace-v1:" + scope, JSON.stringify({ firstPage: "tasks" }))
    }, memberScope)
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    await page.reload()
    await expect(app.locator("html")).toHaveAttribute("data-workspace-scope", memberScope)
    await expect(app.locator("#tasks-view-kanban")).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get("meitheal")).toBe("/tasks?view=kanban#kanban")
    await page.goto(bookmark)
    await expect(app.locator("#today-overview")).toBeVisible()
  } finally { await context.close() }
})

test("Board creation distinguishes access pending from an unconfirmed response", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const form = page.locator('form[data-board-form="create"]')
    let outcome = { status: 201, contentType: "text/plain", body: "unreadable" }
    await page.route("**/api/boards", route => route.request().method() === "POST"
      ? route.fulfill(outcome) : route.continue())
    for (const pending of [false, true]) {
      if (pending) outcome = { status: 202, contentType: "application/json", body: JSON.stringify({ accessPending: true }) }
      await page.goto(origin + prefix + "/boards")
      await page.locator(".board-add summary").click()
      await form.locator('input[name="name"]').fill("Weekend plans")
      await form.getByRole("combobox").selectOption("chores")
      await form.getByRole("button", { name: "Create Board" }).click()
      await expect(form.getByRole("status")).toContainText(pending
        ? "Its access is still being verified" : "Could not confirm whether the Board was created")
      await expect(form.getByRole("button", { name: "Create Board" })).toBeHidden()
    }
  } finally { await context.close() }
})
