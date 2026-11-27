import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { deferred } from "./_helpers"

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
    const app = origin + prefix
    const headers = await currentBoardWriteHeaders(context.request, "household", { origin }, app)
    const created = await context.request.post(app + "/api/tasks", {
      headers, data: { title: "Plan the garden", status: "backlog" },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json() as { id: string }
    await page.evaluate(scope => navigator.serviceWorker.register(scope + "/sw.js", { scope: scope + "/" }).then(() => {}), prefix)
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))

    const queueRequest = page.waitForResponse(response => new URL(response.url()).searchParams.has("triageRefresh"))
    await page.goto(origin + prefix + "/planning#triage")
    const queue = await queueRequest
    expect(new URL(queue.url()).pathname).toBe(prefix + "/triage")
    expect(queue.headers()["cache-control"]).toContain("no-store")
    await expect(page.locator(`[data-triage-card="${id}"]`)).toBeVisible()

    const navigation = page.getByRole("navigation", { name: "Planning quick navigation" })
    await navigation.getByRole("link", { name: "Eisenhower" }).click()
    await navigation.getByRole("link", { name: "Triage" }).click()
    await expect(page.locator(`[data-triage-card="${id}"]`)).toBeVisible()
    await context.setOffline(true)
    await expect(page.getByRole("status").filter({ hasText: "This Board is hidden until access can be verified." })).toBeVisible()
    await expect(page.locator("[data-triage-card]")).toHaveCount(0)
    await expect(navigation).toBeHidden()
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
    await expect(page.locator(`[data-rice-task="${id}"] [data-rice-score]`)).toHaveText("0.75")
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

test("an interrupted scoring read cannot reload a Home Assistant navigation", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-scoring-ingress-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  const taskNavigation = deferred<void>()
  const allowTasks = deferred<void>()
  const allowValidation = deferred<void>()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    const app = origin + prefix
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const headers = await currentBoardWriteHeaders(context.request, "household", { origin }, app)
    const created = await context.request.post(app + "/api/tasks", {
      headers, data: { title: "Ingress scoring fixture", status: "pending", urgency: 0, importance: 0 },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json() as { id: string }
    const page = await context.newPage()
    const matrix = app + "/eisenhower"
    await page.goto(matrix)
    const matrixDocuments: string[] = []
    const validationRequests: string[] = []
    await page.route(url => url.pathname === prefix + "/eisenhower", async route => {
      const outgoing = route.request()
      if (outgoing.headers()["x-meitheal-refresh"] === "1") {
        expect(outgoing.isNavigationRequest()).toBe(false)
        await route.fulfill({ status: 403, contentType: "text/plain", body: "Forbidden" })
      } else {
        if (outgoing.isNavigationRequest()) matrixDocuments.push(outgoing.url())
        await route.continue()
      }
    })
    await page.route(origin + "/api/hassio/ingress/validate_session", async route => {
      validationRequests.push(route.request().method())
      await allowValidation.promise
      await route.fulfill({ status: 200, json: { success: true } }).catch(() => {})
    })
    await page.route(url => url.pathname === prefix + "/tasks", async route => {
      if (route.request().isNavigationRequest()) {
        taskNavigation.resolve()
        await allowTasks.promise
      }
      await route.continue().catch(() => {})
    })
    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    await expect(page.locator("#st-task-title")).toHaveText("Ingress scoring fixture")
    await page.locator("#st-num-urgency").fill("4")
    await page.locator("#st-num-importance").fill("5")
    await page.locator("#st-save-btn").click()
    await expect(page.getByText(/Refresh the page to see/)).toBeVisible()
    const tasks = page.getByRole("link", { name: "Tasks", exact: true }).filter({ visible: true }).first()
    const navigate = tasks.click()
    void navigate.catch(() => {})
    await taskNavigation.promise
    allowValidation.resolve()
    expect(validationRequests).toEqual([])
    allowTasks.resolve()
    await navigate
    await expect(page).toHaveURL(url => url.pathname === prefix + "/tasks")
    expect(matrixDocuments).toEqual([])
    const persisted = await context.request.get(app + "/api/tasks/" + id)
    expect(persisted.status()).toBe(200)
    expect(await persisted.json()).toMatchObject({ urgency: 4, importance: 5 })
  } finally {
    allowValidation.resolve()
    allowTasks.resolve()
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGKILL")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
