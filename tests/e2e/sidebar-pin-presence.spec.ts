import type { ChildProcess } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, pinRequest, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Run with MEITHEAL_TEST_BROWSER=1 and a built web app")

test("the first verified pin reveals the sidebar destination and the last unpin hides it", async ({}, testInfo) => {
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: {} })
    await context.setExtraHTTPHeaders({})
    const owner = (value: string) => context.addCookies([{ name: "feedback-fixture", value, url: origin }])
    await owner("member")
    const page = await context.newPage()
    await page.goto(origin + prefix + "/fixture")
    const task = await page.evaluate(async prefix => {
      const response = await fetch(prefix + "/api/tasks", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Replace the hall light" }),
      })
      if (!response.ok) throw new Error(`Could not create task: ${response.status}`)
      return (await response.json()).id as string
    }, prefix)
    const empty = await pinRequest(page, path, "POST", { action: "presence" })
    expect(empty).toMatchObject({ status: 200, cache: "private, no-store", body: { hasPins: false } })
    const checks: string[] = []
    page.on("request", request => {
      if (new URL(request.url()).pathname === path && request.method() === "POST") checks.push(request.postDataJSON().action)
    })
    await page.goto(origin + prefix + "/today?open=" + task)
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
    const other = await pinRequest(page, path, "POST", { action: "presence" })
    expect(other).toMatchObject({ status: 200, body: { hasPins: false } })
    await expect(nav).toBeHidden({ timeout: 12000 })
    await owner("member")
    await page.goto(origin + prefix + "/activity")
    await expect(nav).toBeHidden()
    await page.locator("#sidebar .sidebar-brand").focus()
    await expect(nav).toBeVisible()
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
