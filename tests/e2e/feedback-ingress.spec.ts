import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { request as httpRequest, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import AxeBuilder from "@axe-core/playwright"
import { expect, test as base, type APIRequestContext } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
const browserMutation = { "x-meitheal-feedback": "1" }
const test = base.extend<{ liveCore: boolean }>({ liveCore: [false, { option: true }] })
const coreTest = test.extend({ liveCore: true })

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

let work: string
let server: ChildProcess | undefined
let origin: string
let prefix: string

async function startServer(liveCore = false): Promise<void> {
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    MEITHEAL_DB_URL: `file:${path.join(work, "meitheal.db")}`,
    ...(liveCore ? { MEITHEAL_TEST_CORE_USER_LOOKUP: "1" } : {}),
  }
  execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
  server = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const child = server
  const [info] = await Promise.race([
    once(child, "message", { signal: AbortSignal.timeout(10_000) }),
    once(child, "exit").then(([code]) => { throw new Error(`Feedback fixture exited with ${code}`) }),
  ])
  origin = `http://127.0.0.1:${info.port}`
  prefix = info.configuredPath
}

async function stopServer(): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return
  const exited = once(server, "exit")
  server.kill()
  await exited
}

test.beforeEach(async ({ liveCore }) => {
  work = await mkdtemp(path.join(tmpdir(), "meitheal-feedback-ingress-"))
  await startServer(liveCore)
})

test.afterEach(async () => {
  await stopServer()
  await rm(work, { recursive: true, force: true })
})

async function databaseForm(api: APIRequestContext, headers: Record<string, string>) {
  const settings = await api.get(origin + prefix + "/settings", { headers })
  expect(settings.status()).toBe(200)
  expect(settings.headers()["cache-control"]).toBe("private, no-store")
  const token = /name="token" value="([\w.-]+)"/.exec(await settings.text())?.[1]
  expect(token).toBeTruthy()
  return { token: token! }
}

async function setDatabaseCoreRole(role: string) {
  const child = server!
  const reply = once(child, "message", { signal: AbortSignal.timeout(3000) })
  child.send({ type: "database-core-role", role })
  expect((await reply)[0]).toEqual({ type: "database-core-role", role })
}

coreTest("database download checks current Core role without reusing a stale administrator grant", async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: origin })
  const headers = { cookie: "feedback-fixture=admin", origin }
  const endpoint = `${prefix}/api/export/database.sqlite`
  const snapshotDirs = async () => (await readdir(work)).filter(name => name.startsWith(".meitheal-export-"))
  try {
    const form = await databaseForm(api, headers)
    const download = () => api.post(endpoint, { headers, form })
    const users = await api.get(`${prefix}/api/users`, { headers })
    expect((await users.json()).users).toContainEqual(expect.objectContaining({ id: "ha_fixture-admin" }))
    expect((await download()).status()).toBe(200)
    await expect.poll(snapshotDirs).toEqual([])

    for (const role of ["demoted", "inactive", "system", "missing", "malformed", "oversized", "disconnected", "stalled"]) {
      await setDatabaseCoreRole(role)
      const denied = await download()
      expect(denied.status(), role).toBe(["demoted", "inactive", "system", "missing"].includes(role) ? 403 : 503)
      expect(denied.headers()["cache-control"], role).toBe("no-store")
      expect(denied.headers()["content-disposition"], role).toBeUndefined()
      expect(await snapshotDirs(), role).toEqual([])
    }
    await setDatabaseCoreRole("owner")
    expect((await download()).status()).toBe(200)
  } finally {
    await api.dispose()
  }
})

