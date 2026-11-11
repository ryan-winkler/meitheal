import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Table refresh uses one ingress prefix and ignores a worker-cached response", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-table-refresh-ingress-"))
  const child = startCoreFixture(work)
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
    await page.evaluate(async ({ prefix, title }) => {
      const response = await fetch(prefix + "/api/tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        mode: "same-origin", cache: "no-store", redirect: "error",
        body: JSON.stringify({ title }),
      })
      if (!response.ok) throw new Error("Task seed failed")
      await navigator.serviceWorker.register(prefix + "/sw.js", { scope: prefix + "/" })
    }, { prefix, title })
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
    expect((await page.goto(origin + prefix + "/tasks?view=table#table"))?.status()).toBe(200)

    const evidence = await page.evaluate(async ({ prefix, title }) => {
      const route = prefix + "/tasks?view=table&tableRefresh=cached-fixture"
      const { version } = await (await fetch(prefix + "/version.json")).json()
      const cache = await caches.open(`meitheal-static-v${version}`)
      await cache.put(route, new Response("stale table fixture", { headers: { date: new Date().toUTCString() } }))
      const response = await fetch(route, { cache: "no-store", redirect: "error" })
      return { cacheControl: response.headers.get("cache-control"), hasTask: (await response.text()).includes(title) }
    }, { prefix, title })
    expect(evidence).toEqual({ cacheControl: "no-store", hasTask: true })

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
    await expect(page.locator("#task-table .no-results-row")).toBeVisible()
    await expect(page).toHaveURL(url => url.pathname === prefix + "/tasks" &&
      url.searchParams.get("search") === "does not match" && !url.searchParams.has("tableRefresh"))
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
