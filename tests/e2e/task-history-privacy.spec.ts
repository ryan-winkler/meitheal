import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Browser } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

const noStore = "private, no-store"
const history = ["activity", "timeline"] as const
const oldDescription = "Synthetic previous history value"
const newDescription = "Synthetic current history value"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the packaged app and ingress fixture")

test("packaged task history preserves JSON and protects successes, errors and encoded aliases", async ({ request }) => {
  const task = await request.post("/api/tasks", { data: { title: "History transport fixture", description: oldDescription } })
  expect(task.status()).toBe(201)
  const { id } = await task.json() as { id: string }
  const path = "/api/tasks/" + id
  expect((await request.put(path, { data: { description: newDescription } })).status()).toBe(200)
  const encodedId = "%" + id.charCodeAt(0).toString(16) + id.slice(1)
  for (const name of history) {
    const canonical = path + "/" + name + "?limit=2&offset=0"
    const response = await request.get(canonical)
    expect(response.status()).toBe(200)
    expect(response.headers()["cache-control"]).toBe(noStore)
    const value = await response.json()
    const collection = name === "activity" ? "activity" : "events"
    expect(value).toMatchObject({
      total: expect.any(Number), limit: 2, offset: 0,
      [collection]: expect.arrayContaining([expect.objectContaining({
        field: "description", old_value: oldDescription, new_value: newDescription,
      })]),
    })
    const escapedId = await request.get(`/api/tasks/${encodedId}/${name}?limit=2&offset=0`)
    expect(escapedId.status()).toBe(200)
    expect(escapedId.headers()["cache-control"]).toBe(noStore)
    expect(await escapedId.json()).toEqual(value)

    const denied = await request.get(canonical, { headers: { authorization: "Bearer mth_fixture-invalid" } })
    expect(denied.status()).toBe(401)
    expect(denied.headers()["cache-control"]).toBe(noStore)
    const encodedName = "%" + name.charCodeAt(0).toString(16) + name.slice(1)
    for (const alias of [
      `/%2561pi/tasks/${id}/${name}`, `/api/%74asks/${id}/${name}`, `${path}/${encodedName}`,
      `/api/tasks//${id}/${name}`, `${path}/${name}/`, `${path}%2F${name}`,
    ]) {
      const result = await request.get(alias, { maxRedirects: 0 })
      expect(result.status(), alias).toBe(404)
      expect(result.headers()["cache-control"], alias).toBe(noStore)
      expect(result.headers()["location"], alias).toBeUndefined()
    }
  }
  const invalid = await request.get(path + "/timeline?actor_type=not-an-actor")
  expect(invalid.status()).toBe(400)
  expect(invalid.headers()["cache-control"]).toBe(noStore)

  const activity = await request.get("/activity")
  expect(activity.status()).toBe(403)
  expect(activity.headers()["cache-control"]).toBe(noStore)
  for (const alias of ["/%61ctivity", "/%2561ctivity", "/activity/"]) {
    const response = await request.get(alias, { maxRedirects: 0 })
    expect(response.status(), alias).toBe(404)
    expect(response.headers()["cache-control"], alias).toBe(noStore)
    expect(response.headers()["location"], alias).toBeUndefined()
  }
})

