import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("the first verified pin reveals the sidebar destination and the last unpin hides it", async ({}, testInfo) => {
  test.setTimeout(60_000)
  const work = await mkdtemp(join(tmpdir(), "meitheal-sidebar-pins-"))
  let child: ChildProcess | undefined
  let browser
  try {
    child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${info.port}`
    const prefix: string = info.configuredPath
    const path = prefix + "/api/task-pins"
    browser = await launchPinBrowser(work)
    // The dedicated pin-worker suite covers service-worker activation and transport checks.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block",
    })
    const owner = (value: string) => context.addCookies([{ name: "feedback-fixture", value, url: origin }])
    await owner("member")
    const page = await context.newPage()
    await page.goto(origin + prefix + "/fixture")
    const app = origin + prefix
    const headers = await currentBoardWriteHeaders(context.request, "household", { origin }, app)
    const created = await context.request.post(app + "/api/tasks", { headers, data: { title: "Replace the hall light" } })
    expect(created.status(), await created.text()).toBe(201)
    const { id: task } = await created.json() as { id: string }
    async function readPresence() {
      const current = await currentBoardWriteHeaders(context.request, "household", { origin }, app)
      return page.evaluate(async ({ path, boardSession }) => {
        const response = await fetch(path, {
          method: "POST", mode: "same-origin", referrerPolicy: "same-origin", cache: "no-store",
          headers: {
            "content-type": "application/json",
            "x-meitheal-board-id": "household",
            "x-meitheal-board-session": boardSession,
          },
          body: JSON.stringify({ action: "presence" }),
        })
        return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() }
      }, { path, boardSession: current["x-meitheal-board-session"]! })
    }
    const empty = await readPresence()
    expect(empty).toMatchObject({ status: 200, cache: "private, no-store", body: { hasPins: false } })
    const checks: string[] = []
    page.on("request", request => {
      if (new URL(request.url()).pathname === path && request.method() === "POST") checks.push(request.postDataJSON().action)
    })
    await page.goto(origin + prefix + "/today?open=" + task)
    await page.bringToFront()
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
    const nav = page.locator('#sidebar [data-page="system-pinned"]')
    const pin = page.locator("#td-pin-action")
    await expect(pin).toBeVisible()
    await expect(pin.locator("svg")).toBeVisible()
    await expect(pin).toHaveAttribute("aria-pressed", "false")
    await expect(nav).toBeHidden()
    await pin.click()
    await expect(nav).toBeVisible()
    await expect(pin).toHaveAttribute("aria-pressed", "true")
    expect(checks).toContain("presence")
    expect(checks).not.toContain("list")

    await owner("member-two")
    const other = await readPresence()
    expect(other).toMatchObject({ status: 200, body: { hasPins: false } })
    await expect(nav).toBeHidden({ timeout: 12000 })
    await owner("member")
    await page.goto(origin + prefix + "/activity")
    await expect(nav).toBeHidden()
    let failPresence = true
    await page.route(origin + path, route => {
      const request = route.request()
      if (!failPresence || request.method() !== "POST" || request.postDataJSON()?.action !== "presence") return route.continue()
      failPresence = false
      return route.fulfill({ status: 503, headers: { "cache-control": "private, no-store" } })
    })
    const failedPresence = page.waitForResponse(response => response.url() === origin + path && response.status() === 503)
    await page.locator("#sidebar .sidebar-brand").focus()
    await failedPresence
    await expect(nav).toBeHidden()
    await expect.poll(async () => {
      await page.keyboard.press("Shift")
      return nav.isVisible()
    }, { timeout: 8_000 }).toBe(true)
    await nav.click()
    const remove = page.getByRole("button", { name: "Unpin Replace the hall light" })
    await expect(remove).toBeVisible()
    await expect(remove.locator("svg")).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("verified-pin.png") })
    await remove.click()
    await expect(page.getByText("Pin removed.")).toBeVisible()
    await expect(nav).toBeHidden()
  } finally {
    await browser?.close()
    if (child?.exitCode === null) {
      child.kill()
      await once(child, "exit")
    }
    await rm(work, { recursive: true, force: true })
  }
})
