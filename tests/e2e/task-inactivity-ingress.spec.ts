import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, type Browser } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

const noStore = "private, no-store"
const path = "/api/task-inactivity"
const requestBody = { action: "preview", areaId: null, page: 1, filter: "all" }

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("rejects API aliases and cross-site JSON before loading any data", async ({ request }) => {
  const result = await request.get(path)
  expect(result.status()).toBe(405)
  expect(result.headers()).toMatchObject({ allow: "POST", "cache-control": noStore })
  for (const alias of ["/api//task-inactivity", "/api/%2574ask-inactivity/", "/api/task-inactivity/", "/%2569nactivity/"]) {
    const response = await request.get(alias, { maxRedirects: 0 })
    expect(response.status(), alias).toBe(404)
    expect(response.headers()["cache-control"], alias).toBe(noStore)
  }
  expect((await request.get(path + "?unexpected=1")).status()).toBe(400)
  const denied = await request.post(path, {
    data: requestBody, headers: { origin: "https://other.example", "sec-fetch-site": "cross-site", "sec-fetch-mode": "same-origin" },
  })
  expect(denied.status()).toBe(403)
  expect(denied.headers()["cache-control"]).toBe(noStore)
  const base = new URL(denied.url()).origin
  const missingMetadata = await request.post(path, {
    data: requestBody, headers: { origin: base, referer: base + "/inactivity" },
  })
  expect(missingMetadata.status()).toBe(403)
})

