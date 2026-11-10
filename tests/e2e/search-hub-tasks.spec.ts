import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, test, type Page } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

async function withSearchIngress(run: (page: Page, root: string, prefix: string, work: string) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "meitheal-search-details-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ reducedMotion: "reduce", serviceWorkers: "block", extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(origin + prefix + "/fixture"))?.status()).toBe(200)
    await run(page, origin + prefix, prefix, work)
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
}

async function seedIngressTask(page: Page, prefix: string, title: string) {
  return page.evaluate(async ({ prefix, title }) => {
    const response = await fetch(prefix + "/api/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "same-origin",
      body: JSON.stringify({ title }),
    })
    if (response.status !== 201) throw new Error("Could not seed Search Details fixture")
    return await response.json() as { id: string; ticket_key: string; task_version: number }
  }, { prefix, title })
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`Search Details restores the query and original trigger with ${reducedMotion} motion`, async ({ request, baseURL, browser }) => {
    const title = "Search return lavender fixture " + reducedMotion
    const created = await request.post("/api/tasks", { data: { title } })
    expect(created.status()).toBe(201)
    const { ticket_key: ticket } = await created.json()
    const context = await browser.newContext({ baseURL: baseURL!, serviceWorkers: "block", reducedMotion })
    try {
      const page = await context.newPage()
      await page.goto("/settings#theme-select")
      const origin = page.url()
      const trigger = page.getByRole("button", { name: "Search settings", exact: true })
      const input = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
      const result = page.getByRole("option", { name: new RegExp(title) })
      const detail = page.locator("#task-detail-overlay")
      await trigger.click()
      await page.getByRole("tab", { name: "Tasks" }).click()
      await input.fill(ticket)
      await expect(result).toHaveAttribute("aria-selected", "true")
      await input.press("Enter")
      await expect(page.locator("#td-title")).toHaveValue(title)
      await expect(page).toHaveURL(origin)
      await page.keyboard.press("Escape")
      await expect(detail).not.toHaveClass(/active/)
      await expect(input).toBeFocused()
      await expect(input).toHaveValue(ticket)
      await expect(result).toHaveAttribute("aria-selected", "true")
      await expect(page.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "true")

      await result.click()
      await expect(page.locator("#td-title")).toHaveValue(title)
      await page.getByRole("button", { name: "Close detail" }).click()
      await expect(input).toBeFocused()
      await expect(input).toHaveValue(ticket)
      await input.press("Escape")
      await expect(trigger).toBeFocused()
      await expect(page).toHaveURL(origin)
    } finally {
      await context.close()
    }
  })
}

