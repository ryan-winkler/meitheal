import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test as base, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"

type Fixture = { page: Page; app: string; origin: string }

const test = base.extend<{ homeAssistant: Fixture }>({
  homeAssistant: async ({}, use) => {
    const work = await mkdtemp(join(tmpdir(), "planning-progress-"))
    const child = startCoreFixture(work, false, undefined, undefined, work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser
    try {
      const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${fixture.port}`
      browser = await launchPinBrowser(work)
      const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" })
      await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
      await use({ page: await context.newPage(), origin, app: origin + fixture.configuredPath })
    } finally {
      await browser?.close()
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit")
        child.kill("SIGTERM")
        await stopped
      }
      await rm(work, { recursive: true, force: true })
    }
  },
})

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")

test("Planning and Progress select Boards without carrying foreign placement", async ({ homeAssistant }, info) => {
  const { page, app, origin } = homeAssistant
  const request = page.context().request
  const headers = await currentBoardWriteHeaders(request, "household", { origin }, app)
  const post = async (endpoint: string, data: object) => {
    const response = await request.post(app + endpoint, { headers, data })
    expect(response.ok(), await response.text()).toBe(true)
    return (await response.json()).id as string
  }
  const area = await post("/api/areas", { name: "Kitchen" })
  const board = await post("/api/boards", { name: "Workshop with a long name for a narrow Home Assistant panel" })
  const picker = page.locator("[data-board-page-picker]")
  const summary = picker.locator("summary")
  const workshop = picker.getByRole("link", { name: /^Workshop with/ })
  const household = picker.getByRole("link", { name: "Household", exact: true })
  for (const [width, view, section] of [[320, "planning", "rice"], [1440, "progress", "goals"]] as const) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(app + `/${view}?board_id=household&area_id=${area}#${section}`)
    await expect(summary).toHaveAccessibleName("Switch Board: Household")
    await expect(page.locator(".board-page-context__placement")).toHaveText("Kitchen")
    await summary.press("Space")
    await expect(workshop).toBeVisible()
    await expect(picker.locator('[aria-current="true"]')).toHaveText("Household")
    const bounds = await picker.locator("ul").boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
    expect(Math.round((await workshop.boundingBox())!.height)).toBeGreaterThanOrEqual(44)
    await page.screenshot({ path: info.outputPath(`${view}-board-picker.png`) })
    await workshop.focus()
    await workshop.press("Escape")
    await expect(summary).toBeFocused()
    await expect(workshop).toBeHidden()
    await summary.press("Enter")
    await workshop.press("Enter")
    await expect(page).toHaveURL(app + `/${view}?board_id=${board}#${section}`)
    await expect(page.locator(`#${view}-section-${section}`)).toBeVisible()
    await expect(summary).toHaveAccessibleName(/^Switch Board: Workshop/)
    await expect(page.locator(".board-page-context__placement")).toHaveCount(0)
    if (view === "progress") {
      await summary.click()
      await picker.getByRole("link", { name: "Personal & Household" }).click()
      await expect(page).toHaveURL(app + "/progress#goals")
      await expect(summary).toHaveAccessibleName("Switch Board: Personal & Household")
      await page.goBack()
      await expect(summary).toHaveAccessibleName(/^Switch Board: Workshop/)
    }
    await summary.press("Enter")
    await household.press("Enter")
    await expect(page).toHaveURL(app + `/${view}?board_id=household#${section}`)
    await page.goBack()
    await expect(page).toHaveURL(app + `/${view}?board_id=${board}#${section}`)
  }

  await page.context().addCookies([{ name: "feedback-fixture", value: "member-two", url: origin }])
  await page.goto(app + "/progress?board_id=household#goals")
  await summary.press("Enter")
  await expect(workshop).toHaveCount(0)
  const unavailable = await page.goto(app + `/progress?board_id=${board}#goals`)
  expect(unavailable?.status()).toBe(404)
  await expect(page.getByText(/^Workshop with/)).toHaveCount(0)
})

test("the destination appears before scripts load on a cold HA panel and direct section links", async ({ homeAssistant }, info) => {
  const { page, app, origin } = homeAssistant
  const scripts = /\/_astro\/[^/]+\.js(?:\?|$)/
  await page.route(scripts, route => route.abort())
  const target = "/progress?board_id=household#goals"
  const host = origin + "/mock-ha-panel?" + new URLSearchParams({ meitheal: target })
  await page.route(host, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><home-assistant></home-assistant><iframe style="width: 100%;height: 94vh;border:0" src="${app}/"></iframe>`,
  }))
  await page.addInitScript(() => {
    if (window === window.parent) return
    const measure = () => {
      if (document.querySelector("#dashboard-shell") && getComputedStyle(document.body).display !== "none") {
        window.parent.document.documentElement.dataset.paintedDashboard = "true"
      }
      requestAnimationFrame(measure)
    }
    requestAnimationFrame(measure)
  })
  await page.goto(host)
  const frame = page.frameLocator("iframe")
  await expect(frame.locator("#progress-section-goals")).toBeVisible()
  await expect(frame.locator("#progress-section-pillars")).toBeHidden()
  await expect(frame.locator("#progress-shell")).not.toHaveAttribute("data-parent-page-booted")
  await expect(page.locator("html")).not.toHaveAttribute("data-painted-dashboard")
  await page.screenshot({ path: info.outputPath("cold-panel-goals.png") })

  await page.goto(app + "/planning?board_id=household#rice")
  await expect(page.locator("#planning-section-rice")).toBeVisible()
  await expect(page.locator("#planning-section-spaces")).toBeHidden()
  await expect(page.locator("#planning-section-eisenhower")).toBeHidden()
  await expect(page.locator("#planning-section-rice")).toHaveCSS("animation-name", "none")
  await expect(page.locator("#planning-shell")).not.toHaveAttribute("data-parent-page-booted")
  await page.screenshot({ path: info.outputPath("direct-planning-rice.png") })
})
