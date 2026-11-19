import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { expect, test as base, type Page } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

const test = base.extend<{ planning: { page: Page; app: string; area: string; project: string } }>({
  planning: async ({}, use) => {
    const work = await mkdtemp(join(tmpdir(), "planning-navigation-"))
    const child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    let browser
    try {
      const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
      const origin = `https://127.0.0.1:${fixture.port}`
      const app = origin + fixture.configuredPath
      browser = await launchPinBrowser(work)
      const context = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: {}, serviceWorkers: "block" })
      context.setDefaultTimeout(6_000)
      await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
      const create = async (path: string, data: object) => {
        const response = await context.request.post(app + path, { headers: { origin }, data })
        expect(response.status(), await response.text()).toBe(201)
        return (await response.json()).id as string
      }
      const area = await create("/api/areas", { name: "Navigation workshop" })
      const project = await create("/api/projects", { title: "Navigation lighting", area_id: area })
      await use({ page: await context.newPage(), app, area, project })
    } finally {
      await browser?.close()
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
        child.kill("SIGKILL")
        await exited
      }
      await rm(work, { recursive: true, force: true })
    }
  },
})

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

// Regression: Area arrow navigation activated the cross-page Tasks link.
// Found by /qa on 2026-11-18; evidence: final-qa/planning in the local project evidence directory.
test("Area arrows stay in local panels and Tasks explicitly opens the scoped Kanban", async ({ planning }, testInfo) => {
  const { page, app, area, project } = planning
  const path = `/boards/household?area=${area}&view=groups`
  await page.goto(app + path + "#overview")
  const tabs = page.getByRole("tablist", { name: "Area sections" })
  const overview = tabs.getByRole("tab", { name: /Overview/ })
  const localTabs = tabs.locator('[role="tab"][aria-controls]')
  const nextId = await localTabs.nth(1).getAttribute("data-tab")
  await overview.focus()
  await overview.press("ArrowRight")
  await page.screenshot({ path: testInfo.outputPath("area-arrow-right.png"), fullPage: true })
  await expect(page).toHaveURL(app + path + "#" + nextId)
  await expect(localTabs.nth(1)).toBeFocused()
  await localTabs.nth(1).press("End")
  await expect(tabs.getByRole("tab", { name: /Settings/ })).toBeFocused()
  await expect(page.locator("#section-group-settings")).toBeVisible()
  await page.keyboard.press("Home")
  await expect(overview).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(tabs.getByRole("tab", { name: /Settings/ })).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(overview).toBeFocused()
  const tasks = page.getByRole("navigation", { name: "Area sections" }).getByRole("link", { name: "Tasks", exact: true })
  await expect(tabs.getByRole("tab", { name: /Tasks/ })).toHaveCount(0)
  await expect(tasks).not.toHaveAttribute("aria-selected")
  await overview.press("Shift+Tab")
  await expect(tasks).toBeFocused()
  await tasks.press("Enter")
  await expect(page).toHaveURL(app + `/boards/household?area=${area}#kanban`)
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

  await page.goto(app + `/boards/household?project=${project}&from=${area}&view=groups#overview`)
  const projectNavigation = page.getByRole("navigation", { name: "Project sections" })
  await expect(projectNavigation.getByRole("tab", { name: /Tasks/ })).toHaveCount(0)
  const projectTasks = projectNavigation.getByRole("link", { name: "Tasks", exact: true })
  await expect(projectTasks).not.toHaveAttribute("aria-selected")
  await projectNavigation.getByRole("tab", { name: "Overview", exact: true }).press("Shift+Tab")
  await expect(projectTasks).toBeFocused()
  await projectTasks.press("Enter")
  await expect(page).toHaveURL(app + `/boards/household?project=${project}&from=${area}#kanban`)
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
})

for (const width of [320, 375]) {
  for (const personalized of [false, true]) {
    test(`Settings stays visible and works with pointer and keyboard at ${width}px${personalized ? " with a long task label" : ""}`, async ({ planning }, testInfo) => {
      const { page, app, area, project } = planning
      await page.setViewportSize({ width, height: 780 })
      const label = personalized ? "HouseholdResponsibilitiesAndFollowUps" : "Tasks"
      if (personalized) {
        const endpoint = app + "/api/organization-labels"
        const response = await page.context().request.get(endpoint)
        expect(response.status()).toBe(200)
        const preferences = await response.json()
        const saved = await page.context().request.put(endpoint, {
          headers: { origin: new URL(app).origin },
          data: { ...preferences, forms: { ...preferences.forms, task: ["Responsibility", label] } },
        })
        expect(saved.status(), await saved.text()).toBe(204)
      }
      for (const [kind, query, section] of [
        ["Area", `area=${area}`, "group-settings"],
        ["Project", `project=${project}&from=${area}`, "project-settings"],
      ] as const) {
        const url = app + `/boards/household?${query}&view=groups#overview`
        await page.goto(url)
        const navigation = page.getByRole("navigation", { name: `${kind} sections` })
        const settings = navigation.getByRole("tab", { name: /Settings/ })
        const tasks = navigation.getByRole("link", { name: label, exact: true })
        await page.screenshot({ path: testInfo.outputPath(`${kind.toLowerCase()}-${width}-${personalized ? "long" : "default"}.png`), fullPage: true })
        await expect(settings).toBeInViewport({ ratio: 1 })
        const bounds = await settings.boundingBox()
        expect(bounds).not.toBeNull()
        expect(bounds!.x).toBeGreaterThanOrEqual(0)
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
        await expect(tasks).toBeInViewport({ ratio: 1 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
        await settings.click()
        await expect(page.locator("#section-" + section)).toBeVisible()
        await expect(page).toHaveURL(url.replace("#overview", "#" + section))
        const overview = navigation.getByRole("tab", { name: /Overview/ })
        await overview.click()
        await overview.focus()
        if (kind === "Area") await overview.press("End")
        else {
          await overview.press("Tab")
          await page.keyboard.press("Tab")
        }
        await expect(settings).toBeFocused()
        await settings.press("Enter")
        await expect(page.locator("#section-" + section)).toBeVisible()
        await expect(settings).toBeInViewport({ ratio: 1 })
      }
    })
  }
}
