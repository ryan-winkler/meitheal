import { createServer, request as proxyRequest, type IncomingMessage, type ServerResponse } from "node:http"
import { expect, test, type APIRequestContext } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

// Model the old worker's navigation behavior without depending on private Git history.
const oldWorker = `
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url)
  if (event.request.method !== "GET" || url.pathname.startsWith("/api/")) return
  event.respondWith((async () => {
    const cache = await caches.open("meitheal-nav-v0.0.1")
    try {
      const response = await fetch(event.request)
      if (response.ok) event.waitUntil(cache.put(event.request, response.clone()).catch(() => {}))
      return response
    } catch (error) {
      const cached = await cache.match(event.request)
      if (cached) return cached
      return new Response("Fixture network fallback: " + error.message, { status: 502 })
    }
  })())
})
`

async function proxy(baseURL: string, intercept: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const upstream = new URL(baseURL)
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || upstream.username || upstream.password) {
    throw new Error("The test proxy requires the loopback HTTP fixture")
  }
  const server = createServer((req, res) => {
    if (!req.url?.startsWith("/") || req.url.startsWith("//") || req.url.includes("\\")) {
      res.writeHead(400)
      res.end()
      return
    }
    if (intercept(req, res)) return
    const forward = proxyRequest({
      hostname: "127.0.0.1",
      port: upstream.port,
      path: req.url,
      method: req.method ?? "GET",
      headers: { ...req.headers, host: upstream.host, origin: upstream.origin },
    }, response => {
      res.writeHead(response.statusCode ?? 500, response.headers)
      response.pipe(res)
    })
    forward.on("error", () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    res.on("close", () => { if (!res.writableFinished) forward.destroy() })
    req.pipe(forward)
  })
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No proxy address")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}

test("the disposable proxy rejects alternate destinations and only forwards local paths", async () => {
  let received = ""
  const upstream = createServer((req, res) => {
    received = req.url ?? ""
    res.end("local fixture")
  })
  await new Promise<void>(resolve => { upstream.listen(0, "127.0.0.1", resolve) })
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("No upstream address")
  const fixture = await proxy(`http://127.0.0.1:${address.port}`, () => false)
  try {
    for (const path of ["http://example.invalid/private", "//example.invalid/private", "/\\example.invalid/private"]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = proxyRequest(fixture.origin, { path }, response => {
          response.resume()
          response.on("end", () => resolve(response.statusCode))
        })
        request.on("error", reject)
        request.end()
      })
      expect(status).toBe(400)
      expect(received).toBe("")
    }
    const response = await fetch(fixture.origin + "/api/health?probe=1")
    expect(await response.text()).toBe("local fixture")
    expect(received).toBe("/api/health?probe=1")
    await expect(proxy("http://example.invalid", () => false)).rejects.toThrow("loopback HTTP fixture")
  } finally {
    await fixture.close()
    await new Promise<void>(resolve => { upstream.close(() => resolve()) })
  }
})

async function createBacklog(request: APIRequestContext, title: string) {
  const result = await request.post("/api/tasks", { data: { title, status: "backlog" } })
  expect(result.status()).toBe(201)
  return (await result.json()).id as string
}

async function setMode(request: APIRequestContext, value: string) {
  expect((await request.put("/api/settings", { data: { key: "backlog_mode", value } })).status()).toBe(200)
}

test("an older worker cannot expose cached rows, even when the replacement takes control in place", async ({ browser, request, baseURL }) => {
  const id = await createBacklog(request, "Cached repair from the old worker")
  let old = true
  const fixture = await proxy(baseURL!, (req, res) => {
    if (!old || req.url?.split("?")[0] !== "/sw.js") return false
    res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" })
    res.end(oldWorker)
    return true
  })
  const context = await browser.newContext({ serviceWorkers: "allow", extraHTTPHeaders: {} })
  try {
    const page = await context.newPage()
    await setMode(request, "visible")
    await page.goto(fixture.origin + "/offline")
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js")
      await caches.open("fixture-other-software")
    })
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

    const url = fixture.origin + "/triage?open=" + encodeURIComponent(id)
    let detailReads = 0
    page.on("request", candidate => {
      if (new URL(candidate.url()).pathname === `/api/tasks/${id}`) detailReads++
    })
    const navigation = await page.goto(url)
    if (!navigation?.ok()) throw new Error("Fixture navigation failed: " + (await navigation?.text()))
    await expect(page.locator("[data-triage-status]")).toContainText("activate the update")
    await expect(page.locator("[data-triage-card]")).toHaveCount(0)
    await expect.poll(() => page.evaluate(async address => Boolean(await (await caches.open("meitheal-nav-v0.0.1")).match(address)), url)).toBe(true)

    await setMode(request, "hidden")
    await context.setOffline(true)
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-triage-fragment]")).toHaveAttribute("data-triage-mode", "visible")
    await expect(page.locator("[data-triage-card]")).toHaveCount(0)
    await expect(page.locator("[data-triage-count]")).toHaveCount(0)
    expect(detailReads).toBe(0)

    await context.setOffline(false)
    old = false
    await page.evaluate(async () => {
      document.documentElement.dataset.fixtureDocument = "retained"
      await (await navigator.serviceWorker.getRegistration())?.update()
    })
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true)
    await page.getByRole("link", { name: "Reload Triage" }).click()
    await expect(page.locator("[data-triage-mode-message=hidden]")).toBeVisible({ timeout: 10000 })
    await expect(page.getByRole("link", { name: "Open Tasks in Table" })).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-fixture-document", "retained")
    await expect(page.locator("[data-triage-card]")).toHaveCount(0)
    expect(detailReads).toBe(0)
    const cacheState = await page.evaluate(async address => ({
      other: (await caches.keys()).includes("fixture-other-software"),
      oldTriage: Boolean(await caches.match(address)),
    }), url)
    expect(cacheState).toEqual({ other: true, oldTriage: false })
  } finally {
    await context.close()
    await fixture.close()
    await setMode(request, "visible")
    expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204)
  }
})

test("the decision deadline covers an incomplete conflict response body", async ({ browser, request, baseURL }) => {
  const id = await createBacklog(request, "Decision deadline fixture")
  let stalled = false
  const path = `/api/tasks/${id}`
  const fixture = await proxy(baseURL!, (req, res) => {
    if (req.method !== "PATCH" || req.url !== path) return false
    stalled = true
    res.writeHead(409, { "content-type": "application/json" })
    res.flushHeaders()
    res.write('{"errorCode":')
    return true
  })
  const context = await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: {} })
  try {
    const page = await context.newPage()
    await page.goto(fixture.origin + "/triage")
    const card = page.locator(`[data-triage-card="${id}"]`)
    const accept = card.getByRole("button", { name: "Accept to Todo" })
    await accept.press("Enter")
    await expect(card).toHaveAttribute("aria-busy", "true")
    await expect(page.locator("[data-triage-status]")).toContainText("check whether the decision saved", { timeout: 12000 })
    expect(stalled).toBe(true)
    await expect(card).not.toHaveAttribute("aria-busy", "true")
    await expect(accept).toBeFocused()
    expect(await (await request.get(path)).json()).toMatchObject({ status: "backlog" })
  } finally {
    await context.close()
    await fixture.close()
    expect((await request.delete(path, { data: {} })).status()).toBe(204)
  }
})