test("group admin previews and saves through HTTPS ingress, while revoked readers and offline state clear", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-inactivity-ingress-"))
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  const logs: string[] = []
  try {
    child = startCoreFixture(work)
    child.stdout?.on("data", value => logs.push(String(value)))
    child.stderr?.on("data", value => logs.push(String(value)))
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const groupAdminReady = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-core", user: "admin", isOwner: false })
    expect(await groupAdminReady).toEqual([{ coreChanged: true }])
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const api = prefix + path
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {}, serviceWorkers: "block", viewport: { width: 320, height: 740 }, reducedMotion: "reduce" })
    await context.setExtraHTTPHeaders({})
    const setOwner = (value: string) => context.addCookies([{ name: "feedback-fixture", value, url: origin }])
    await setOwner("admin")
    const page = await context.newPage()
    page.on("pageerror", error => logs.push("Browser error: " + error.message))
    page.on("requestfailed", request => logs.push("Browser request failed: " + request.method() + " " + new URL(request.url()).pathname + " " + request.failure()?.errorText + "\n"))
    page.on("response", response => {
      const route = new URL(response.url()).pathname
      if (route.endsWith(path) || response.status() >= 400) logs.push(`Browser HTTP ${response.status()} ${route}\n`)
    })
    const base = origin + prefix + "/inactivity"
    await page.goto(base)
    const content = page.locator("[data-inactivity-content]")
    const rows = page.locator("[data-inactivity-rows]")
    const status = page.locator("[data-inactivity-status]")
    const save = page.getByRole("button", { name: "Save policy" })
    const mode = page.getByLabel("Proposed policy")
    const days = page.getByLabel("Elapsed days")
    await expect(content).toBeVisible()
    await expect(page.getByText("Inactivity is off for this scope.")).toBeVisible()
    await expect(save).toBeDisabled()

    const title = "Synthetic task " + "Éireعربي".repeat(36)
    const marker = "private-area-inactivity-sentinel"
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      db.exec("PRAGMA busy_timeout = 3000")
      const then = Date.now() - 2 * 86_400_000
      db.prepare("INSERT INTO areas (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(marker, marker, then, then)
      db.prepare(`INSERT INTO tasks (id, title, request_id, idempotency_key, area_id, status, created_at, updated_at)
        VALUES ('browser-card', ?, 'inactivity-browser', 'inactivity-browser', 'default', 'pending', ?, ?)`).run(title, then, then)
    } finally {
      db.close()
    }

    const { cache, shell } = await page.evaluate(async () => {
      const raw = await fetch(location.pathname + "?open=browser-card", { cache: "no-store" })
      return { cache: raw.headers.get("cache-control"), shell: await raw.text() }
    })
    expect(cache).toBe(noStore)
    expect(shell.includes(marker)).toBe(false)
    expect(shell.includes("browser-card")).toBe(false)
    expect(shell.includes(title)).toBe(false)

    const before = await pinRequest(page, api, "POST", requestBody)
    expect(before).toMatchObject({ status: 200, cache: noStore, body: { canSave: true, policy: { days: 0, revision: null } } })
    const crossMode = await page.evaluate(async ({ api, requestBody }) => {
      const response = await fetch(api, {
        method: "POST", mode: "cors", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody),
      })
      return response.status
    }, { api, requestBody })
    expect(crossMode).toBe(403)

    await mode.selectOption("interval")
    await days.fill("1")
    await expect(save).toBeDisabled()
    await page.getByRole("button", { name: "Preview change" }).click()
    await expect(rows.getByText(title, { exact: true })).toBeVisible()
    await expect(rows.getByText("Ready to defer", { exact: false })).toBeVisible()
    await expect(save).toBeEnabled()
    await expect(page.getByRole("heading", { name: "Preview" })).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
    await expect(rows.getByRole("link", { name: "Details" })).toHaveAttribute("href", new RegExp(prefix + "/tasks\\?area=default&open=browser-card$"))

    const competingSave = {
      action: "save", areaId: null, days: 3, expectedRevision: null, expectedDefaultRevision: null,
      areaGeneration: null, expectedAreaCatalogRevision: before.body.areaCatalogRevision,
    }
    expect((await pinRequest(page, api, "POST", competingSave)).status).toBe(200)
    await save.click()
    await expect(status).toHaveText("The policy or Area changed. Preview the change again before saving.")
    await expect(save).toBeDisabled()
    await page.getByRole("button", { name: "Preview change" }).click()
    await expect(save).toBeEnabled()
    await save.click()
    await expect(status).toHaveText("Inactivity policy saved.")
    await expect(rows.getByText(title, { exact: true })).toBeVisible()

    await setOwner("member")
    await page.reload()
    await expect(rows.getByText(title, { exact: true })).toBeVisible()
    await expect(save).toBeHidden()
    expect((await pinRequest(page, api, "POST", competingSave)).status).toBe(403)
    const changed = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-core", user: "member", active: false })
    await changed
    expect((await pinRequest(page, api, "POST", requestBody)).status).toBe(403)
    expect((await pinRequest(page, api, "POST", { action: "board", ids: ["browser-card"] })).status).toBe(403)

    await setOwner("admin")
    await page.reload()
    await expect(rows.getByText(title, { exact: true })).toBeVisible()
    await expect(days).toHaveValue("1")
    await context.setOffline(true)
    await expect(content).toBeHidden()
    await expect(rows.locator("li")).toHaveCount(0)
    await expect(days).toHaveValue("30")
    await context.setOffline(false)
    await page.getByRole("button", { name: "Try again" }).click()
    await expect(rows.getByText(title, { exact: true })).toBeVisible()
    await rows.getByRole("link", { name: "Details" }).click()
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
    await page.goBack()
    await expect(rows.getByText(title, { exact: true })).toBeVisible()

    const offScope = await pinRequest(page, api, "POST", { ...requestBody, areaId: marker })
    expect(offScope.status).toBe(200)
    expect((await pinRequest(page, api, "POST", {
      action: "save", areaId: marker, days: 0, expectedRevision: offScope.body.policy.revision,
      expectedDefaultRevision: offScope.body.defaultPolicy.revision, areaGeneration: offScope.body.areaGeneration,
      expectedAreaCatalogRevision: null,
    })).status).toBe(200)
    await page.evaluate(marker => {
      localStorage.setItem("meitheal-selected-area", JSON.stringify({ areaId: marker, areaName: marker, areaIcon: "▦" }))
      localStorage.setItem("meitheal-kanban-card-density", "compact")
    }, marker)
    let boardRequests = 0
    page.on("request", request => {
      if (new URL(request.url()).pathname === api && request.postDataJSON()?.action === "board") boardRequests++
    })
    await page.goto(origin + prefix + "/tasks")
    await expect(page).toHaveURL(new RegExp("/tasks\\?area=" + marker))
    await expect(page.locator("#kanban-board")).toHaveAttribute("data-inactivity-enabled", "false")
    expect(boardRequests).toBe(0)

    await page.goto(origin + prefix + "/tasks?area=default")
    const board = page.locator("#kanban-board")
    await expect(board).toHaveClass(/density-compact/)
    await expect(board.locator('[data-inactivity-cue]')).toHaveText("Ready to defer")
    await context.setOffline(true)
    await expect(board.locator("[data-inactivity-cue]")).toHaveCount(0)
    await context.setOffline(false)
  } catch (error) {
    console.error(logs.slice(-12).join(""))
    throw error
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
})

