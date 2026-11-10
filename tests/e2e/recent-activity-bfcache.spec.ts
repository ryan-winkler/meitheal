import { once } from "node:events"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { chromium, expect, test, type Browser } from "@playwright/test"
import { recentActivityPersonKey } from "../../apps/web/src/domains/tasks/persistence/recent-activity"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the built App and disposable HTTPS ingress")
test.skip(!existsSync(process.env.MEITHEAL_BFCACHE_CHROMIUM ?? chromium.executablePath()), "Requires full Chromium with history cache support")

for (const revoked of [false, true]) {
  test(`Recent activity restores through a fresh permission check when the member is ${revoked ? "revoked" : "active"}`, async () => {
    const work = await mkdtemp(join(process.env.MEITHEAL_TEST_TMPDIR || tmpdir(), "meitheal-activity-history-"))
    const child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser: Browser | undefined
    try {
      const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${info.port}`
      const prefix: string = info.configuredPath
      const person = recentActivityPersonKey("fixture-member")
      const url = origin + prefix + "/activity?area=default&person=" + person
      const sentinel = "Private Recent Activity History Fixture"
      browser = await launchPinBrowser(work, true)
      const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
      await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      await cdp.send("Page.enable")
      let historyDiagnostic: unknown
      cdp.on("Page.backForwardCacheNotUsed", event => { historyDiagnostic = event.notRestoredExplanationsTree })
      // Isolate history restoration from the ordinary event stream.
      await page.route(/\/api\/sse(?:[/?]|$)/, route => route.fulfill({ status: 204 }))
      const prefixMessage = "activity-history-snapshot:"
      let snapshot: unknown
      page.on("console", message => {
        if (message.text().startsWith(prefixMessage)) snapshot = JSON.parse(message.text().slice(prefixMessage.length))
      })
      await page.addInitScript(prefixMessage => {
        window.addEventListener("pageshow", event => {
          if (!event.persisted) return
          const section = document.querySelector<HTMLElement>("[data-recent-activity]")
          console.info(prefixMessage + JSON.stringify({
            hidden: section?.hidden,
            rows: section?.querySelectorAll("[data-activity-event]").length,
            filters: section?.querySelectorAll("select").length,
          }))
        })
      }, prefixMessage)
      expect((await page.goto(origin + prefix + "/fixture"))?.status()).toBe(200)
      const seeded = await page.evaluate(async ({ path, title }) => {
        const response = await fetch(path, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
        })
        return response.status
      }, { path: prefix + "/api/tasks", title: sentinel })
      expect(seeded).toBe(201)
      expect((await page.goto(url))?.headers()["cache-control"]).toBe("private, no-store")
      const section = page.locator("[data-recent-activity]")
      await expect(section).toHaveAttribute("data-history-guard", "true")
      const task = section.getByRole("link", { name: new RegExp(sentinel) })
      await expect(task).toBeVisible()
      await page.waitForLoadState("networkidle")
      const cookies = await context.cookies(origin)
      const away = page.waitForNavigation({ waitUntil: "commit" })
      await task.click()
      expect((await away)?.url()).toContain(prefix + "/tasks?open=")
      await page.waitForLoadState("domcontentloaded")
      if (revoked) {
        const changed = once(child, "message", { signal: AbortSignal.timeout(3_000) })
        child.send({ type: "fixture-core", user: "member", active: false })
        expect((await changed)[0]).toEqual({ coreChanged: true })
      }
      expect(await context.cookies(origin)).toEqual(cookies)

      const [response] = await Promise.all([
        page.waitForResponse(response => response.url() === url && response.request().isNavigationRequest()),
        page.goBack({ waitUntil: "commit" }),
      ])
      try {
        await expect.poll(() => snapshot).toEqual({ hidden: true, rows: 0, filters: 0 })
      } catch (error) {
        console.error(JSON.stringify({ historyDiagnostic }))
        throw error
      }
      expect(response.headers()["cache-control"]).toBe("private, no-store")
      expect(response.status()).toBe(revoked ? 403 : 200)
      await expect(page).toHaveURL(url)
      if (revoked) {
        await expect(page.getByText("Open Recent activity through Home Assistant with an active account.")).toBeVisible()
        await expect(page.getByText(sentinel, { exact: false })).toHaveCount(0)
      } else {
        await expect(section.getByRole("link", { name: new RegExp(sentinel) })).toBeVisible()
        await expect(section.getByRole("combobox", { name: "Current area" })).toHaveValue("default")
        await expect(section.getByRole("combobox", { name: "Person" })).toHaveValue(person)
      }
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
}
