import { execFileSync, fork, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"
import { expect, test, type Page } from "@playwright/test"

const notificationTag = "meitheal-notification-test"
type FixtureNotification = Pick<Notification, "title" | "body" | "icon" | "tag" | "data">
type FixtureWindow = Window & { meithealFixtureNotifications?: FixtureNotification[] }

test.describe("browser notification test in Settings", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and disposable ingress fixture")
  test.use({ extraHTTPHeaders: {}, serviceWorkers: "allow" })
  let work: string
  let server: ChildProcess | undefined
  let origin: string
  let scope: string

  test.beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "meitheal-pwa-notification-"))
    const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
    const options = {
      cwd: fileURLToPath(new URL("../../apps/web", import.meta.url)),
      env: { PATH: process.env.PATH, NODE_ENV: "production", MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}` },
    }
    execFileSync(process.execPath, ["scripts/migrate.mjs"], options)
    server = fork(fixture, { ...options, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const [info] = await once(server, "message", { signal: AbortSignal.timeout(10_000) })
    origin = `http://127.0.0.1:${info.port}`
    scope = origin + info.configuredPath + "/"
  })

  test.afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill()
      await exited
    }
    if (work) await rm(work, { recursive: true, force: true })
  })

  async function openTroubleshooting(page: Page) {
    await page.context().addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    await page.goto(scope + "settings")
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    await page.locator('[data-settings-nav="app-pwa-settings"]').click({ timeout: 5_000 })
    await page.getByText("troubleshooting", { exact: true }).click({ timeout: 5_000 })
    return page.getByRole("button", { name: "Send a test notification" })
  }

  async function notifications(page: Page) {
    return page.evaluate(async tag => {
      const registration = await navigator.serviceWorker.getRegistration()
      const fixture = (window as FixtureWindow).meithealFixtureNotifications
      const displayed = fixture?.filter(note => note.tag === tag) ?? await registration?.getNotifications({ tag }) ?? []
      return displayed.map(({ title, body, icon, data }) => ({ title, body, icon, data }))
    }, notificationTag)
  }

  async function allowNotifications(page: Page) {
    await page.context().grantPermissions(["notifications"], { origin })
    await page.addInitScript(() => {
      if (Notification.permission === "granted") return
      // The headless shell used in CI has no notification service even with a permission override.
      const notifications: FixtureNotification[] = []
      ;(window as FixtureWindow).meithealFixtureNotifications = notifications
      Object.defineProperty(Notification, "permission", { value: "granted" })
      ServiceWorkerRegistration.prototype.showNotification = async function (title, options) {
        notifications.push({
          title, body: options?.body ?? "", icon: options?.icon ?? "",
          tag: options?.tag ?? "", data: options?.data,
        })
      }
    })
  }

  test("delivers a browser notification through the App worker", async ({ page }) => {
    await allowNotifications(page)
    const send = await openTroubleshooting(page)
    await page.waitForFunction(async scope => {
      const registration = await navigator.serviceWorker.getRegistration(scope)
      return registration?.scope === scope && registration.active?.state === "activated"
    }, scope, { timeout: 5_000 })
    expect(await notifications(page)).toEqual([])
    await send.click()
    await expect(page.locator("#pwa-notification-result")).toHaveText(/Test notification sent/)
    expect(await notifications(page)).toEqual([{
      title: "Meitheal",
      body: "Test notification from Meitheal.",
      icon: scope + "icon-192.png",
      data: { url: scope + "settings#app-pwa-settings" },
    }])
  })

  test("reports denied permission without trying to prompt again", async ({ page }) => {
    const cdp = await page.context().newCDPSession(page)
    const { targetInfo } = await cdp.send("Target.getTargetInfo")
    if (!targetInfo.browserContextId) throw new Error("Chromium test context missing")
    await cdp.send("Browser.setPermission", {
      permission: { name: "notifications" },
      setting: "denied",
      origin,
      browserContextId: targetInfo.browserContextId,
    })
    await page.addInitScript(() => {
      Notification.requestPermission = () => { throw new Error("Denied permission should not be prompted") }
    })
    const send = await openTroubleshooting(page)
    expect(await page.evaluate(() => Notification.permission)).toBe("denied")
    await send.click()
    await expect(page.locator("#pwa-notification-result")).toHaveText(/Notifications are blocked/)
  })

  test("does not send with a missing App worker or a broader host worker", async ({ page }) => {
    await allowNotifications(page)
    await page.addInitScript(() => {
      const register = navigator.serviceWorker.register.bind(navigator.serviceWorker)
      navigator.serviceWorker.register = (url, options) => options?.scope === "/"
        ? register(url, options)
        : Promise.reject(new Error("App worker is unavailable"))
    })
    const send = await openTroubleshooting(page)
    const result = page.locator("#pwa-notification-result")
    expect(await page.evaluate(async () => !!await navigator.serviceWorker.getRegistration())).toBe(false)
    await send.click()
    await expect(result).toHaveText(/could not send a notification/)

    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" })
      await navigator.serviceWorker.ready
    })
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.scope)).toBe(origin + "/")
    await send.click()
    await expect(result).toHaveText(/could not send a notification/)
    expect(await notifications(page)).toEqual([])

    const oldDocument = await page.evaluate(() => {
      ServiceWorkerRegistration.prototype.update = function () {
        sessionStorage.setItem("fixture-host-worker-updated", "yes")
        return Promise.resolve(this)
      }
      return performance.timeOrigin
    })
    await expect(page.locator("#pwa-update-settings-btn")).toBeHidden()
    await page.locator("#pwa-force-update-btn").click()
    await expect(page.getByRole("alert").filter({ hasText: "The app update didn’t finish. Try again." })).toBeVisible()
    expect(await page.evaluate(() => sessionStorage.getItem("fixture-host-worker-updated"))).toBeNull()
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(oldDocument)
  })
})

test("notification clicks focus or open only within the worker's App scope", async () => {
  const script = await readFile(new URL("../../apps/web/public/sw.js", import.meta.url), "utf8")
  const scope = "https://home.example.test/api/hassio_ingress/meitheal/"
  const target = scope + "settings#app-pwa-settings"
  const handlers = new Map<string, (event: unknown) => void>()
  const opened: string[] = []
  const focused: string[] = []
  let windows: { url: string; focus: () => void }[] = []
  runInNewContext(script, {
    URL,
    self: {
      registration: { scope },
      clients: {
        matchAll: async () => windows,
        openWindow: async (url: string) => { opened.push(url) },
      },
      addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    },
  })
  async function click(url: string) {
    let completion: Promise<unknown> | undefined
    let closed = false
    handlers.get("notificationclick")!({
      notification: { data: { url }, close: () => { closed = true } },
      waitUntil: (work: Promise<unknown>) => { completion = work },
    })
    expect(completion).toBeDefined()
    await completion
    expect(closed).toBe(true)
  }
  windows = [{
    url: scope + "elsewhere?" + target,
    focus: () => { focused.push("substring") },
  }]
  await click(target)
  expect(opened).toEqual([target])
  expect(focused).toEqual([])
  windows.push({ url: target, focus: () => { focused.push("exact") } })
  await click(target)
  expect(focused).toEqual(["exact"])
  expect(opened).toEqual([target])

  await click("https://other.example.test/")
  await click("https://home.example.test/api/hassio_ingress/meitheal-sibling/settings")
  expect(opened).toEqual([target, scope, scope])
})
