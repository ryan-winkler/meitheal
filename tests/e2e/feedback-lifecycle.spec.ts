import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base, type Page } from "@playwright/test"
import { startCoreFixture } from "../scripts/task-pins-fixture"
import { deferred } from "./_helpers"

const devUrl = process.env.FEEDBACK_LIFECYCLE_DEV_URL
const test = base.extend<{ feedbackPage: Page }>({
  feedbackPage: async ({ browser }, use) => {
    const work = await mkdtemp(join(tmpdir(), "meitheal-feedback-ui-"))
    const child = devUrl ? null : startCoreFixture(work, true)
    child?.stdout?.resume()
    child?.stderr?.resume()
    const context = await browser.newContext({ extraHTTPHeaders: {} })
    try {
      let url = devUrl
      if (child) {
        const [info] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
        const origin = `http://127.0.0.1:${info.port}`
        await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
        url = origin + info.configuredPath + "/settings#app-pwa-settings"
      }
      const page = await context.newPage()
      page.on("pageerror", error => console.log("Feedback fixture page error:", error.message))
      page.on("response", response => { if (response.status() >= 400 && response.url().includes("_astro")) console.log("Feedback fixture asset:", response.status(), response.url()) })
      await page.goto(url!)
      page.on("console", message => { if (message.type() === "error") console.log("Feedback console:", message.text()) })
      await expect(page.locator("[data-feedback-form] fieldset")).toHaveJSProperty("disabled", false)
      await use(page)
    } finally {
      await context.close()
      if (child) { const exit = once(child, "exit"); child.kill(); await exit }
      await rm(work, { recursive: true, force: true })
    }
  },
})
test.skip(!devUrl && process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires actual dev or built ingress fixture")

function report(state = "in_progress") {
  return {
    id: "11111111-1111-4111-8111-111111111111", category: "accessibility", state,
    message: "Seán O'Brien-Ó Súilleabháin reported a problem: " + "界".repeat(1000),
    receivedAt: 0, submitterId: "a".repeat(128), appVersion: "d73084837f30", routeFamily: "settings",
    claimedBy: "fixture-admin", closedBy: null, disposition: null,
  }
}

async function navigateSection(page: Page, hash: string) {
  await page.evaluate(hash => {
    history.pushState(history.state, "", hash)
    document.querySelector("#settings-shell")!.dispatchEvent(new Event("meitheal:settings-jump"))
  }, hash)
}

test("Feedback preserves drafts, exact focus ownership and scoped confirmation", async ({ feedbackPage: page }) => {
  let current = report()
  let deletes = 0
  let patchGate: ReturnType<typeof deferred<void>> | null = null
  const patchStarted = deferred<void>()
  await page.route(/\/api\/feedback(?:[/?]|$)/, async route => {
    const method = route.request().method()
    if (method === "PATCH") {
      patchStarted.resolve()
      if (patchGate) await patchGate.promise
      current = { ...current, state: route.request().postDataJSON().state }
      return route.fulfill({ json: current })
    }
    if (method === "DELETE") { deletes++; return route.fulfill({ status: 204 }) }
    if (method === "POST") return route.fulfill({ json: { category: "accessibility", message: "Reviewed safe reproduction" } })
    const filter = new URL(route.request().url()).searchParams.get("state")
    return route.fulfill({ json: { reports: !filter || filter === current.state ? [current] : [], nextCursor: null } })
  })
  const queue = page.locator("[data-feedback-queue]")
  await queue.locator(":scope > summary").click()
  await page.locator("[data-feedback-filter]").selectOption("")
  const entry = page.locator("[data-report-id]")
  await expect(entry).toHaveCount(1)
  await entry.locator(":scope > summary").click()
  await entry.locator('[name="disposition"]').fill("Keep my unfinished disposition")
  await entry.locator(".feedback-export > summary").click()
  await entry.locator('[name="reviewedMessage"]').fill("Keep my redacted export draft")
  await page.getByRole("button", { name: "Refresh reports", exact: true }).click()
  await expect(page.locator("[data-queue-controls]")).toHaveJSProperty("disabled", false)
  await expect(entry.locator('[name="disposition"]')).toHaveValue("Keep my unfinished disposition")
  await expect(entry.locator('[name="reviewedMessage"]')).toHaveValue("Keep my redacted export draft")
  await page.locator("[data-feedback-filter]").selectOption("open")
  await expect(entry).toHaveCount(0)
  await page.locator("[data-feedback-filter]").selectOption("")
  await expect(entry).toHaveCount(1)
  await entry.locator(":scope > summary").click()
  await expect(entry.locator('[name="disposition"]')).toHaveValue("Keep my unfinished disposition")
  current = report("open")
  await page.getByRole("button", { name: "Refresh reports", exact: true }).click()
  await expect(entry.locator("[data-claim-report]")).toBeVisible()
  patchGate = deferred<void>()
  await entry.locator("[data-claim-report]").click()
  await patchStarted.promise
  const anotherControl = entry.locator(".feedback-export > summary")
  await anotherControl.focus()
  patchGate.resolve()
  await expect(page.locator("[data-queue-controls]")).toHaveJSProperty("disabled", false)
  await expect(anotherControl).toBeFocused()
  await expect(entry.locator('[name="disposition"]')).toHaveValue("Keep my unfinished disposition")

  // Test actual shell pushState/custom navigation, not just a hashchange surrogate.
  current = report("resolved")
  await page.getByRole("button", { name: "Refresh reports", exact: true }).click()
  await expect(entry.locator("[data-delete-report]")).toBeVisible()
  await entry.locator("[data-delete-report]").click()
  await expect(page.locator("#meitheal-confirm-overlay")).toBeVisible()
  await navigateSection(page, "#personal-settings")
  await expect(page.locator("#meitheal-confirm-overlay")).toHaveCount(0)
  expect(deletes).toBe(0)
  await navigateSection(page, "#app-pwa-settings")
  await entry.locator("[data-delete-report]").click()
  await page.locator("#confirm-cancel").click()
  await expect(page.locator("#meitheal-confirm-overlay")).toHaveCount(0)
  await expect(entry.locator("[data-delete-report]")).toBeFocused()
  expect(deletes).toBe(0)
  await entry.locator("[data-delete-report]").click()
  await page.locator("#confirm-ok").click()
  await expect(entry).toHaveCount(0)
  expect(deletes).toBe(1)
  await expect(page.getByRole("button", { name: "Refresh reports", exact: true })).toBeFocused()
})

test("Feedback denies late queue responses after current access is lost", async ({ feedbackPage: page }) => {
  const gate = deferred<void>()
  const arrived = deferred<void>()
  await page.route(/\/api\/feedback(?:[/?]|$)/, async route => {
    if (route.request().method() === "GET") {
      arrived.resolve()
      await gate.promise
      return route.fulfill({ json: { reports: [report()], nextCursor: null } })
    }
    return route.fulfill({ status: 403, json: { detail: "Current access denied" } })
  })
  await page.locator("[data-feedback-queue] > summary").click()
  await arrived.promise
  await page.locator('[name="category"]').selectOption("problem")
  await page.locator('[name="message"]').fill("Synthetic access loss")
  await page.getByRole("button", { name: "Save feedback", exact: true }).click()
  await expect(page.locator("[data-feedback-status]")).toContainText("Current access denied")
  gate.resolve()
  await expect(page.locator("[data-queue-status]")).toContainText("no longer permits")
  await expect(page.locator("[data-report-id]")).toHaveCount(0)
  await expect(page.locator("[data-queue-controls]")).toHaveJSProperty("disabled", true)
})

test("Feedback retry preserves identity and delayed completion leaves new focus alone", async ({ feedbackPage: page }) => {
  const ids: string[] = []
  const gate = deferred<void>()
  const arrived = deferred<void>()
  await page.route(/\/api\/feedback$/, async route => {
    ids.push(route.request().postDataJSON().submissionId)
    if (ids.length === 1) return route.abort()
    arrived.resolve()
    await gate.promise
    return route.fulfill({ status: 201, json: { id: report().id, receivedAt: 0 } })
  })
  await page.locator('[name="category"]').selectOption("problem")
  await page.locator('[name="message"]').fill("Synthetic delayed report")
  await page.getByRole("button", { name: "Save feedback", exact: true }).click()
  await expect(page.locator("[data-feedback-status]")).toContainText("Could not reach")
  await page.getByRole("button", { name: "Save feedback", exact: true }).click()
  await arrived.promise
  await navigateSection(page, "#personal-settings")
  const active = await page.evaluate(() => document.activeElement?.id)
  gate.resolve()
  await expect(page.locator("[data-feedback-status]")).toContainText("Feedback saved")
  expect(await page.evaluate(() => document.activeElement?.id)).toBe(active)
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe(ids[1])
})

test("Feedback wraps schema-backed actor IDs and full-page report text at narrow and large text sizes", async ({ feedbackPage: page }) => {
  await page.route(/\/api\/feedback(?:[/?]|$)/, route => route.fulfill({ json: {
    reports: Array.from({ length: 25 }, (_, index) => ({ ...report(), id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` })),
    nextCursor: null,
  } }))
  await page.locator("[data-feedback-queue] > summary").click()
  await page.locator("[data-feedback-filter]").selectOption("")
  await expect(page.locator("[data-report-id]")).toHaveCount(25)
  await page.locator("[data-report-id] > summary").first().click()
  for (const scenario of [{ width: 1280, scale: 1, rtl: false }, { width: 320, scale: 1, rtl: false }, { width: 736, scale: 2, rtl: true }]) {
    await page.setViewportSize({ width: scenario.width, height: 900 })
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await page.evaluate(({ scale, rtl }) => {
      document.documentElement.style.fontSize = `${16 * scale}px`
      document.documentElement.dir = rtl ? "rtl" : "ltr"
    }, scenario)
    const dimensions = await page.locator("[data-feedback-panel]").evaluate(panel => ({ width: panel.clientWidth, scroll: panel.scrollWidth }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1)
  }
})