test("Search-owned confirmation is cancelled on history to the same task", async ({ request, baseURL, browser }) => {
  const title = "Search same task history fixture"
  const created = await request.post("/api/tasks", { data: { title } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const context = await browser.newContext({ baseURL: baseURL!, serviceWorkers: "block", reducedMotion: "reduce" })
  try {
    const page = await context.newPage()
    let deletes = 0
    page.on("request", outgoing => {
      if (outgoing.method() === "DELETE" && new URL(outgoing.url()).pathname === "/api/tasks/" + id) deletes++
    })
    await page.goto("/settings#theme-select")
    const [older, current] = await page.evaluate(id => {
      const current = location.href
      const older = new URL(current)
      older.searchParams.set("open", id)
      history.replaceState(history.state, "", older)
      history.pushState(history.state, "", current)
      return [older.href, current]
    }, id)
    await page.getByRole("button", { name: "Search settings", exact: true }).click()
    await page.getByRole("tab", { name: "Tasks" }).click()
    const input = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
    await input.fill("same task history")
    await page.getByRole("option", { name: /Search same task history fixture/ }).click()
    await expect(page.locator("#td-title")).toHaveValue(title)
    await page.locator("#td-delete").click()
    await expect(page.getByRole("alertdialog")).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(older)
    await expect(page.getByRole("alertdialog")).toHaveCount(0)
    await expect(page.locator("#td-title")).toHaveValue(title)
    await expect(page.getByRole("button", { name: "Close detail" })).toBeFocused()
    expect(deletes).toBe(0)
    await page.goForward()
    await expect(page).toHaveURL(current)
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await expect(page.locator("#search-hub-overlay")).toBeHidden()
  } finally {
    await context.close()
  }
})

test("Search-owned Details handles DELETE rejection and a delayed receipt across ingress history", async () => {
  await withSearchIngress(async (page, root, prefix) => {
    const title = "Search delete ingress fixture"
    const { id, ticket_key: ticket } = await seedIngressTask(page, prefix, title)
    const searchPaths: string[] = []
    page.on("request", outgoing => {
      const path = new URL(outgoing.url()).pathname
      if (path.endsWith("/api/search")) searchPaths.push(path)
    })
    let deleteCount = 0
    let startDelayed!: () => void
    let releaseDelayed!: () => void
    const started = new Promise<void>(resolve => { startDelayed = resolve })
    const held = new Promise<void>(resolve => { releaseDelayed = resolve })
    await page.route(url => url.pathname === prefix + "/api/tasks/" + id, async route => {
      if (route.request().method() !== "DELETE") {
        await route.fallback()
        return
      }
      if (++deleteCount === 1) {
        await route.fulfill({ status: 403, json: { detail: "Fixture rejection" } })
        return
      }
      startDelayed()
      await held
      await route.fulfill({ status: 204 })
    })

    await page.goto(root + "/settings#theme-select")
    const [older, current] = await page.evaluate(id => {
      const current = location.href
      const older = new URL(current)
      older.searchParams.set("open", id)
      history.replaceState(history.state, "", older)
      history.pushState(history.state, "", current)
      return [older.href, current]
    }, id)
    await page.getByRole("button", { name: "Search settings", exact: true }).click()
    await page.getByRole("tab", { name: "Tasks" }).click()
    const input = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
    await input.fill(ticket)
    await expect(page.getByRole("option", { name: /Search delete ingress fixture/ })).toHaveAttribute("aria-selected", "true")
    await input.press("Enter")
    await expect(page.locator("#td-title")).toHaveValue(title)
    const confirmDelete = async () => {
      await page.locator("#td-delete").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete Task" }).click()
    }
    await confirmDelete()
    await expect(page.getByRole("alert").filter({ hasText: "Couldn’t delete the task." })).toBeVisible()
    await expect(page.locator("#td-title")).toHaveValue(title)
    await expect(page).toHaveURL(current)

    await confirmDelete()
    await started
    await page.goBack()
    await expect(page).toHaveURL(older)
    await expect(page.locator("#td-title")).toHaveValue(title)
    const receipt = page.waitForResponse(response => response.request().method() === "DELETE" && response.status() === 204)
    releaseDelayed()
    await receipt
    await expect(page.getByRole("button", { name: "Close detail" })).toBeFocused()
    await expect(page.locator("#search-hub-overlay")).toBeHidden()
    expect(searchPaths.length).toBeGreaterThan(0)
    expect(searchPaths.every(path => path === prefix + "/api/search")).toBe(true)
  })
})

test("Deferred data reconciles after Search Details closes without stealing input focus", async () => {
  await withSearchIngress(async (page, root, prefix) => {
    const title = "Search deferred reconciliation fixture"
    const { id, ticket_key: ticket } = await seedIngressTask(page, prefix, title)
    const status = await page.evaluate(async ({ prefix, id }) => {
      const url = prefix + "/api/tasks/" + id
      const task = await (await fetch(url)).json()
      const deferred = await fetch(url + "/deferral", {
        method: "PATCH", headers: { "content-type": "application/json" },
        mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "same-origin",
        body: JSON.stringify({ deferred: true, updated_at: task.task_version, deferral_revision: task.deferral_revision }),
      })
      return deferred.status
    }, { prefix, id })
    expect(status).toBe(200)
    await page.goto(root + "/deferred")
    const original = page.url()
    const card = page.locator(`[data-deferred-card="${id}"]`)
    await expect(card).toBeVisible()
    await page.keyboard.press("Control+k")
    await page.getByRole("tab", { name: "Tasks" }).click()
    const input = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
    await input.fill(ticket)
    await page.getByRole("option", { name: /Search deferred reconciliation fixture/ }).click()
    const deferral = page.locator("#td-deferral-action")
    await expect(deferral).toHaveText("Resume")
    await deferral.click()
    await expect(deferral).toHaveText("Defer")

    let capture!: () => void
    let release!: () => void
    const requested = new Promise<void>(resolve => { capture = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    await page.route(url => url.pathname === prefix + "/deferred" && url.searchParams.has("deferredRefresh"), async route => {
      capture()
      await held
      await route.continue()
    })
    await page.getByRole("button", { name: "Close detail" }).click()
    await requested
    await expect(input).toBeFocused()
    await expect(input).toHaveValue(ticket)
    await expect(card).toBeVisible()
    release()
    await expect(card).toHaveCount(0)
    await expect(input).toBeFocused()
    await expect(page).toHaveURL(original)
  })
})

test("All selects an exact task ahead of a static match and keeps the active option in view", async () => {
  await withSearchIngress(async (page, root, prefix, work) => {
    const title = "Exact imported ID fixture"
    const health = await page.evaluate(async path => (await fetch(path)).status, prefix + "/api/health")
    expect(health).toBe(200)
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      const insert = db.prepare("INSERT INTO tasks (id,title,idempotency_key,request_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      insert.run("calendar", title, "calendar", "calendar", 1, 1)
      db.prepare("INSERT INTO comments (task_id, content) VALUES (?,?)").run("calendar", "Bellflower comment fixture")
      for (let index = 1; index <= 7; index++) {
        const id = `calendar-${index}`
        insert.run(id, `Calendar additional task ${index}`, id, id, index + 1, index + 1)
      }
    } finally {
      db.close()
    }
    await page.setViewportSize({ width: 900, height: 480 })
    await page.goto(root + "/settings")
    const trigger = page.getByRole("button", { name: "Search settings", exact: true })
    await trigger.click()
    await page.getByRole("tab", { name: "All" }).click()
    const input = page.getByRole("combobox", { name: "Search tasks, views, settings, and actions" })
    await input.fill("calendar")
    const exact = page.getByRole("option", { name: /Exact imported ID fixture/ })
    const staticMatch = page.getByRole("group", { name: "Pages", exact: true }).getByRole("option", { name: /Calendar/ })
    await expect(staticMatch).toBeVisible()
    await expect(exact).toHaveAttribute("aria-selected", "true")
    const sort = page.getByLabel("Sort search results")
    await sort.focus()
    await page.keyboard.press("Tab")
    await expect(input).toBeFocused()
    await input.press("Shift+Tab")
    await expect(sort).toBeFocused()
    await input.focus()
    await input.press("Enter")
    await expect(page.locator("#td-title")).toHaveValue(title)
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(input).toBeFocused()
    await expect(exact).toHaveAttribute("aria-selected", "true")

    for (let index = 0; index < 7; index++) await input.press("ArrowDown")
    const selected = page.locator('.search-hub-item[aria-selected="true"]')
    await expect(selected).toHaveAttribute("tabindex", "-1")
    expect(await selected.evaluate(node => {
      const option = node.getBoundingClientRect()
      const list = node.closest(".search-hub-results")!.getBoundingClientRect()
      return option.top >= list.top && option.bottom <= list.bottom
    })).toBe(true)

    await exact.click()
    await expect(page.locator("#td-title")).toHaveValue(title)
    await page.locator("#task-detail-overlay").click({ position: { x: 5, y: 5 } })
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await expect(page.locator("#search-hub-overlay")).toBeHidden()
    await expect(trigger).toBeFocused()

    await trigger.click()
    await page.getByRole("tab", { name: "Tasks" }).click()
    for (const field of await page.locator("[data-task-field]").all()) {
      await field.setChecked(await field.getAttribute("data-task-field") === "comments")
    }
    await input.fill("Bellflower")
    await expect(exact).toContainText("Bellflower comment fixture")
    await exact.click()
    await expect(page.locator("#td-title")).toHaveValue(title)
  })
})

test("Enter cannot select a stale result while the next query loads", async ({ request, baseURL, browser }) => {
  const created = await request.post("/api/tasks", { data: { title: "Fresh lantern query fixture" } })
  expect(created.status()).toBe(201)
  const context = await browser.newContext({ baseURL: baseURL!, serviceWorkers: "block" })
  try {
    const page = await context.newPage()
    let freshReads = 0
    page.on("request", outgoing => {
      const url = new URL(outgoing.url())
      if (url.pathname === "/api/search" && url.searchParams.get("q") === "Fresh lantern") freshReads++
    })
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
    await page.waitForFunction(() => typeof window.openSearchHub === "function")
    await page.evaluate(() => document.dispatchEvent(new Event("astro:page-load")))
    await page.getByRole("button", { name: "Search settings", exact: true }).click()
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
    expect(freshReads).toBe(1)
    await input.press("Escape")
    await expect(page.getByRole("button", { name: "Search settings", exact: true })).toBeFocused()
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
    await page.getByRole("button", { name: "Search settings", exact: true }).click()
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
