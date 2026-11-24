import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable built App")

test("private verification failures explain the hidden Board and retry without losing input; revocation clears it; settings keep the Areas key", async () => {
  test.setTimeout(60_000)
  const work = await mkdtemp(join(tmpdir(), "board-verification-"))
  const child = startCoreFixture(work, false, undefined, undefined, work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const owner = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await owner.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const directory = await owner.request.get(app + "/api/boards")
    const headers = { origin, "x-meitheal-board-session": directory.headers()["x-meitheal-board-session"]! }
    const created = await owner.request.post(app + "/api/boards", { headers, data: { name: "Private recovery Board" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    const api = app + "/api/boards/" + id
    const saved = await owner.request.post(api + "/tickets", { headers, data: { title: "Recovery ticket", description: "Saved description", placement: {} } })
    expect(saved.status()).toBe(201)
    const ticket = await saved.json()
    expect((await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: "member" } })).status()).toBe(200)
    const member = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await member.addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
    const page = await member.newPage()
    page.setDefaultTimeout(8_000)
    const inspector = page.locator("#task-detail-overlay")
    await page.goto(app + "/boards/" + id)
    const open = page.locator(`.kanban-card[data-id="${ticket.id}"] .card-open-btn`)
    await open.press("Enter")
    await expect(inspector.locator("#td-title")).toHaveValue("Recovery ticket")
    await page.goto(app + "/boards/" + id + "?ticket=" + ticket.id)
    const title = inspector.locator("#td-title")
    const description = inspector.locator("#td-description")
    await expect(inspector).toBeVisible()
    await expect(title).toHaveValue("Recovery ticket")
    await inspector.locator("#td-desc-edit-btn-hover").click()
    await description.fill("Keep this description across verification failures")
    await title.fill("Unsubmitted recovery draft")
    let mode: "ok" | "503" | "timeout" = "ok"
    const isVerification = (url: URL) => url.origin === origin && url.pathname === fixture.configuredPath + "/api/boards/" + id
    await page.route(isVerification, async route => {
      if (route.request().method() !== "HEAD" || mode === "ok") return route.continue()
      if (mode === "503") return route.fulfill({ status: 503, body: "Temporarily unavailable" })
      await new Promise(resolve => setTimeout(resolve, 4_500))
      await route.abort().catch(() => {})
    })
    const recovery = page.locator("[data-board-verification]")
    const retry = recovery.getByRole("button", { name: "Retry verification", exact: true })
    const reopenDraft = async () => {
      await expect(recovery).toBeHidden()
      await expect(inspector).toBeVisible()
      await expect(title).toHaveValue("Unsubmitted recovery draft")
      await expect(description).toHaveValue("Keep this description across verification failures")
    }
    mode = "503"
    const rejected = page.waitForResponse(response => response.request().method() === "HEAD" && isVerification(new URL(response.url())) && response.status() === 503)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await rejected
    await expect(recovery).toContainText("hidden until access can be verified")
    await expect(retry).toBeVisible()
    await expect(page.locator(".kanban-card")).toHaveCount(0)
    await expect(inspector).toBeHidden()
    await expect(recovery).not.toContainText("Unsubmitted recovery draft")
    mode = "ok"
    await retry.click()
    await reopenDraft()
    mode = "timeout"
    const timedOut = page.waitForEvent("requestfailed", { predicate: request => request.method() === "HEAD" && isVerification(new URL(request.url())) })
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await timedOut
    await expect(retry).toBeVisible()
    mode = "ok"
    await retry.click()
    await reopenDraft()
    await member.setOffline(true)
    await page.evaluate(() => window.dispatchEvent(new Event("offline")))
    await expect(retry).toBeVisible()
    await expect(page.locator(".kanban-card")).toHaveCount(0)
    await expect(inspector).toBeHidden()
    await member.setOffline(false)
    await page.evaluate(() => window.dispatchEvent(new Event("online")))
    await reopenDraft()
    expect((await owner.request.patch(api, { headers, data: { action: "member", memberId: "fixture-member-two", role: null } })).status()).toBe(200)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(page.locator("[data-board-expired]")).toBeVisible()
    await expect(recovery).toBeHidden()
    await expect(page.locator(".kanban-card")).toHaveCount(0)
    await expect(inspector).toHaveCount(0)
    const admin = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {} })
    await admin.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const settings = await admin.newPage()
    await settings.goto(app + "/settings#tasks-boards-settings")
    const policyForm = settings.locator("#ha-area-feature-form")
    const feature = policyForm.locator('select[name="feature"]')
    await expect(feature).toBeEnabled()
    await expect(feature.locator('option[value="groups"]')).toHaveText("Areas")
    await feature.selectOption("groups")
    await policyForm.locator('select[name="audience"]').selectOption("everyone")
    const policySaved = settings.waitForResponse(response => response.request().method() === "PUT" && response.url().endsWith("/api/organization-features"))
    await policyForm.getByRole("button", { name: "Save availability", exact: true }).click()
    expect((await policySaved).ok()).toBe(true)
    expect((await (await admin.request.get(app + "/api/organization-features")).json()).features.groups.audience).toBe("everyone")
    await expect(feature).toHaveValue("groups")
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