coreTest("database download includes committed writes still in the WAL", async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: origin })
  const dbPath = path.join(work, "meitheal.db")
  const exportPath = `${prefix}/api/export/database.sqlite`
  const admin = { cookie: "feedback-fixture=admin", origin }

  try {
    expect((await api.get(`${prefix}/api/health`, { headers: admin })).ok()).toBe(true)
    const form = await databaseForm(api, admin)
    const source = new DatabaseSync(dbPath)
    try {
      expect(source.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" })
      expect(source.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0, log: 0 })
      const title = "Committed WAL task"
      const created = await api.post(`${prefix}/api/tasks`, { headers: admin, data: { title } })
      expect(created.status()).toBe(201)
      const { id } = await created.json()
      expect(source.prepare("SELECT title FROM tasks WHERE id = ?").get(id)).toMatchObject({ title })

      const rawPath = path.join(work, "raw.sqlite")
      await copyFile(dbPath, rawPath)
      const raw = new DatabaseSync(rawPath, { readOnly: true })
      try {
        expect(raw.prepare("SELECT title FROM tasks WHERE id = ?").get(id)).toBeUndefined()
      } finally {
        raw.close()
      }

      const [get, head] = await Promise.all([api.get(exportPath, { headers: admin }), api.head(exportPath, { headers: admin })])
      for (const response of [get, head]) {
        expect(response.status()).toBe(405)
        expect(response.headers()).toMatchObject({ allow: "POST", "cache-control": "no-store" })
        expect(response.headers()["content-disposition"]).toBeUndefined()
        expect((await response.body()).subarray(0, 16).toString()).not.toBe("SQLite format 3\0")
      }
      expect(await head.body()).toHaveLength(0)
      const alias = await api.post(`${prefix}/api/export/database%2esqlite`, {
        headers: { ...admin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" }, form,
      })
      expect(alias.status()).toBe(404)
      expect((await readdir(work)).filter(name => name.startsWith(".meitheal-export-"))).toEqual([])

      const [first, second] = await Promise.all([
        api.post(exportPath, { headers: admin, form }),
        api.post(exportPath, { headers: admin, form }),
      ])
      const [downloaded, busy] = first.status() === 200 ? [first, second] : [second, first]
      expect(busy.status()).toBe(409)
      expect(busy.headers()["cache-control"]).toBe("no-store")
      expect(downloaded.status()).toBe(200)
      expect(downloaded.headers()).toMatchObject({ "cache-control": "no-store", "content-type": "application/x-sqlite3" })
      expect(downloaded.headers()["content-disposition"]).toMatch(/^attachment; filename=".+\.db"$/)
      const downloadedPath = path.join(work, "downloaded.sqlite")
      await writeFile(downloadedPath, await downloaded.body())
      const snapshot = new DatabaseSync(downloadedPath, { readOnly: true })
      try {
        expect(snapshot.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" })
        expect(snapshot.prepare("SELECT title FROM tasks WHERE id = ?").get(id)).toMatchObject({ title })
      } finally {
        snapshot.close()
      }
      await expect.poll(async () => (await readdir(work)).filter(name => name.startsWith(".meitheal-export-"))).toEqual([])
    } finally {
      source.close()
    }
  } finally {
    await api.dispose()
  }
})

coreTest("a paused database download keeps one snapshot until cancelled", async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: origin })
  const admin = { cookie: "feedback-fixture=admin", origin }
  const exportPath = `${prefix}/api/export/database.sqlite`
  const snapshotDirs = async () => (await readdir(work)).filter(name => name.startsWith(".meitheal-export-"))

  try {
    expect((await api.get(`${prefix}/api/health`, { headers: admin })).ok()).toBe(true)
    const form = await databaseForm(api, admin)
    const writer = new DatabaseSync(path.join(work, "meitheal.db"))
    try {
      writer.exec(`CREATE TABLE export_fixture (payload BLOB);
        WITH RECURSIVE block(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM block WHERE n < 3072)
        INSERT INTO export_fixture SELECT zeroblob(4096) FROM block;`)
    } finally {
      writer.close()
    }

    const body = new URLSearchParams(form).toString()
    const slow = httpRequest(origin + exportPath, {
      method: "POST",
      headers: { ...admin, "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) },
    })
    try {
      slow.end(body)
      const [response] = await once(slow, "response", { signal: AbortSignal.timeout(5000) }) as [IncomingMessage]
      expect(response.statusCode).toBe(200)
      response.on("error", () => {})
      response.pause()
      // Let the server reach the client socket's full receive buffer.
      await sleep(250)
      expect(await snapshotDirs()).toHaveLength(1)
      expect((await api.post(exportPath, { headers: admin, form })).status()).toBe(409)
    } finally {
      slow.destroy()
    }
    await expect.poll(snapshotDirs).toEqual([])
    expect((await api.post(exportPath, { headers: admin, form })).status()).toBe(200)
  } finally {
    await api.dispose()
  }
})