test("HTTPS ingress history bypasses offline cache and activation purges legacy entries only", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-history-privacy-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser: Browser | undefined
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {} })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(origin + prefix + "/fixture"))?.status()).toBe(200)
    const created = await pinRequest(page, prefix + "/api/tasks", "POST", { title: "History cache fixture", description: oldDescription })
    expect(created.status).toBe(201)
    const { id } = created.body as { id: string }
    const taskPath = "/api/tasks/" + id
    expect((await pinRequest(page, prefix + taskPath, "PUT", { description: newDescription })).status).toBe(200)
    const paths = history.map(name => `${prefix}${taskPath}/${name}?limit=2`)
    const variants = history.flatMap(name => [
      `${prefix}${taskPath}/${name}?offset=2`, `${prefix}/api/%2574asks/${id}/${name}`,
      `${prefix}${taskPath}%2F${name}`, `${prefix}${taskPath}/${name}/`, `${taskPath}/${name}`,
    ])
    const activityFeed = prefix + "/activity"
    variants.push(activityFeed, activityFeed + "?area=synthetic", prefix + "/%61ctivity", "/activity/")
    const cacheState = await page.evaluate(async ({ prefix, paths, variants }) => {
      const { version } = await (await fetch(prefix + "/version.json")).json()
      const names = ["api", "nav", "precache", "static"].map(kind => `meitheal-${kind}-v${version}`)
      const sentinel = prefix + "/ordinary-cache-fixture"
      const seed = () => new Response("Synthetic stale history", { headers: { date: new Date().toUTCString() } })
      for (const name of names) {
        const cache = await caches.open(name)
        await Promise.all([...paths, ...variants, sentinel].map(path => cache.put(path, seed())))
      }
      const otherApp = "other-app-history-fixture"
      await (await caches.open(otherApp)).put(paths[0]!, seed())
      await navigator.serviceWorker.register(prefix + "/sw.js", { scope: prefix + "/" })
      return { names, sentinel, otherApp }
    }, { prefix, paths, variants })
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
    expect(await page.evaluate(async ({ cacheState, paths, variants }) => {
      const state = []
      for (const name of cacheState.names) {
        const cache = await caches.open(name)
        state.push({
          stale: (await Promise.all([...paths, ...variants].map(path => cache.match(path)))).filter(Boolean).length,
          sentinel: Boolean(await cache.match(cacheState.sentinel)),
        })
      }
      return { state, other: Boolean(await (await caches.open(cacheState.otherApp)).match(paths[0]!)) }
    }, { cacheState, paths, variants })).toEqual({ state: cacheState.names.map(() => ({ stale: 0, sentinel: true })), other: true })

    const online = await page.evaluate(async ({ paths, taskPath, alias, prefix, cacheName }) => {
      const reads = await Promise.all([...paths, taskPath + "/activity", alias].map(async path => {
        const response = await fetch(path)
        return { status: response.status, cache: response.headers.get("cache-control"), body: await response.text() }
      }))
      const ordinary = await fetch(prefix + taskPath)
      const cache = await caches.open(cacheName)
      return { reads, ordinary: ordinary.status, historyCached: (await Promise.all(paths.map(path => cache.match(path)))).some(Boolean) }
    }, { paths, taskPath, alias: `${prefix}/api/%74asks/${id}/timeline`, prefix, cacheName: cacheState.names[0]! })
    expect(online.ordinary).toBe(200)
    expect(online.historyCached).toBe(false)
    expect(online.reads.map(({ status, cache }) => [status, cache])).toEqual([[200, noStore], [200, noStore], [401, noStore], [404, noStore]])
    for (const result of online.reads.slice(0, 2)) {
      expect(result.body).toContain(oldDescription)
      expect(result.body).toContain(newDescription)
    }

    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    for (const [scope, status] of [["tasks:read", 200], ["search:read", 403]] as const) {
      const issued = await pinRequest(page, prefix + "/api/agent-tokens", "POST", { name: "History scope fixture", scopes: [scope] })
      expect(issued.status).toBe(201)
      const { token } = issued.body as { token: string }
      const responses = await page.evaluate(async ({ paths, token }) => Promise.all(paths.map(async path => {
        const response = await fetch(path, { headers: { authorization: "Bearer " + token } })
        return [response.status, response.headers.get("cache-control")]
      })), { paths, token })
      expect(responses).toEqual(paths.map(() => [status, noStore]))
    }
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])

    const replayPaths = [...paths, ...variants.slice(0, 3)]
    // A deliberately retained entry must stay unreachable even after worker activation.
    await page.evaluate(async ({ replayPaths, taskPath, cacheName }) => {
      const cache = await caches.open(cacheName)
      const stale = new Response("Synthetic stale history")
      await Promise.all(replayPaths.map(path => cache.put(path, stale.clone())))
      const deadline = Date.now() + 3_000
      while (!(await cache.match(taskPath))) {
        if (Date.now() > deadline) throw new Error("Ordinary task did not enter the offline cache")
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }, { replayPaths, taskPath: prefix + taskPath, cacheName: cacheState.names[0]! })
    await context.setOffline(true)
    const offline = await page.evaluate(async ({ replayPaths, ordinaryPath }) => {
      const reads = await Promise.all(replayPaths.map(async path => {
        const response = await fetch(path)
        return [response.status, response.headers.get("cache-control"), await response.json()]
      }))
      const task = await fetch(ordinaryPath)
      return { reads, task: [task.status, (await task.json()).description] }
    }, { replayPaths, ordinaryPath: prefix + taskPath })
    expect(offline.reads).toEqual(replayPaths.map(() => [503, noStore, { error: "offline" }]))
    expect(offline.task).toEqual([200, newDescription])

    expect(await page.evaluate(path => fetch(path).then(response => response.status).catch(() => null), activityFeed)).toBeNull()
    await context.setOffline(false)
    const feed = await page.evaluate(async path => {
      const response = await fetch(path)
      return [response.status, response.headers.get("cache-control"), (await response.text()).includes("Recent activity")]
    }, activityFeed)
    expect(feed).toEqual([200, noStore, true])
    expect(await page.evaluate(async path => {
      const entries = await Promise.all((await caches.keys()).filter(name => name.startsWith("meitheal-"))
        .map(async name => (await caches.open(name)).keys()))
      return entries.flat().some(entry => new URL(entry.url).pathname === path)
    }, activityFeed)).toBe(false)

    const ui = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
    await ui.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const details = await ui.newPage()
    const activityPath = "**" + taskPath + "/activity"
    await details.route(activityPath, route => route.fulfill({ json: { activity: [{
      field: "description", new_value: "Synthetic stale cached value", created_at: Date.now(),
    }] } }))
    await details.goto(origin + prefix + "/today?open=" + id)
    await expect(details.locator("#td-title")).toHaveValue("History cache fixture")
    const activity = details.locator("details").filter({ has: details.locator("#td-activity") }).locator("summary")
    const [stale] = await Promise.all([details.waitForResponse(activityPath), activity.click()])
    await stale.finished()
    await details.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(details.locator("#td-activity")).toBeEmpty()
    await details.unroute(activityPath)
    await details.reload()
    await expect(details.locator("#td-title")).toHaveValue("History cache fixture")
    await activity.click()
    await expect(details.locator("#td-activity")).toContainText(newDescription)
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
