import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Browser, type Route } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built application and Core roster fixture")

test("canonical cleanup rejects GET, query strings and encoded aliases", async ({ request }) => {
  const base = "/api/labels/cleanup"
  const response = await request.get(base)
  expect(response.status()).toBe(405)
  expect(response.headers()).toMatchObject({ allow: "POST", "cache-control": "private, no-store" })
  for (const alias of ["/api/labels/cleanup/", "/api/%6cabels/cleanup", "/api/labels/%2563leanup", "/api//labels/cleanup"]) {
    const denied = await request.get(alias, { maxRedirects: 0 })
    expect(denied.status(), alias).toBe(404)
    expect(denied.headers()["cache-control"]).toBe("private, no-store")
  }
  expect((await request.get(base + "?action=preview")).status()).toBe(400)
})

test("a current admin reviews labels across pages, safely confirms and clears on revocation", async () => {
  test.slow()
  const work = await mkdtemp(join(tmpdir(), "meitheal-label-cleanup-ingress-"))
  const child = startCoreFixture(work)
  const logs: string[] = []
  child.stdout?.on("data", value => logs.push(String(value)))
  child.stderr?.on("data", value => logs.push(String(value)))
  let browser: Browser | undefined
  let releasePreview: (() => void) | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const administrator = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-core", user: "admin", isOwner: false })
    await administrator
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const api = prefix + "/api/labels/cleanup"
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {}, ignoreHTTPSErrors: true,
      viewport: { width: 320, height: 740 }, reducedMotion: "reduce", serviceWorkers: "block" })
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    await page.goto(origin + prefix + "/settings#tasks-boards-settings")
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    const response = await pinRequest(page, prefix + "/api/labels", "POST", { title: "Shared maintenance", hex_color: "#317c61" })
    expect(response.status).toBe(201)
    const area = await pinRequest(page, prefix + "/api/areas", "POST", { name: "Other Area" })
    expect(area.status).toBe(201)
    const firstTask = await pinRequest(page, prefix + "/api/tasks", "POST", {
      title: "Default task", area_id: "default", labels: '["Shared maintenance"]',
    })
    const secondTask = await pinRequest(page, prefix + "/api/tasks", "POST", {
      title: "Other Area task", area_id: area.body.id, labels: '["Shared maintenance"]',
    })
    expect(firstTask.status).toBe(201)
    expect(secondTask.status).toBe(201)
    const database = new DatabaseSync(join(work, "pins.db"))
    const unsafe = 'Roof <img src=x onerror="window.labelCleanupInjected=1"> & attic'
    const long = "Cothabháil an tí agus iniúchadh sábháilteachta don teaghlach · حديقة المنزل"
    try {
      database.exec("PRAGMA busy_timeout=3000")
      const insert = database.prepare("INSERT INTO vikunja_labels (title,hex_color) VALUES (?, '317c61')")
      insert.run(unsafe)
      insert.run(long)
      for (let index = 1; index <= 26; index++) insert.run("Unused household " + String(index).padStart(2, "0"))
    } finally { database.close() }
    await page.goto(origin + prefix + "/tasks?area=&labels=Shared%20maintenance")
    await expect(page.locator(".kanban-card[data-task-id]")).toHaveCount(2)
    await expect(page.locator(`.kanban-card[data-task-id="${firstTask.body.id}"]`)).toBeVisible()
    await expect(page.locator(`.kanban-card[data-task-id="${secondTask.body.id}"]`)).toBeVisible()
    await page.goto(origin + prefix + "/settings#tasks-boards-settings")
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    const cleanup = page.locator("[data-label-cleanup]")
    const review = cleanup.getByRole("button", { name: "Review unused labels", exact: true })
    const checkboxes = cleanup.getByRole("checkbox")
    await review.click()
    await expect(checkboxes).toHaveCount(25)
    await expect(cleanup.getByText("Shared maintenance", { exact: true })).toHaveCount(0)
    await checkboxes.first().check()
    await expect(cleanup.locator("[data-cleanup-selection]")).toHaveText("1 selected")
    await cleanup.getByRole("button", { name: "Next", exact: true }).click()
    await expect(checkboxes).toHaveCount(3)
    await expect(cleanup.locator("[data-cleanup-selection]")).toHaveText("0 selected")
    await cleanup.getByRole("button", { name: "Previous", exact: true }).click()
    await expect(checkboxes).toHaveCount(25)
    await cleanup.getByRole("checkbox", { name: unsafe, exact: true }).check()
    await cleanup.getByRole("button", { name: "Remove selected labels", exact: true }).click()
    const confirmation = page.getByRole("alertdialog")
    await expect(confirmation).toBeVisible()
    await expect(confirmation.locator("img")).toHaveCount(0)
    await expect(confirmation.getByText(unsafe, { exact: true })).toBeVisible()
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(checkboxes).toHaveCount(25)
    await expect(cleanup.locator("[data-cleanup-remove]")).toBeFocused()
    await cleanup.locator("[data-cleanup-remove]").click()
    await expect(confirmation).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(confirmation).toBeHidden()
    await expect(cleanup.locator("[data-cleanup-remove]")).toBeFocused()
    await cleanup.locator("[data-cleanup-remove]").click()
    await expect(confirmation).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(confirmation).toBeHidden()
    await expect(checkboxes).toHaveCount(25)
    await expect(cleanup.locator("[data-cleanup-heading]")).toBeFocused()
    await cleanup.getByRole("checkbox", { name: unsafe, exact: true }).check()
    const violations = await new AxeBuilder({ page }).include("[data-label-cleanup]").analyze()
    expect(violations.violations).toEqual([])
    await cleanup.getByRole("button", { name: "Remove selected labels", exact: true }).click()
    await confirmation.getByRole("button", { name: "Remove selected labels", exact: true }).click()
    await expect(cleanup.locator("[data-cleanup-status]")).toHaveText("Label removed.")
    await expect.poll(() => page.locator("#labels-list input").evaluateAll(inputs =>
      inputs.map(input => (input as HTMLInputElement).value))).not.toContain(unsafe)

    const headers = { origin, referer: page.url(), "sec-fetch-site": "same-origin", "sec-fetch-mode": "same-origin" }
    expect((await page.request.post(origin + api, { headers: { ...headers, cookie: "feedback-fixture=member" },
      data: { action: "preview", afterId: null } })).status()).toBe(403)
    const credential = await pinRequest(page, prefix + "/api/agent-tokens", "POST", {
      name: "Synthetic label cleanup denial", scopes: ["tasks:read", "tasks:write"],
    })
    expect(credential.status).toBe(201)
    const agentDenied = await page.request.post(origin + api, {
      headers: { ...headers, authorization: "Bearer " + credential.body.token }, data: { action: "preview", afterId: null },
    })
    expect(agentDenied.status()).toBe(403)
    expect(await agentDenied.json()).toMatchObject({ ok: false, errorCode: "denied" })
    const unauthenticated = await page.request.post(origin + api, {
      headers: { ...headers, cookie: "" }, data: { action: "preview", afterId: null },
    })
    expect(unauthenticated.status()).toBe(403)
    expect(await unauthenticated.json()).toMatchObject({ ok: false, errorCode: "denied" })
    const invalidCredential = await page.request.post(origin + api, {
      headers: { ...headers, authorization: "Bearer mth_" + "1".repeat(64) }, data: { action: "preview", afterId: null },
    })
    expect(invalidCredential.status()).toBe(401)
    expect(invalidCredential.headers()["www-authenticate"]).toContain("Bearer")
    expect(await invalidCredential.json()).toMatchObject({ ok: false, errorCode: "denied" })
    const lostTitle = await cleanup.locator(".label-cleanup-name").first().textContent()
    const lostRemoval = async (route: Route) => {
      if (route.request().postDataJSON().action !== "remove") return route.continue()
      const committed = await route.fetch({ headers: { ...route.request().headers(), ...headers } })
      expect(committed.status()).toBe(200)
      await route.abort("failed")
    }
    await page.route("**" + api, lostRemoval)
    await checkboxes.first().check()
    await cleanup.getByRole("button", { name: "Remove selected labels", exact: true }).click()
    await confirmation.getByRole("button", { name: "Remove selected labels", exact: true }).click()
    await expect(cleanup.locator("[data-cleanup-status]")).toHaveText("Could not complete cleanup. Review the current labels before trying again.")
    await expect(checkboxes).toHaveCount(0)
    await page.unroute("**" + api, lostRemoval)
    await review.click()
    await expect(checkboxes).toHaveCount(25)
    await expect(cleanup.getByRole("checkbox", { name: lostTitle!, exact: true })).toHaveCount(0)

    expect((await pinRequest(page, prefix + "/api/tasks/" + firstTask.body.id, "PUT", { labels: "[]" })).status).toBe(200)
    await review.click()
    await expect(checkboxes).toHaveCount(25)
    await expect(cleanup.getByText("Shared maintenance", { exact: true })).toHaveCount(0)
    expect((await pinRequest(page, prefix + "/api/tasks/" + secondTask.body.id, "PUT", { labels: "[]" })).status).toBe(200)
    await review.click()
    await expect(cleanup.getByRole("checkbox", { name: "Shared maintenance", exact: true })).toBeVisible()
    await cleanup.getByRole("checkbox", { name: "Shared maintenance", exact: true }).check()
    await cleanup.getByRole("button", { name: "Remove selected labels", exact: true }).click()
    await confirmation.getByRole("button", { name: "Remove selected labels", exact: true }).click()
    await expect(cleanup.locator("[data-cleanup-status]")).toHaveText("Label removed.")
    expect((await page.request.get(origin + prefix + "/api/labels")).ok()).toBe(true)
    await expect((await page.request.get(origin + prefix + "/api/labels")).json().then(labels =>
      labels.some((label: { title: string }) => label.title === "Shared maintenance"))).resolves.toBe(false)
    for (const data of [{ action: "preview", afterId: null, extra: true }, { action: "remove", labels: [] },
      { action: "preview", afterId: 1.5 }]) {
      expect((await page.request.post(origin + api, { headers, data })).status()).toBe(400)
    }
    expect((await page.request.post(origin + api, { headers: { ...headers, origin: "https://other.invalid" },
      data: { action: "preview", afterId: null } })).status()).toBe(403)
    expect((await page.request.post(origin + api, { headers, data: { action: "preview", afterId: null, padding: "x".repeat(9000) } })).status()).toBe(413)
    expect((await page.request.post(origin + api, { headers: { ...headers, "content-type": "text/plain" },
      data: "not JSON" })).status()).toBe(415)
    const unavailable = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-core", unavailable: true })
    await unavailable
    expect((await pinRequest(page, api, "POST", { action: "preview", afterId: null })).status).toBe(503)
    const available = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-core", unavailable: false })
    await available

    const hold = new Promise<void>(resolve => { releasePreview = resolve })
    let captured = false
    let finished = false
    const delayPreview = async (route: Route) => {
      if (captured) return route.continue()
      const response = await route.fetch({ headers: { ...route.request().headers(), ...headers } })
      captured = true
      await hold
      try { await route.fulfill({ response }) } finally { finished = true }
    }
    await page.route("**" + api, delayPreview)
    await review.click()
    await expect.poll(() => captured).toBe(true)
    await context.setOffline(true)
    await expect(checkboxes).toHaveCount(0)
    releasePreview?.()
    await expect.poll(() => finished).toBe(true)
    await expect(checkboxes).toHaveCount(0)
    await page.unroute("**" + api, delayPreview)
    await context.setOffline(false)
    await expect(checkboxes).toHaveCount(25)
    captured = false
    finished = false
    const heldRevocation = new Promise<void>(resolve => { releasePreview = resolve })
    const revokedPreview = async (route: Route) => {
      if (captured) return route.continue()
      const response = await route.fetch({ headers: { ...route.request().headers(), ...headers } })
      captured = true
      await heldRevocation
      try { await route.fulfill({ response }) } finally { finished = true }
    }
    await page.route("**" + api, revokedPreview)
    await review.click()
    await expect.poll(() => captured).toBe(true)
    const changed = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-core", user: "admin", groupIds: ["system-users"], isOwner: false })
    await changed
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(cleanup.locator("[data-cleanup-status]")).toHaveText("Open Labels with a current Home Assistant administrator account.")
    await expect(checkboxes).toHaveCount(0)
    releasePreview?.()
    await expect.poll(() => finished).toBe(true)
    await expect(checkboxes).toHaveCount(0)
    await page.unroute("**" + api, revokedPreview)
  } catch (error) {
    console.error(logs.slice(-10).join(""))
    throw error
  } finally {
    releasePreview?.()
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})