test("database download requires a valid administrator form and rejects cross-site submissions", async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: origin })
  const admin = { cookie: "feedback-fixture=admin", origin }
  const exportPath = `${prefix}/api/export/database.sqlite`

  try {
    const form = await databaseForm(api, admin)
    for (const site of ["cross-site", "same-site"]) {
      const rejected = await api.post(exportPath, { headers: { ...admin, "sec-fetch-site": site }, form })
      expect(rejected.status()).toBe(403)
      expect(rejected.headers()["cache-control"]).toBe("no-store")
    }
    const fetchRejected = await api.post(exportPath, {
      headers: { ...admin, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }, form,
    })
    expect(fetchRejected.status()).toBe(403)
    for (const invalid of [{ token: "" }, { token: form.token + "x" }, { ...form, extra: "x" }]) {
      expect((await api.post(exportPath, { headers: admin, form: invalid })).status()).toBe(403)
    }
    expect((await api.post(exportPath, { headers: admin, data: form })).status()).toBe(415)
    expect((await api.post(exportPath, { headers: admin, form: { token: "x".repeat(256) } })).status()).toBe(413)
    expect((await readdir(work)).filter(name => name.startsWith(".meitheal-export-"))).toEqual([])

    await stopServer()
    await startServer()
    const restarted = await api.post(origin + exportPath, { headers: { ...admin, origin }, form })
    expect(restarted.status()).toBe(403)
  } finally {
    await api.dispose()
  }
})

for (const secure of [true, false]) {
  coreTest(`Settings submits a native database download from the Home Assistant frame on ${secure ? "trusted loopback" : "plain HTTP LAN"}`, async ({ browser, playwright }) => {
    const lanBrowser = secure ? null : await playwright.chromium.launch({
      args: ["--host-resolver-rules=MAP meitheal.test 127.0.0.1", "--no-proxy-server"],
    })
    const browserOrigin = secure ? origin : origin.replace("127.0.0.1", "meitheal.test")
    const admin = await (lanBrowser ?? browser).newContext({ extraHTTPHeaders: {}, acceptDownloads: true })
    try {
      await admin.addCookies([{ name: "feedback-fixture", value: "admin", url: browserOrigin }])
      const page = await admin.newPage()
      const settings = browserOrigin + prefix + "/settings#app-pwa-settings"
      const endpoint = browserOrigin + prefix + "/api/export/database.sqlite"
      await page.goto(browserOrigin + "/api/health")
      await page.setContent(`<iframe title="Home Assistant app" style="width:100%;height:95vh" src="${settings}"></iframe>`)
      const app = page.frameLocator('iframe[title="Home Assistant app"]')
      const form = app.locator("#export-db-form")
      await expect(form).toHaveAttribute("method", "post")
      await expect(form).toHaveAttribute("action", prefix + "/api/export/database.sqlite")
      expect(await form.evaluate(() => window.isSecureContext)).toBe(secure)
      await app.locator("#export-db-btn").click()
      const [request, download] = await Promise.all([
        page.waitForRequest(request => request.url() === endpoint),
        page.waitForEvent("download"),
        app.getByRole("alertdialog").getByRole("button", { name: "Download", exact: true }).click(),
      ])
      expect(request.method()).toBe("POST")
      expect(request.isNavigationRequest()).toBe(true)
      const headers = await request.allHeaders()
      expect(headers.origin).toBe(browserOrigin)
      if (!secure) expect(headers["sec-fetch-site"]).toBeUndefined()
      expect(download.suggestedFilename()).toMatch(/\.db$/)
      expect((await readFile(await download.path())).subarray(0, 16).toString()).toBe("SQLite format 3\0")
      await expect(app.locator("#export-db-btn")).toBeVisible()
    } finally {
      await admin.close()
      await lanBrowser?.close()
    }
  })
}

