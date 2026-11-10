import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("Enter cannot select a stale result while the next query loads", async ({ request, baseURL, browser }) => {
  const created = await request.post("/api/tasks", { data: { title: "Fresh lantern query fixture" } })
  expect(created.status()).toBe(201)
  const context = await browser.newContext({ baseURL: baseURL!, serviceWorkers: "block" })
  try {
    const page = await context.newPage()
    await page.addInitScript(() => {
      // Exercise the generation check even when a superseded fetch cannot be cancelled.
      const original = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const value = input instanceof Request ? input.url : String(input)
        const params = new URL(value, location.origin).searchParams
        return original(input, params.get("q") === "superseded search" ? { ...init, signal: null } : init)
      }
    })
    let started!: () => void
    let release!: () => void
    let finished!: () => void
    const received = new Promise<void>(resolve => { started = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    const delivered = new Promise<void>(resolve => { finished = resolve })
    await page.route(url => url.pathname === "/api/search" && url.searchParams.get("q") === "superseded search", async route => {
      started()
      await hold
      try {
        await route.fulfill({
          headers: { "cache-control": "private, no-store" },
          json: { sections: [{ id: "tasks", label: "Tasks", items: [
            { id: "obsolete", kind: "task", taskId: "obsolete", title: "Obsolete search result" },
          ] }] },
        })
      } finally {
        finished()
      }
    })

    await page.goto("/settings")
    await page.getByRole("button", { name: "Search settings…", exact: true }).click()
    await page.getByRole("tab", { name: "Tasks" }).click()
    const input = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
    await expect(page.getByRole("option", { name: /Fresh lantern query fixture/ })).toBeVisible()
    await input.fill("superseded search")
    await received
    await expect(input).not.toHaveAttribute("aria-activedescendant", /.+/)
    await input.press("Enter")
    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await input.fill("Fresh lantern")
    await expect(page.getByRole("option", { name: /Fresh lantern query fixture/ })).toBeVisible()
    release()
    await delivered
    await expect(page.getByRole("option", { name: /Fresh lantern query fixture/ })).toHaveAttribute("aria-selected", "true")
    await expect(page.getByRole("option", { name: /Obsolete search result/ })).toHaveCount(0)
    await input.press("Escape")
    await expect(page.getByRole("button", { name: "Search settings…", exact: true })).toBeFocused()
  } finally {
    await context.close()
  }
})

test("Search waits for a compatible worker, purges old results and remains fresh-only offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-search-worker-"))
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
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    const canonical = prefix + "/api/search"
    const variants = [canonical + "?q=Search", prefix + "/%2561pi/search/", prefix + "/api//search", "/api/search"]
    await workerMode(true)
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(origin + prefix + "/fixture"))?.status()).toBe(200)
    const networkFailures: string[] = []
    page.on("requestfailed", request => {
      networkFailures.push(new URL(request.url()).pathname + " " + request.failure()?.errorText)
    })
    await page.evaluate(async scope => {
      await navigator.serviceWorker.register(scope + "/sw.js", { scope: scope + "/" })
    }, prefix)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    const version = await page.evaluate(async ({ prefix, variants }) => {
      const create = await fetch(prefix + "/api/tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "same-origin",
        body: JSON.stringify({ title: "Search current ingress fixture" }),
      })
      if (!create.ok) throw new Error("Could not seed Search fixture")
      const { version } = await (await fetch(prefix + "/version.json")).json()
      const stored = () => new Response("Synthetic stale search data", { headers: { date: new Date().toUTCString() } })
      for (const kind of ["api", "nav", "precache", "static"]) {
        const cache = await caches.open(`meitheal-${kind}-v${version}`)
        for (const path of variants) await cache.put(path, stored())
        await cache.put(prefix + "/unrelated-fixture", stored())
      }
      await (await caches.open("other-app-fixture")).put(prefix + "/unrelated-fixture", stored())
      return String(version)
    }, { prefix, variants }).catch(error => {
      throw new Error("Search worker setup failed: " + networkFailures.join(", "), { cause: error })
    })
    const paths: string[] = []
    page.on("request", request => {
      const path = new URL(request.url()).pathname
      if (path.endsWith("/api/search")) paths.push(path)
    })
    await page.goto(origin + prefix + "/settings")
    await page.getByRole("button", { name: "Search settings…", exact: true }).click()
    const input = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
    await input.fill("Search current")
    await expect(page.locator("#search-hub-status")).toContainText("until the app updates")
    expect(paths).toEqual([])
    await page.getByRole("tab", { name: "Actions" }).click()
    await input.fill("Home Assistant")
    await expect(page.getByRole("option", { name: /Ask Home Assistant/ })).toBeVisible()
    expect(paths).toEqual([])

    await workerMode(false)
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())?.update() })
    await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))
    await page.getByRole("tab", { name: "Tasks" }).click()
    await input.fill("Search current")
    await expect(page.getByRole("button", { name: "Activate update", exact: true })).toBeVisible()
    expect(paths).toEqual([])
    await page.getByRole("button", { name: "Activate update", exact: true }).press("Enter")
    await expect(page.getByRole("option", { name: /Search current ingress fixture/ })).toBeVisible({ timeout: 10_000 })
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.every(path => path === canonical)).toBe(true)
    const cached = await page.evaluate(async ({ prefix, variants, version }) => ({
      stale: await Promise.all(variants.map(async path => Boolean(await caches.match(path)))),
      unrelated: await Promise.all(["api", "nav", "precache", "static"].map(async kind => {
        const cache = await caches.open(`meitheal-${kind}-v${version}`)
        return Boolean(await cache.match(prefix + "/unrelated-fixture"))
      })),
      other: Boolean(await (await caches.open("other-app-fixture")).match(prefix + "/unrelated-fixture")),
    }), { prefix, variants, version })
    expect(cached).toEqual({ stale: [false, false, false, false], unrelated: [true, true, true, true], other: true })

    await context.setOffline(true)
    await input.fill("Search")
    await expect(page.locator("#search-hub-status")).toContainText("Search is unavailable right now")
    await expect(page.getByRole("option", { name: /Search current ingress fixture/ })).toHaveCount(0)
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
