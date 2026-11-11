import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test as base, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "./task-pins-fixture"

type Household = { context: BrowserContext; api: APIRequestContext; origin: string; prefix: string; launchBrowser(args: string[]): Promise<Browser> }

/** Disposable authenticated ingress, with paths adapted from ordinary app-relative tests. */
export const test = base.extend<{ household: Household }>({
  household: async ({ playwright }, use) => {
    const work = await mkdtemp(join(tmpdir(), "meitheal-settings-persistence-"))
    const child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser
    let api
    try {
      const [info] = await once(child, "message", { signal: AbortSignal.timeout(10000) })
      const origin = `https://127.0.0.1:${info.port}`
      const prefix: string = info.configuredPath
      browser = await launchPinBrowser(work)
      const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
      await context.setExtraHTTPHeaders({})
      await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
      api = await playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true,
        extraHTTPHeaders: { cookie: "feedback-fixture=admin", origin } })
      await use({ context, api, origin, prefix, launchBrowser: args => launchPinBrowser(work, false, args) })
    } finally {
      await api?.dispose()
      await browser?.close()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit")
        child.kill()
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  },
  page: async ({ household }, use) => {
    const page = await household.context.newPage()
    const navigate = page.goto.bind(page)
    page.goto = (url, options) => navigate(url.startsWith("/") ? household.origin + household.prefix + url : url, options)
    await use(page)
  },
  request: async ({ household }, use) => {
    const methods = new Set(["get", "post", "put", "patch", "delete", "head", "fetch"])
    const request = new Proxy(household.api, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (typeof value !== "function") return value
        if (!methods.has(String(property))) return value.bind(target)
        return (url: unknown, ...options: unknown[]) => Reflect.apply(value, target, [
          typeof url === "string" && url.startsWith("/") ? household.prefix + url : url, ...options,
        ])
      },
    })
    await use(request)
  },
})