test("Deferred and cross-page Details wait for the new worker through ingress", async ({ browser }) => {
  const child = server!
  async function selectWorker(old: boolean) {
    const ack = once(child, "message", { signal: AbortSignal.timeout(5000) })
    child.send({ type: "fixture-worker", old })
    expect((await ack)[0]).toEqual({ oldWorker: old })
  }
  await selectWorker(true)
  const context = await browser.newContext({ serviceWorkers: "allow", locale: "en-IE", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    const paths: string[] = []
    const errors: string[] = []
    const failed: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", entry => { if (entry.type() === "error") errors.push(entry.text()) })
    page.on("requestfailed", request => failed.push(`${request.failure()?.errorText} ${new URL(request.url()).pathname}`))
    page.on("response", response => {
      if (response.status() >= 400) failed.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    context.on("request", request => {
      const url = new URL(request.url())
      if (url.origin === origin) paths.push(url.pathname)
    })
    const at = (route: string) => origin + prefix + route
    const headers = { origin }
    const created = await context.request.post(at("/api/tasks"), {
      data: { title: "Deferred older worker fixture", status: "pending" }, headers,
    })
    expect(created.status()).toBe(201)
    const task = await created.json()
    const detail = await context.request.get(at(`/api/tasks/${task.id}`))
    expect(detail.status()).toBe(200)
    expect((await context.request.patch(at(`/api/tasks/${task.id}/deferral`), {
      data: { deferred: true, updated_at: (await detail.json()).task_version, deferral_revision: null }, headers,
    })).status()).toBe(200)
    await page.goto(at("/offline"))
    await page.evaluate(async path => { await navigator.serviceWorker.register(path + "/sw.js") }, prefix)
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

    let detailReads = 0
    page.on("request", request => {
      if (new URL(request.url()).searchParams.has("deferralRead")) detailReads++
    })
    await page.goto(at("/tasks?view=table#table"))
    try {
      await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
    } catch (error) {
      const modal = await page.evaluate(() => ({
        ready: document.getElementById("task-detail-overlay")?.dataset.detailController,
        scripts: Array.from(document.scripts).map(script => script.src).filter(Boolean),
      }))
      throw new Error(JSON.stringify({ modal, errors, failed, paths }, null, 2), { cause: error })
    }
    await page.locator(`.table-row[data-id="${task.id}"] [data-open-table-task]`).click()
    await expect(page.locator("#td-title")).toHaveValue("Deferred older worker fixture")
    await expect(page.locator("#td-deferral-action")).toBeHidden()

    const deferredUrl = at(`/deferred?open=${task.id}`)
    await page.goto(deferredUrl)
    await expect(page.locator("[data-deferred-status]")).toContainText("activate the update")
    await expect(page.locator("[data-deferred-card]")).toHaveCount(0)
    expect(detailReads).toBe(0)
    await expect.poll(() => page.evaluate(async url => Boolean(await caches.match(url)), deferredUrl)).toBe(true)

    await selectWorker(false)
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update() })
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true)
    await page.getByRole("link", { name: "Reload Deferred" }).click()
    await expect(page.locator("#td-deferral-action")).toHaveText("Resume", { timeout: 10_000 })
    await expect(page.locator("#td-deferral-action")).toBeVisible()
    expect(detailReads).toBeGreaterThan(0)
    expect(paths.filter(path => !path.startsWith(prefix + "/"))).toEqual([])
    await expect.poll(() => page.evaluate(async url => {
      const entries = await Promise.all((await caches.keys()).map(async name => {
        const cache = await caches.open(name)
        return (await cache.keys()).some(request => request.url === url) ? [name] : []
      }))
      return entries.flat()
    }, deferredUrl)).toEqual([])
  } finally {
    await context.close()
  }
})

test("ingress loads board dependencies from the app path", async ({ page, context }) => {
  await context.setExtraHTTPHeaders({})
  await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])

  const escapedAssets: string[] = []
  await page.route(url => url.origin === origin && url.pathname.startsWith("/_astro/"), route => {
    escapedAssets.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 404 })
  })
  const [controller] = await Promise.all([
    page.waitForResponse(response => response.url().startsWith(origin + prefix + "/_astro/kanban-page-controller.")),
    page.goto(origin + prefix + "/tasks"),
  ])
  expect(controller.ok()).toBe(true)
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  expect(escapedAssets).toEqual([])
})

