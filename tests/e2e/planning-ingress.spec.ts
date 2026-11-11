import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Planning reads the live queue and saves a score inside managed ingress", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-planning-ingress-"))
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
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    expect((await page.goto(origin + prefix + "/fixture"))?.status()).toBe(200)
    const id: string = await page.evaluate(async scope => {
      const response = await fetch(scope + "/api/tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Plan the garden", status: "backlog" }),
      })
      if (!response.ok) throw new Error("Could not seed Planning fixture")
      await navigator.serviceWorker.register(scope + "/sw.js", { scope: scope + "/" })
      return (await response.json()).id
    }, prefix)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))

    const queueRequest = page.waitForResponse(response => new URL(response.url()).searchParams.has("triageRefresh"))
    await page.goto(origin + prefix + "/planning#triage")
    const queue = await queueRequest
    expect(new URL(queue.url()).pathname).toBe(prefix + "/triage")
    expect(queue.headers()["cache-control"]).toBe("no-store")
    await expect(page.locator(`[data-triage-card="${id}"]`)).toBeVisible()

    await context.setOffline(true)
    const navigation = page.getByRole("navigation", { name: "Planning quick navigation" })
    await navigation.getByRole("link", { name: "Areas & Projects" }).click()
    await navigation.getByRole("link", { name: "Triage" }).click()
    await expect(page.locator("[data-triage-status]")).toContainText("Triage needs a connection")
    await expect(page.locator("[data-triage-card]")).toHaveCount(0)
    await context.setOffline(false)

    await page.goto(origin + prefix + "/planning#rice")
    const scoreLink = page.locator(`[data-rice-task="${id}"] a`)
    await scoreLink.click()
    await expect(page).toHaveURL(url => url.pathname === prefix + "/planning" && url.searchParams.get("score") === id)
    const editor = page.locator("[data-rice-editor]")
    for (const [field, value] of [["reach", "3"], ["impact", "1"], ["confidence", "50"], ["effort", "2"]] as const) {
      await editor.locator(`[name="${field}"]`).fill(value)
    }
    const write = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith(id))
    await editor.getByRole("button", { name: "Save score" }).click()
    const receipt = await write
    expect(new URL(receipt.url()).pathname).toBe(prefix + "/api/tasks/" + id)
    expect(receipt.status()).toBe(200)
    await expect(page.locator(`[data-rice-task="${id}"] [data-rice-score]`)).toHaveText("75")
    await expect(scoreLink).toBeFocused()
    await expect(page).toHaveURL(origin + prefix + "/planning#rice")
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
