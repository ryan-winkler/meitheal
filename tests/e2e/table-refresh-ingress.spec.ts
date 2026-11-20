import { DatabaseSync } from "node:sqlite"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { TASK_REFRESH_FRAGMENT_HEADER } from "../../apps/web/src/lib/task-view-route"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Task refreshes use compact ingress HTML and ignore a worker-cached response", async () => {
  test.setTimeout(60_000)
  const work = await mkdtemp(join(tmpdir(), "meitheal-table-refresh-ingress-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(origin + prefix + "/fixture"))?.status()).toBe(200)
    const title = "Ingress table refresh fixture"
    const seedHeaders = await currentBoardWriteHeaders(context.request, "household", { "content-type": "application/json" }, origin + prefix)
    await page.evaluate(async ({ prefix, title, headers }) => {
      const response = await fetch(prefix + "/api/tasks", {
        method: "POST", headers,
        mode: "same-origin", cache: "no-store", redirect: "error",
        body: JSON.stringify({ title }),
      })
      if (!response.ok) throw new Error("Task seed failed")
      await navigator.serviceWorker.register(prefix + "/sw.js", { scope: prefix + "/" })
    }, { prefix, title, headers: seedHeaders })
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      const insert = db.prepare(`INSERT INTO tasks
        (id, title, status, area_id, request_id, idempotency_key, created_at, updated_at)
        VALUES (?, ?, 'active', 'default', ?, ?, ?, ?)`)
      const earlier = Date.now() - 60_000
      for (let i = 0; i < 50; i++) {
        insert.run(`refresh-${i}`, `Pagination task ${i}`, `request-${i}`, `idem-${i}`, earlier, earlier)
      }
    } finally {
      db.close()
    }
    expect((await page.goto(origin + prefix + "/tasks?view=table#table"))?.status()).toBe(200)

    for (const [path, marker, selector] of [
      ["/boards/household", "boardRefresh", "kanban-board"],
      ["/tasks?view=table", "tableRefresh", "task-table"],
    ] as const) {
      const pageUrl = origin + prefix + path
      const refreshUrl = new URL(pageUrl)
      refreshUrl.searchParams.set(marker, "contract")
      const headers = { [TASK_REFRESH_FRAGMENT_HEADER]: "1" }
      const wrongViewUrl = new URL(pageUrl)
      wrongViewUrl.searchParams.set(marker === "boardRefresh" ? "tableRefresh" : "boardRefresh", "contract")
      const bothMarkersUrl = new URL(wrongViewUrl)
      bothMarkersUrl.searchParams.set(marker, "contract")
      const [regular, unmarked, compact, wrongView, wrongHeader, bothMarkers] = await Promise.all([
        context.request.get(pageUrl, { headers }),
        context.request.get(refreshUrl.href),
        context.request.get(refreshUrl.href, { headers }),
        context.request.get(wrongViewUrl.href, { headers }),
        context.request.get(refreshUrl.href, { headers: { [TASK_REFRESH_FRAGMENT_HEADER]: "0" } }),
        context.request.get(bothMarkersUrl.href, { headers }),
      ])
      expect([regular.status(), unmarked.status(), compact.status(), wrongView.status(), wrongHeader.status(), bothMarkers.status()])
        .toEqual([200, 200, 200, 200, 200, 200])
      expect(await regular.text()).toContain('id="task-detail-overlay"')
      expect(await wrongView.text()).toContain('id="task-detail-overlay"')
      expect(await wrongHeader.text()).toContain('id="task-detail-overlay"')
      const full = await unmarked.text()
      expect(full).toContain('id="task-detail-overlay"')
      const fragment = await compact.text()
      expect(compact.headers()["cache-control"]).toMatch(/\bno-store\b/)
      expect(fragment).not.toContain('id="task-detail-overlay"')
      expect(fragment.length).toBeLessThan(full.length)
      expect(fragment).toContain(`id="${selector}"`)
      expect(fragment).toContain(title)
      expect(fragment).toContain(`href="${prefix}/tickets/`)
      expect(await bothMarkers.text()).toContain(`id="${selector}"`)
      if (selector === "task-table") {
        expect(await bothMarkers.text()).toContain('data-table-page-link')
      }
      expect(await bothMarkers.text()).not.toMatch(/(?:id="task-detail-overlay"|href="[^"]*(?:boardRefresh|tableRefresh)=)/)
    }

    const headers = { origin, [TASK_REFRESH_FRAGMENT_HEADER]: "1" }
    const postUrl = origin + prefix + "/tasks?view=table&tableRefresh=contract"
    const [normalPost, optedPost] = await Promise.all([
      context.request.post(postUrl, { headers: { origin } }),
      context.request.post(postUrl, { headers }),
    ])
    expect(optedPost.status()).toBe(normalPost.status())
    expect((await optedPost.text()).includes('id="task-detail-overlay"'))
      .toBe((await normalPost.text()).includes('id="task-detail-overlay"'))
    const directory = await context.request.get(origin + prefix + "/api/boards")
    const named = await context.request.post(origin + prefix + "/api/boards", {
      headers: { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! },
      data: { name: "Refresh contract Board" },
    })
    expect(named.status()).toBe(201)
    const { id } = await named.json()
    const namedRefresh = await context.request.get(origin + prefix + "/boards/" + id + "?boardRefresh=contract", { headers })
    expect(namedRefresh.status()).toBe(200)
    const namedFragment = await namedRefresh.text()
    expect(namedRefresh.headers()["cache-control"]).toMatch(/\bno-store\b/)
    expect(namedFragment).toContain('id="kanban-board"')
    expect(namedFragment).not.toContain('id="task-detail-overlay"')
    expect(namedFragment).not.toContain(title)

    const evidence = await page.evaluate(async ({ prefix, title }) => {
      const route = prefix + "/tasks?view=table&tableRefresh=cached-fixture"
      const { version } = await (await fetch(prefix + "/version.json")).json()
      const cache = await caches.open(`meitheal-static-v${version}`)
      await cache.put(route, new Response("stale table fixture", { headers: { date: new Date().toUTCString() } }))
      const response = await fetch(route, { cache: "no-store", redirect: "error" })
      return { cacheControl: response.headers.get("cache-control"), hasTask: (await response.text()).includes(title) }
    }, { prefix, title })
    expect(evidence).toEqual({ cacheControl: "private, no-store", hasTask: true })

    const escaped: string[] = []
    page.on("request", request => {
      const path = new URL(request.url()).pathname
      if ((path.startsWith("/tasks") || /^\/(?:api|_astro)\//.test(path)) &&
          (!path.startsWith(prefix + "/") || path.startsWith(prefix + prefix + "/"))) escaped.push(path)
    })
    const response = page.waitForResponse(receipt => new URL(receipt.url()).searchParams.has("tableRefresh"))
    await page.getByRole("textbox", { name: "Filter by text" }).fill("does not match")
    const receipt = await response
    expect(new URL(receipt.url()).pathname).toBe(prefix + "/tasks")
    expect(receipt.headers()["cache-control"]).toBe("no-store")
    expect(await receipt.text()).not.toContain('id="task-detail-overlay"')
    await expect(page.locator("#task-table .no-results-row")).toBeVisible()
    await expect(page).toHaveURL(url => url.pathname === prefix + "/tasks" &&
      url.searchParams.get("search") === "does not match" && !url.searchParams.has("tableRefresh"))
    // An older server can ignore the opt-in and return the original document.
    const ignoreFragmentOptIn = (header: string) => {
      const original = window.fetch
      window.fetch = (input, options) => {
        const headers = new Headers(options?.headers)
        headers.delete(header)
        return original(input, { ...options, headers })
      }
    }
    await page.evaluate(ignoreFragmentOptIn, TASK_REFRESH_FRAGMENT_HEADER)
    const legacyResponse = page.waitForResponse(receipt => new URL(receipt.url()).searchParams.has("tableRefresh"))
    await page.getByRole("textbox", { name: "Filter by text" }).fill(title)
    expect(await (await legacyResponse).text()).toContain('id="task-detail-overlay"')
    await expect(page.locator("#task-table")).toContainText(title)

    expect((await page.goto(origin + prefix + "/boards/household?view=kanban"))?.status()).toBe(200)
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const board = page.locator("#kanban-board")
    const search = page.getByRole("textbox", { name: "Filter by text" })
    const boardRefresh = () => page.waitForResponse(receipt => new URL(receipt.url()).searchParams.has("boardRefresh"))
    const compactBoard = boardRefresh()
    await search.fill("does not match")
    expect(await (await compactBoard).text()).not.toContain('id="task-detail-overlay"')
    await expect(board.locator(".kanban-card")).toHaveCount(0)
    await page.evaluate(ignoreFragmentOptIn, TASK_REFRESH_FRAGMENT_HEADER)
    const legacyBoard = boardRefresh()
    await search.fill(title)
    expect(await (await legacyBoard).text()).toContain('id="task-detail-overlay"')
    await expect(board.locator(".kanban-card")).toContainText(title)
    expect(escaped).toEqual([])
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