async function verifyWorkerUpdate(control: "toast" | "settings" | "force", timeOut = false) {
  test.slow()
  const workerTimeout = 15_000
  const work = await mkdtemp(join(tmpdir(), "meitheal-label-cleanup-worker-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser: Browser | undefined
  try {
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const changed = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-worker", old: true })
    expect((await changed)[0]).toEqual({ oldWorker: true })
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ extraHTTPHeaders: {}, reducedMotion: "reduce" })
    context.setDefaultTimeout(workerTimeout)
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const page = await context.newPage()
    const settingsUrl = origin + prefix + "/settings#tasks-boards-settings"
    expect((await page.goto(origin + prefix + "/fixture", { waitUntil: "domcontentloaded" }))?.status()).toBe(200)
    await test.step("Install and claim the older worker", async () => {
      await page.evaluate(async prefix => {
        await navigator.serviceWorker.register(prefix + "/sw.js", { scope: prefix + "/" })
      }, prefix)
      await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated")
    }, { timeout: workerTimeout })
    expect((await page.goto(settingsUrl, { waitUntil: "domcontentloaded" }))?.status()).toBe(200)
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(origin + prefix + "/sw.js")
    expect((await pinRequest(page, prefix + "/api/labels", "POST", { title: "Worker planned label" })).status).toBe(201)
    const cleanup = page.locator("[data-label-cleanup]")
    await cleanup.locator("[data-cleanup-review]").click()
    await expect(cleanup.getByRole("checkbox")).toHaveCount(1)
    const variants = [prefix + "/api/labels/cleanup", prefix + "/api/%256cabels/cleanup/", prefix + "/api/labels/%2563leanup"]
    const ordinary = prefix + "/api/ordinary-label-fixture"
    const version = await page.evaluate(async prefix => (await (await fetch(prefix + "/version.json")).json()).version as string, prefix)
    const names = ["api", "nav", "static", "precache"].map(kind => `meitheal-${kind}-v${version}`)
    await page.evaluate(async ({ names, variants, ordinary }) => {
      const headers = { date: new Date().toUTCString() }
      for (const name of names) {
        const cache = await caches.open(name)
        for (const url of variants) await cache.put(url, new Response("Stale private cleanup fixture", { headers }))
        await cache.put(ordinary, new Response("Ordinary offline fixture", { headers }))
      }
    }, { names, variants, ordinary })
    await context.setOffline(true)
    await expect(cleanup.getByRole("checkbox")).toHaveCount(0)
    await expect(cleanup.locator("[data-cleanup-review]")).toBeDisabled()
    await context.setOffline(false)
    await expect(cleanup.getByRole("checkbox")).toHaveCount(1)
    const current = once(child, "message", { signal: AbortSignal.timeout(3000) })
    child.send({ type: "fixture-worker", old: false })
    expect((await current)[0]).toEqual({ oldWorker: false })
    const candidateStarted = context.waitForEvent("serviceworker")
    await test.step("Request the current worker from the fixture", async () => {
      await page.evaluate(async prefix => {
        const registration = await navigator.serviceWorker.getRegistration(prefix + "/")
        if (!registration) throw new Error("Missing fixture worker")
        await registration.update()
      }, prefix)
    }, { timeout: workerTimeout })
    const candidate = await candidateStarted
    await candidate.evaluate(() => {
      const gate = new Promise<void>(resolve => Reflect.set(self, "releaseFixtureActivation", resolve))
      self.addEventListener("activate", event => {
        Reflect.set(self, "fixtureActivationHeld", true)
        const activation = event as Event & { waitUntil(pending: Promise<void>): void }
        activation.waitUntil(gate)
      }, { once: true })
    })
    await expect.poll(() => page.evaluate(async prefix =>
      (await navigator.serviceWorker.getRegistration(prefix + "/"))?.waiting?.state, prefix)).toBe("installed")
    await expect.poll(() => page.evaluate(async prefix => {
      const waiting = (await navigator.serviceWorker.getRegistration(prefix + "/"))?.waiting
      if (!waiting) return "no-waiting-worker"
      return new Promise<string>(resolve => {
        const channel = new MessageChannel()
        const timer = setTimeout(() => { channel.port1.close(); resolve("no-reply") }, 500)
        channel.port1.onmessage = event => {
          clearTimeout(timer)
          channel.port1.close()
          resolve(event.data === true ? "ready" : "unsupported")
        }
        waiting.postMessage({ type: "TASK_DRAFTS_IMPLEMENTED" }, [channel.port2])
      })
    }, prefix)).toBe("ready")
    let updateUrl = settingsUrl
    if (control !== "toast") {
      updateUrl = origin + prefix + "/settings#app-pwa-settings"
      await page.evaluate(() => { window.location.hash = "app-pwa-settings" })
      await expect(page).toHaveURL(updateUrl)
      await expect(page.locator("#settings-shell")).toHaveAttribute("data-settings-booted", "true")
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      await expect(page.locator("#app-pwa-settings")).toBeVisible()
      if (control === "force") {
        await page.locator("#pwa-troubleshoot summary").click()
        await expect(page.locator("#pwa-troubleshoot")).toHaveAttribute("open", "")
      }
    }
    const refresh = page.locator({ toast: "#sw-update-btn", settings: "#pwa-update-settings-btn", force: "#pwa-force-update-btn" }[control])
    await expect(refresh).toBeVisible()
    const refreshEvents: string[] = []
    await page.exposeFunction("recordFixtureWorkerState", (event: string) => { refreshEvents.push(event) })
    const previousDocument = await page.evaluate(async prefix => {
      const workers = navigator.serviceWorker
      const waiting = (await workers.getRegistration(prefix + "/"))?.waiting
      const report = (event: string) => {
        const record = Reflect.get(window, "recordFixtureWorkerState") as (state: string) => Promise<void>
        void record(event)
      }
      waiting?.addEventListener("statechange", () => report(`candidate ${waiting.state}`))
      workers.addEventListener("controllerchange", () => report(`controller ${workers.controller?.state}`))
      window.addEventListener("beforeunload", () => {
        sessionStorage.setItem("fixture-worker-at-reload", JSON.stringify({
          state: waiting?.state,
          controls: workers.controller === waiting,
        }))
      }, { once: true })
      return performance.timeOrigin
    }, prefix)
    page.on("request", request => {
      if (request.isNavigationRequest()) refreshEvents.push("document requested")
    })
    page.on("response", response => {
      if (response.request().isNavigationRequest()) refreshEvents.push(`document response ${response.status()}`)
    })
    page.on("requestfailed", request => {
      if (request.isNavigationRequest()) refreshEvents.push(`document failure ${request.failure()?.errorText}`)
    })
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) refreshEvents.push("main document navigation")
    })
    try {
      // Check the worker-triggered reload explicitly because its commit can race the click's navigation wait.
      await refresh.click({ noWaitAfter: true })
      await expect.poll(() => candidate.evaluate(() => Reflect.get(self, "fixtureActivationHeld"))).toBe(true)
      await expect.poll(() => refreshEvents).toContain("candidate activating")
      await expect(refresh).toHaveText("Updating…")
      if (control === "force") {
        // The previous force action scheduled a reload after 800 ms.
        await expect(page.waitForRequest(request => request.isNavigationRequest(), { timeout: 1000 }))
          .rejects.toThrow(/Timeout/)
      }
      expect(refreshEvents).not.toContain("document requested")
      if (timeOut) {
        await expect(page.getByRole("alert").filter({ hasText: "The app update didn’t finish. Try again." }))
          .toBeVisible({ timeout: workerTimeout + 2000 })
        await expect(refresh).toBeEnabled()
      }
      await candidate.evaluate(() => Reflect.get(self, "releaseFixtureActivation")())
      if (timeOut) {
        await expect.poll(() => refreshEvents).toContain("candidate activated")
        expect(refreshEvents).not.toContain("document requested")
        await refresh.click({ noWaitAfter: true })
      }
      await page.waitForFunction(previous => performance.timeOrigin !== previous &&
        performance.getEntriesByType("navigation").some(entry =>
          entry instanceof PerformanceNavigationTiming && entry.type === "reload"), previousDocument)
    } catch (error) {
      console.error("Refresh document and worker events", refreshEvents)
      throw error
    }
    await expect(page).toHaveURL(updateUrl)
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("fixture-worker-at-reload") ?? "null")))
      .toEqual({ state: "activated", controls: true })
    await expect.poll(() => page.evaluate(async ({ names, variants, ordinary }) => Promise.all(names.map(async name => {
      const cache = await caches.open(name)
      return Promise.all([...variants, ordinary].map(async url => Boolean(await cache.match(url))))
    })), { names, variants, ordinary })).toEqual(names.map(() => [false, false, false, true]))
    await expect.poll(() => page.evaluate(() => new Promise<boolean>(resolve => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => { channel.port1.close(); resolve(false) }, 500)
      channel.port1.onmessage = event => {
        clearTimeout(timer)
        channel.port1.close()
        resolve(event.data === true)
      }
      navigator.serviceWorker.controller?.postMessage({ type: "COMMENT_MENTIONS_NETWORK_ONLY" }, [channel.port2])
    }))).toBe(true)
    await context.setOffline(true)
    const offline = await page.evaluate(async variants => Promise.all(variants.map(url =>
      fetch(url).then(response => response.text()).catch(() => null))), variants)
    expect(offline).toEqual([null, null, null])
  } finally {
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
}

for (const control of ["toast", "settings", "force"] as const) {
  test(`an older worker sends cleanup POSTs to the network and an update purges private aliases from ${control}`,
    () => verifyWorkerUpdate(control))
}

test("a timed-out update stays on the current page until Refresh is retried", () => verifyWorkerUpdate("toast", true))
