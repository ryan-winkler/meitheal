import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium, expect, test } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("personal pins work in the mobile drawer and reconcile Details without changing the URL", async () => {
  test.setTimeout(60_000)
  const work = await mkdtemp(join(tmpdir(), "meitheal-pin-browser-"))
  let child: ChildProcess | undefined
  let browser
  let stage = "starting fixture"
  try {
    child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const path = prefix + "/api/task-pins"
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({
      extraHTTPHeaders: {}, hasTouch: true, isMobile: true, viewport: { width: 320, height: 680 },
      reducedMotion: "reduce",
    })
    await context.setExtraHTTPHeaders({})
    const setOwner = (value: string) => context.addCookies([{ name: "feedback-fixture", value, url: origin }])
    await setOwner("member")
    const page = await context.newPage()
    const pinStatuses: number[] = []
    page.on("response", response => { if (new URL(response.url()).pathname === path) pinStatuses.push(response.status()) })
    page.setDefaultTimeout(8_000)
    page.setDefaultNavigationTimeout(10_000)
    stage = "seeding 26 pins"
    await page.goto(origin + prefix + "/fixture")
    const longTitle = "Unbreakable" + "W".repeat(160)
    const seed = await page.evaluate(async ({ prefix, longTitle }) => {
      const post = async (path: string, data: object, method = "POST", context?: string) => {
        const response = await fetch(prefix + path, {
          method, mode: "same-origin", referrerPolicy: "same-origin",
          signal: AbortSignal.timeout(7_000),
          headers: { "content-type": "application/json", ...(context ? { "X-Meitheal-Pin-Context": context } : {}) },
          body: JSON.stringify(data),
        })
        if (!response.ok) throw new Error(`Fixture setup status ${response.status}`)
        return response.json()
      }
      const { context } = await post("/api/task-pins", { action: "list" })
      const records = []
      for (let i = 0; i < 26; i++) {
        const title = i === 25 ? longTitle : `Synthetic pin ${i + 1}`
        const { id } = await post("/api/tasks", { title, is_favorite: i === 25 ? 1 : 0 })
        await post("/api/task-pins", { task: id, pinned: true }, "PUT", context)
        records.push({ id, title })
      }
      return records
    }, { prefix, longTitle })
    expect(seed).toHaveLength(26)
    stage = "opening mobile drawer"
    let pinRequests = 0
    page.on("request", request => { if (new URL(request.url()).pathname === path) pinRequests++ })
    await page.goto(origin + prefix + "/tasks")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    expect(pinRequests).toBe(0)
    await page.locator("#menu-toggle").tap()
    const nav = page.locator('[data-page="system-pinned"]')
    await expect(nav).toBeVisible()
    expect(await nav.getAttribute("data-astro-prefetch")).toBe("false")
    const [shell] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === prefix + "/pinned" && response.request().isNavigationRequest()),
      nav.tap(),
    ])
    expect(await shell.text()).not.toContain(longTitle)
    await page.bringToFront()

    stage = "checking pagination and focus"
    const queue = page.locator("[data-pins-list]")
    const longRow = queue.getByRole("link", { name: longTitle, exact: true })
    try { await expect(longRow).toBeVisible() } catch (error) {
      const state = await page.evaluate(() => ({
        focused: document.hasFocus(), visible: document.visibilityState,
        status: document.querySelector("[data-pins-status]")?.textContent,
        worker: navigator.serviceWorker.controller?.state,
      }))
      console.error({ state, pinStatuses })
      throw error
    }
    await expect(queue.locator("li")).toHaveCount(25)
    await expect(page.locator("[data-pins-page]")).toHaveText("Page 1 of 2")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.getByRole("button", { name: "Next", exact: true }).press("Enter")
    const only = queue.getByRole("link", { name: "Synthetic pin 1", exact: true })
    await expect(only).toBeVisible()
    await expect(queue.locator("li")).toHaveCount(1)
    await page.getByRole("button", { name: "Unpin Synthetic pin 1", exact: true }).press("Enter")
    await expect(page.locator("#pinned-heading")).toBeFocused()
    await expect(queue.locator("li")).toHaveCount(25)
    await expect(page.locator("[data-pins-pagination]")).toBeHidden()

    const pinnedUrl = page.url()
    stage = "checking modal and scoped reconciliation"
    await longRow.press("Enter")
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
    await expect(page.locator("#td-pin-action")).toHaveAttribute("aria-pressed", "true")
    expect(page.url()).toBe(pinnedUrl)
    await page.getByRole("button", { name: "Pin task", exact: true }).press("Enter")
    await expect(page.locator("#td-pin-action")).toHaveAttribute("aria-pressed", "false")
    await expect(page.locator("#td-pin-action")).toBeVisible()
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await expect(longRow).toHaveCount(0)
    expect(page.url()).toBe(pinnedUrl)
    const last = seed.at(-1)
    const task = await page.evaluate(async ({ prefix, id }) => {
      const response = await fetch(prefix + "/api/tasks/" + id)
      return response.json()
    }, { prefix, id: last?.id })
    expect(task.is_favorite).toBe(1)

    stage = "checking delayed shared write reconciliation"
    const edited = seed.at(-2)
    const originalTitle = edited?.title as string
    const nativeTaskUrl = origin + prefix + "/api/tasks/" + edited?.id
    const renamed = "Renamed after a delayed save"
    let writeArrived = false
    let releaseWrite: () => void = () => {}
    const delayedWrite = new Promise<void>(resolve => { releaseWrite = resolve })
    await page.route(nativeTaskUrl, async route => {
      if (route.request().method() === "PUT") {
        writeArrived = true
        await delayedWrite
      }
      await route.continue()
    })
    await queue.getByRole("link", { name: originalTitle, exact: true }).press("Enter")
    await expect(page.locator("#td-pin-action")).toBeVisible()
    const editor = page.locator("#td-title")
    await editor.fill(renamed)
    await editor.blur()
    try {
      await expect.poll(() => writeArrived).toBe(true)
      await page.getByRole("button", { name: "Close detail" }).click()
      await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
      await expect(queue.getByRole("link", { name: renamed, exact: true })).toHaveCount(0)
    } finally {
      releaseWrite()
    }
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await expect(queue.getByRole("link", { name: renamed, exact: true })).toBeFocused()
    expect(page.url()).toBe(pinnedUrl)
    await page.unroute(nativeTaskUrl)

    stage = "checking account change after a committed pin write"
    const acknowledged = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "hold-pin-receipt" })
    expect((await acknowledged)[0]).toEqual({ holdingPinReceipt: true })
    const committed = once(child, "message", { signal: AbortSignal.timeout(5_000) })
    await queue.getByRole("button", { name: `Unpin ${renamed}`, exact: true }).press("Enter")
    try {
      expect((await committed)[0]).toEqual({ pinReceiptStatus: 200 })
      await setOwner("member-two")
    } finally {
      child.send({ type: "release-pin-receipt" })
    }
    await expect(queue.locator("li")).toHaveCount(0, { timeout: 11_000 })
    await expect(page.locator("[data-pins-status]")).toContainText("Your pin session changed")
    await expect(page.getByText("Pin removed.", { exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Refresh pins" }).press("Enter")
    await expect(page.locator("[data-pins-status]")).toContainText("No pinned tasks yet")
    expect(await pinRequest(page, path, "POST", { action: "list" })).toMatchObject({ body: { total: 0 } })
  } catch (error) {
    console.error("Personal pins browser step failed:", stage)
    throw error
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
})

test("the insecure Home Assistant shell exposes recovery without making a pin request", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-pins-http-"))
  const child = startCoreFixture(work, true)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `http://pin-fixture.test:${info.port}`
    browser = await chromium.launch({
      args: ["--no-proxy-server", "--host-resolver-rules=MAP pin-fixture.test 127.0.0.1"],
    })
    const context = await browser.newContext({ extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    let requests = 0
    page.on("request", request => {
      if (new URL(request.url()).pathname.endsWith("/api/task-pins")) requests++
    })
    const response = await page.goto(origin + info.configuredPath + "/pinned?open=ignored")
    expect(response?.status()).toBe(200)
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false)
    await expect(page.locator("[data-pins-status]")).toContainText("Home Assistant app panel over HTTPS")
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await expect(page.locator("[data-pins-refresh]")).toBeHidden()
    expect(requests).toBe(0)
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
})

test("an older controller makes no pin requests until the user activates the replacement", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-pins-worker-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  const workerMode = async (old: boolean) => {
    const ack = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-worker", old })
    expect((await ack)[0]).toEqual({ oldWorker: old })
  }
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    await workerMode(true)
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    await page.goto(origin + prefix + "/fixture")
    await page.evaluate(async scope => {
      await navigator.serviceWorker.register(scope + "/sw.js", { scope: scope + "/" })
    }, prefix)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    let requests = 0
    page.on("request", request => { if (new URL(request.url()).pathname === prefix + "/api/task-pins") requests++ })
    await page.goto(origin + prefix + "/pinned")
    await expect(page.getByRole("button", { name: "Activate update" })).toBeVisible()
    expect(requests).toBe(0)
    await expect(page.locator("[data-pins-list] li")).toHaveCount(0)
    await workerMode(false)
    await page.getByRole("button", { name: "Activate update" }).press("Enter")
    await expect(page.locator("[data-pins-status]")).toContainText("No pinned tasks yet")
    expect(requests).toBeGreaterThanOrEqual(2)
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await closed
    }
    await rm(work, { recursive: true, force: true })
  }
})
