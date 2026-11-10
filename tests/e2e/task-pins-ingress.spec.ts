import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

const noStore = "private, no-store"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("packaged transport denies alternate pin URLs and marks errors no-store", async ({ request }) => {
  const path = "/api/task-pins"
  const ordinaryGet = await request.get(path)
  expect(ordinaryGet.status()).toBe(405)
  expect(ordinaryGet.headers()["allow"]).toBe("POST, PUT, HEAD")
  expect(ordinaryGet.headers()["cache-control"]).toBe(noStore)
  for (const alias of ["/api//task-pins", "/api/%2574ask-pins/", "/api/task-pins/", "/%2570inned/"]) {
    const result = await request.get(alias, { maxRedirects: 0 })
    expect(result.status(), alias).toBe(404)
    expect(result.headers()["cache-control"], alias).toBe(noStore)
    expect(result.headers()["location"], alias).toBeUndefined()
  }
  expect((await request.get(path + "?unexpected=1")).status()).toBe(400)
  const crossOrigin = await request.post(path, {
    form: { action: "list" },
    headers: { origin: "https://untrusted.example" },
  })
  expect(crossOrigin.status()).toBe(403)
  expect(crossOrigin.headers()["cache-control"]).toBe(noStore)
  let limited
  for (let i = 0; i < 301; i++) {
    limited = await request.head(path)
    if (limited.status() === 429) break
  }
  expect(limited?.status()).toBe(429)
  expect(limited?.headers()["cache-control"]).toBe(noStore)
})

test("browser-generated HTTPS requests isolate owners and reject revoked Core identity", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-pin-ingress-"))
  let child: ChildProcess | undefined
  let browser
  let logs = ""
  let stage = "starting fixture"
  const browserErrors: string[] = []
  try {
    child = startCoreFixture(work)
    child.stdout?.on("data", chunk => { logs += chunk })
    child.stderr?.on("data", chunk => { logs += chunk })
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    stage = "opening TLS fixture"
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const path = prefix + "/api/task-pins"
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    const page = await context.newPage()
    page.on("requestfailed", request => browserErrors.push(`${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText}`))
    page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()) })
    const setOwner = (value: string) => context.addCookies([{ name: "feedback-fixture", value, url: origin }])
    await setOwner("member")
    const loaded = await page.goto(origin + prefix + "/fixture", { timeout: 8_000 })
    expect(loaded?.ok()).toBe(true)
    stage = "creating task"
    const created = await page.evaluate(async url => {
      const response = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(7_000),
        body: JSON.stringify({ title: "Private pin synthetic sentinel" }),
      })
      return { status: response.status, task: await response.json() }
    }, prefix + "/api/tasks")
    expect(created.status).toBe(201)
    const task = created.task.id as string
    stage = "checking owner A"
    const first = await pinRequest(page, path, "POST", { action: "detail", task: created.task.ticket_key })
    expect(first).toMatchObject({ status: 200, cache: noStore, body: { id: task, pinned: false } })
    const contextA = first.body.context as string
    expect(contextA).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await pinRequest(page, path, "HEAD", undefined, contextA)).toEqual({ status: 204, cache: noStore, body: null })
    expect(await pinRequest(page, path, "PUT", { task, pinned: true }, contextA)).toMatchObject({ status: 200, body: { pinned: true } })
    expect(await pinRequest(page, path, "POST", { action: "list" })).toMatchObject({ body: { total: 1, items: [{ id: task }] } })

    stage = "checking browser metadata and validation"
    const noMetadata = await page.evaluate(async url => {
      const response = await fetch(url, {
        method: "POST", mode: "cors", headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(7_000),
        body: JSON.stringify({ action: "list" }),
      })
      return response.status
    }, path)
    expect(noMetadata).toBe(403)
    for (const malformed of ["MTH-1suffix", "MTH-1.1", "MTH-9007199254740992"]) {
      expect(await pinRequest(page, path, "PUT", { task: malformed, pinned: true }, contextA)).toMatchObject({ status: 400 })
    }
    await setOwner("member-two")
    stage = "checking owner B"
    expect(await pinRequest(page, path, "HEAD", undefined, contextA)).toMatchObject({ status: 409 })
    expect(await pinRequest(page, path, "PUT", { task, pinned: false }, contextA)).toMatchObject({ status: 409 })
    expect(await pinRequest(page, path, "POST", { action: "list" })).toMatchObject({ body: { total: 0, items: [] } })

    stage = "checking worker cache cleanup"
    const variants = [path, prefix + "/api/%2574ask-pins/?old=1", prefix + "//pinned", "/api/task-pins"]
    await page.evaluate(async ({ prefix, variants }) => {
      const { version } = await (await fetch(prefix + "/version.json")).json()
      for (const kind of ["api", "nav", "precache", "static"]) {
        const cache = await caches.open(`meitheal-${kind}-v${version}`)
        for (const url of variants) await cache.put(url, new Response("synthetic stale payload"))
      }
      await navigator.serviceWorker.register(prefix + "/sw.js", { scope: prefix + "/" })
    }, { prefix, variants })
    await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
    const capability = await page.evaluate(async () => {
      const channel = new MessageChannel()
      try {
        return await new Promise(resolve => {
          const timeout = setTimeout(() => resolve(false), 2_000)
          channel.port1.onmessage = event => { clearTimeout(timeout); resolve(event.data) }
          navigator.serviceWorker.controller?.postMessage({ type: "TASK_PINS_NETWORK_ONLY" }, [channel.port2])
        })
      } finally {
        channel.port1.close()
      }
    })
    expect(capability).toBe(true)
    expect(await page.evaluate(async variants => Promise.all(variants.map(async url => Boolean(await caches.match(url)))), variants))
      .toEqual([false, false, false, false])

    await setOwner("member")
    stage = "revoking Core user"
    const changed = once(child, "message", { signal: AbortSignal.timeout(3_000) })
    child.send({ type: "fixture-core", user: "member", active: false })
    await changed
    await expect.poll(async () => (await pinRequest(page, path, "HEAD", undefined, contextA)).status, { timeout: 10_000 }).toBe(403)
    expect(await pinRequest(page, path, "PUT", { task, pinned: false }, contextA)).toMatchObject({ status: 403 })
    expect(await pinRequest(page, path, "POST", { action: "list" })).toMatchObject({ status: 403 })
    const pinLogs = logs.split("\n").filter(line => line.includes("/api/task-pins"))
    expect(pinLogs.length).toBeGreaterThan(0)
    for (const line of pinLogs) {
      expect(line).not.toContain("fixture-member")
      expect(line).not.toContain(task)
      expect(line).not.toContain(contextA)
    }
  } catch (error) {
    console.error({ stage, browserErrors, logs })
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