test("a 2,000-task Table page keeps its assets and next view inside ingress", async ({ page, context }) => {
  test.setTimeout(45000)
  const db = new DatabaseSync(path.join(work, "meitheal.db"))
  try {
    const task = db.prepare(`INSERT INTO tasks
      (id, title, description, status, request_id, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`)
    const stamp = Date.now()
    db.exec("BEGIN IMMEDIATE")
    for (let index = 1; index <= 2000; index++) {
      const id = `large-table-${index}`
      task.run(id, `Nótaí & fittings ${index}`, "Inspect the equipment and record worn parts.", id, id, stamp, stamp)
    }
    db.exec("COMMIT")
  } finally {
    db.close()
  }

  await context.setExtraHTTPHeaders({})
  await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
  const escaped: string[] = []
  page.on("request", request => {
    const url = new URL(request.url())
    if (url.origin === origin && (/^\/(?:tasks(?:\/|$)|_astro\/)/).test(url.pathname)) escaped.push(url.pathname)
  })
  const table = await page.goto(origin + prefix + "/tasks?view=table#table")
  expect(table?.status()).toBe(200)
  expect((await table!.body()).byteLength).toBeGreaterThan(5 * 1024 * 1024)
  await expect(page.locator("#task-table tbody tr[data-id]")).toHaveCount(2000)
  await expect(page.getByText("Nótaí & fittings 2000", { exact: true })).toBeVisible()

  const filters = page.locator("#table-shell").getByRole("button", { name: "Toggle filter builder" })
  await filters.press("Enter")
  await expect(filters).toHaveAttribute("aria-expanded", "true")

  const calendar = page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Calendar" })
  await expect(calendar).toHaveAttribute("href", prefix + "/tasks?view=calendar#calendar")
  await calendar.click()
  await expect(page.locator("#tasks-view-calendar")).toBeVisible()
  expect(new URL(page.url()).pathname).toBe(prefix + "/tasks")
  expect(escaped).toEqual([])
})

test("the service worker precaches inside ingress without opening inactive board views", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
  try {
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const workerRequests: URL[] = []
    context.on("request", request => {
      const url = new URL(request.url())
      if (request.serviceWorker() && url.origin === origin) workerRequests.push(url)
    })
    const page = await context.newPage()
    await page.goto(origin + prefix + "/planning")
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

    expect(workerRequests.some(url => url.pathname === prefix + "/version.json")).toBe(true)
    expect(workerRequests.some(url => url.pathname === prefix + "/planning")).toBe(true)
    for (const legacy of ["/areas", "/projects"]) {
      const redirect = await page.request.get(origin + prefix + legacy, { maxRedirects: 0 })
      expect(redirect.status()).toBe(302)
      expect(redirect.headers().location).toBe(prefix + "/planning#spaces")
    }
    expect(workerRequests.filter(url => !url.pathname.startsWith(prefix + "/")).map(url => url.pathname)).toEqual([])
    expect(workerRequests.filter(url => ["/table", "/calendar", "/timeline"].includes(url.pathname.slice(prefix.length))
      || ["table", "calendar", "timeline"].includes(url.searchParams.get("view") ?? "")).map(url => url.pathname)).toEqual([])
  } finally {
    await context.close()
  }
})