test("a legacy GET-only worker can cache only the empty shell", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-inactivity-worker-"))
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    const legacy = join(work, "old-worker.js")
    await writeFile(legacy, `
      self.addEventListener("install", () => self.skipWaiting())
      self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))
      self.addEventListener("fetch", event => {
        if (event.request.method !== "GET" || !new URL(event.request.url).pathname.endsWith("/inactivity")) return
        event.respondWith((async () => {
          const cache = await caches.open("meitheal-nav-vfixture")
          const response = await fetch(event.request)
          if (response.ok) await cache.put(event.request, response.clone())
          return response
        })())
      })`)
    const previous = process.env.MEITHEAL_PIN_LEGACY_WORKER
    process.env.MEITHEAL_PIN_LEGACY_WORKER = legacy
    try {
      child = startCoreFixture(work)
    } finally {
      if (previous === undefined) delete process.env.MEITHEAL_PIN_LEGACY_WORKER
      else process.env.MEITHEAL_PIN_LEGACY_WORKER = previous
    }
    child.stdout?.resume()
    child.stderr?.resume()
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10000) })
    const oldWorker = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-worker", old: true })
    await oldWorker
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {}, reducedMotion: "reduce" })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    await page.goto(origin + prefix + "/fixture")
    await page.evaluate(async prefix => {
      await navigator.serviceWorker.register(prefix + "/sw.js", { scope: prefix + "/" })
    }, prefix)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))

    await page.goto(origin + prefix + "/inactivity")
    await expect(page.getByText("Inactivity is off for this scope.")).toBeVisible()
    const db = new DatabaseSync(join(work, "pins.db"))
    const sentinel = "Offline preview synthetic sentinel"
    try {
      const then = Date.now() - 2 * 86_400_000
      db.prepare(`INSERT INTO tasks (id, title, request_id, idempotency_key, area_id, status, created_at, updated_at)
        VALUES ('worker-task', ?, 'worker-task', 'worker-task', 'default', 'pending', ?, ?)`).run(sentinel, then, then)
    } finally {
      db.close()
    }
    await page.getByLabel("Proposed policy").selectOption("interval")
    await page.getByLabel("Elapsed days").fill("1")
    await page.getByRole("button", { name: "Preview change" }).click()
    await expect(page.getByText(sentinel)).toBeVisible()
    const stored = await page.evaluate(async () => {
      const shell = await caches.match(location.href)
      const keys = (await Promise.all((await caches.keys()).map(async name => (await caches.open(name)).keys()))).flat()
      return { html: await shell?.text(), paths: keys.map(entry => new URL(entry.url).pathname) }
    })
    expect(typeof stored.html).toBe("string")
    expect(stored.html?.includes(sentinel)).toBe(false)
    expect(stored.paths.some(value => value.endsWith(path))).toBe(false)
    await context.setOffline(true)
    await expect(page.getByText(sentinel)).toHaveCount(0)
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
})