test("ingress Settings keeps readable palettes and resolves Auto from the panel or system", async ({ page, context }) => {
  // Two entry points, three themes, and two contrast scans per theme.
  test.setTimeout(90_000)
  await context.setExtraHTTPHeaders({})
  await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  const settings = origin + prefix + "/settings"
  const panel = origin + "/theme-panel-fixture"
  await page.route(panel, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html lang="en"><title>Home Assistant theme fixture</title>
      <style>:root {
        --primary-color: #0288d1;
        --primary-background-color: #fafafa;
        --secondary-background-color: #e5e5e5;
        --primary-text-color: #212121;
      } iframe { width: 100%; height: 900px; border: 0 }</style>
      <iframe src="${settings}" title="Meitheal"></iframe></html>`,
  }))

  for (const location of [settings, panel]) {
    await page.goto(location)
    const content = location === panel ? page.frameLocator("iframe") : page
    const root = content.locator("html")
    const body = content.locator("body")
    await expect(content.locator("#settings-shell")).toHaveAttribute("data-settings-booted", "true")
    await expect(content.locator("#local-feedback [data-feedback-form] fieldset")).toBeEnabled()
    if (location === panel) await expect(root).toHaveAttribute("data-ha-theme", "light")
    await body.evaluate(() => document.fonts.ready)

    const themeSelect = content.locator("#theme-select")
    for (const theme of ["light", "dark", "auto"]) {
      const [saved] = await Promise.all([
        page.waitForResponse(response => response.url() === origin + prefix + "/api/settings"
          && response.request().method() === "PUT"
          && response.request().postDataJSON()?.key === "theme"),
        themeSelect.selectOption(theme),
      ])
      expect(saved.ok()).toBe(true)
      await expect(root).toHaveAttribute("data-theme", theme)
      const toast = content.locator(".toast.success")
      await expect(toast).toBeVisible()
      await expect(toast).toHaveCSS("opacity", "1")
      const toastContrast = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
      expect(toastContrast.violations.flatMap(violation =>
        violation.nodes.filter(node => node.target.join(" ").includes(".toast")).map(node => node.target),
      )).toEqual([])
      await page.reload()
      await expect(content.locator("#settings-shell")).toHaveAttribute("data-settings-booted", "true")
      await expect(content.locator("#local-feedback [data-feedback-form] fieldset")).toBeEnabled()
      await expect(root).toHaveAttribute("data-theme", theme)
      await body.evaluate(() => document.fonts.ready)
      const light = theme === "light" || (theme === "auto" && location === panel)
      await expect.poll(() => body.evaluate(element =>
        getComputedStyle(element).getPropertyValue("--bg-secondary").trim().toLowerCase(),
      )).toBe(light ? "#f1f5f9" : "#1e293b")

      const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze()
      expect(violations.flatMap(violation => violation.nodes.map(node => node.target))).toEqual([])
    }

    if (location === panel) {
      await page.evaluate(() => { document.documentElement.style.colorScheme = "dark" })
      await root.evaluate(() => new Promise<void>(resolve => {
        function observe(event: MessageEvent): void {
          if (event.source !== window || event.data?.probe !== "untrusted-theme-event") return
          window.removeEventListener("message", observe)
          resolve()
        }
        window.addEventListener("message", observe)
        window.postMessage({ type: "theme-changed", probe: "untrusted-theme-event" }, window.location.origin)
      }))
      await expect(root).toHaveAttribute("data-ha-theme", "light")

      await page.evaluate(() => {
        document.querySelector("iframe")?.contentWindow?.postMessage({ type: "theme-changed" }, window.location.origin)
      })
      await expect(root).toHaveAttribute("data-ha-theme", "dark")
      await expect(root).toHaveAttribute("data-theme", "auto")
      expect(await body.evaluate(element =>
        getComputedStyle(element).getPropertyValue("--bg-secondary").trim().toLowerCase(),
      )).toBe("#1e293b")
    }
  }
})

test("verified members receive durable receipts and queue APIs fail closed", async ({ playwright }) => {
  const api = await playwright.request.newContext()
  const at = (route: string) => origin + prefix + route
  const member = { cookie: "feedback-fixture=member" }
  const admin = { cookie: "feedback-fixture=admin" }
  const fake = { "x-ingress-path": prefix, "x-remote-user-id": "fake", "x-remote-user-groups": "system-admin" }
  const body = { submissionId: randomUUID(), category: "problem", message: "Synthetic private report" }
  const post = (data: object, headers: Record<string, string> = member) => api.post(at("/api/feedback"), {
    data, headers: { ...browserMutation, ...headers },
  })
  try {
    const anonymous = await api.get(at("/api/feedback"), { headers: fake })
    const sibling = await api.get(origin + "/api/feedback", { headers: fake })
    const old = await api.get(at("/api/feedback"), { headers: { cookie: "feedback-fixture=old" } })
    expect([anonymous.status(), sibling.status(), old.status()]).toEqual([403, 403, 403])
    expect((await post(body, fake)).status()).toBe(403)
    expect((await api.post(at("/api/feedback"), { headers: member, data: body })).status()).toBe(403)
    expect((await post(body, { ...member, "sec-fetch-site": "same-site" })).status()).toBe(403)
    expect((await post({ ...body, screenshot: "not accepted" })).status()).toBe(400)
    expect((await post({ ...body, message: "€".repeat(1400) })).status()).toBe(400)

    const mediaType = await api.post(at("/api/feedback"), { headers: { ...member, ...browserMutation }, data: "text" })
    expect(mediaType.status()).toBe(415)
    const malformed = await api.post(at("/api/feedback"), {
      headers: { ...member, ...browserMutation, "content-type": "application/json" }, data: "{",
    })
    expect(malformed.status()).toBe(400)
    const declared = await post({ ...body, message: "x".repeat(8192) })
    expect(declared.status()).toBe(413)
    const streamed = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(at("/api/feedback"), {
        method: "POST",
        headers: { ...member, ...browserMutation, "content-type": "application/json" },
      }, response => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on("error", reject)
      request.write("x".repeat(4096))
      request.end("x".repeat(4097))
    })
    expect(streamed).toBe(413)

    const [first, second] = await Promise.all([post(body), post(body)])
    expect(first.status()).toBe(201)
    expect(second.status()).toBe(201)
    expect(first.headers()["cache-control"]).toBe("no-store")
    const receipt = await first.json()
    expect(Object.keys(receipt).sort()).toEqual(["id", "receivedAt"])
    expect(await second.json()).toEqual(receipt)
    expect((await post({ ...body, message: "Changed content" })).status()).toBe(409)

    const reportPath = `/api/feedback/${receipt.id}`
    const memberReads = await Promise.all([
      api.get(at("/api/feedback"), { headers: member }),
      api.patch(at(reportPath), { headers: { ...member, ...browserMutation }, data: { state: "in_progress" } }),
      api.post(at(reportPath + "/export"), { headers: { ...member, ...browserMutation }, data: { reviewedMessage: "test" } }),
      api.delete(at(reportPath), { headers: { ...member, ...browserMutation } }),
      api.post(at("/api/export/database.sqlite"), { headers: member }),
      api.post(origin + "/api/export/database.sqlite", { headers: { ...fake, origin } }),
    ])
    expect(memberReads.map(response => response.status())).toEqual([403, 403, 403, 403, 403, 403])

    await stopServer()
    await startServer()
    const persisted = await post(body)
    expect(await persisted.json()).toEqual(receipt)
    const list = await api.get(at("/api/feedback?state=open"), { headers: admin })
    expect(list.headers()["cache-control"]).toBe("no-store")
    expect((await list.json()).reports).toMatchObject([{ id: receipt.id, message: body.message, state: "open" }])

    const enrollment = await api.post(at("/api/agent-tokens"), {
      headers: admin, data: { name: "Feedback fixture", scopes: ["mcp:execute", "tasks:write"] },
    })
    expect(enrollment.status()).toBe(201)
    const { token } = await enrollment.json()
    const agent = { authorization: `Bearer ${token}` }
    expect((await api.get(at("/api/feedback"), { headers: { ...admin, ...agent } })).status()).toBe(403)
    expect((await api.post(at("/api/export/database.sqlite"), { headers: { ...admin, ...agent } })).status()).toBe(403)
    const tools = await api.post(at("/api/mcp"), {
      headers: agent, data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    })
    expect(tools.ok()).toBeTruthy()
    const catalog = (await tools.json()).result.tools as { name: string }[]
    expect(catalog.some(tool => tool.name === "createTask")).toBe(true)
    expect(catalog.some(tool => /localfeedback|exportdatabase/i.test(tool.name))).toBe(false)
    for (const route of ["/api/export/settings.json", "/api/search?q=Synthetic%20private%20report"]) {
      const response = await api.get(at(route), { headers: admin })
      expect(response.status()).toBe(200)
      expect(await response.text()).not.toContain(receipt.id)
    }

    await stopServer()
    await startServer(true)
    const backup = await api.post(at("/api/export/database.sqlite"), { headers: admin, form: await databaseForm(api, admin) })
    expect(backup.status()).toBe(200)
    expect(backup.headers()["cache-control"]).toBe("no-store")
    expect((await backup.body()).subarray(0, 16).toString()).toBe("SQLite format 3\0")
  } finally {
    await api.dispose()
  }
})

test("Settings saves and retries feedback, then reviews, downloads and deletes it", async ({ browser }) => {
  const member = await browser.newContext({ extraHTTPHeaders: {} })
  const admin = await browser.newContext({ extraHTTPHeaders: {}, viewport: { width: 390, height: 844 }, acceptDownloads: true })
  const settings = origin + prefix + "/settings#local-feedback"
  const message = 'Synthetic <img src=x onerror="window.feedbackExecuted=true"> report'
  try {
    await member.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const userPage = await member.newPage()
    const submissionIds: string[] = []
    await userPage.route("**/api/feedback", async route => {
      const request = route.request()
      if (request.method() !== "POST") return route.continue()
      submissionIds.push(request.postDataJSON().submissionId)
      if (submissionIds.length > 1) return route.continue()
      const saved = await route.fetch()
      expect(saved.status()).toBe(201)
      await route.abort()
    })
    await userPage.goto(settings)
    await expect(userPage.getByText("Local feedback queue")).toHaveCount(0)
    await expect(userPage.locator("#export-db-btn")).toHaveCount(0)
    await userPage.getByLabel("Category", { exact: true }).selectOption("problem")
    await userPage.getByLabel("Message", { exact: true }).fill(message)
    await userPage.getByRole("button", { name: "Save feedback" }).click()
    await expect(userPage.locator("[data-feedback-status]")).toContainText("Could not reach")
    await expect(userPage.getByLabel("Message", { exact: true })).toHaveValue(message)
    await userPage.getByRole("button", { name: "Save feedback" }).click()
    await expect(userPage.locator("[data-feedback-status]")).toContainText("Feedback saved. Receipt")
    expect(submissionIds).toHaveLength(2)
    expect(submissionIds[0]).toBe(submissionIds[1])

    await admin.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const adminPage = await admin.newPage()
    await adminPage.goto(settings)
    await adminPage.getByText("Local feedback queue", { exact: true }).click()
    await expect(adminPage.locator("[data-queue-status]")).toHaveText("1 report shown.")
    await adminPage.getByLabel("Report state").selectOption("")
    const entry = adminPage.locator("[data-report-id]")
    await entry.getByText(/^Problem · Open/).click()
    await expect(entry.getByText(message, { exact: true })).toBeVisible()
    await expect(entry.locator("img")).toHaveCount(0)
    await entry.getByRole("button", { name: "Claim report" }).click()
    await expect(entry.getByText(/^Problem · In progress/)).toBeVisible()
    await entry.getByLabel("Disposition").fill("Synthetic fix verified")
    await entry.getByRole("button", { name: "Resolve report" }).click()
    await expect(entry.getByText(/^Problem · Resolved/)).toBeVisible()
    await entry.getByText("Prepare a reviewed export").click()
    await entry.getByLabel("Text to share").fill("Reviewed reproduction")
    await entry.getByRole("button", { name: "Preview export" }).click()
    await expect(entry.locator("[data-export-preview]")).toContainText("Reviewed reproduction")
    await expect(entry.locator("[data-export-preview]")).not.toContainText("fixture-member")
    const download = adminPage.waitForEvent("download")
    await entry.getByRole("button", { name: "Download reviewed JSON" }).click()
    expect(JSON.parse(await readFile(await (await download).path(), "utf-8"))).toEqual({
      category: "problem", message: "Reviewed reproduction", appVersion: null, routeFamily: null,
    })

    await entry.getByRole("button", { name: "Delete closed report" }).click()
    await adminPage.getByRole("alertdialog").getByRole("button", { name: "Delete report" }).click()
    await expect(entry).toHaveCount(0)
    await expect(adminPage.locator("[data-queue-status]")).toHaveText("Report deleted.")
  } finally {
    await member.close()
    await admin.close()
  }
})
