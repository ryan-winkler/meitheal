import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

const layoutKey = "meitheal:dashboard-layout:v1:browser"
const overview = "dashboard-overview"
const momentum = "dashboard-momentum"
const capture = "dashboard-capture"
const focus = "dashboard-open"
const recent = "dashboard-recent"
const defaultOrder = [overview, momentum, capture, focus, recent]

test.describe("Dashboard layout", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test.beforeEach(async ({ page }) => {
    await page.goto("/?view=dashboard")
    await expect(page.locator("#dashboard-shell")).toHaveAttribute("data-dashboard-booted", "true")
  })

  test("saves keyboard order, widget visibility and collapsed width while keeping linked widgets accessible", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 950 })
    const widgets = page.locator("#dashboard-shell > [data-dashboard-section]")
    const customize = page.getByRole("button", { name: "Customize dashboard" })
    await customize.click()
    const editor = page.getByRole("dialog", { name: "Customize dashboard" })
    await expect(editor).toBeVisible()
    await expect(editor.getByRole("button", { name: "Cancel" })).toBeFocused()
    await editor.getByRole("button", { name: "Move Capture up" }).click()
    await editor.getByRole("button", { name: "Move Capture up" }).press("Enter")
    await editor.getByRole("checkbox", { name: "Show Recent" }).uncheck()
    await editor.getByRole("combobox", { name: "Capture width" }).selectOption("half")
    await editor.getByRole("combobox", { name: "Overview width" }).selectOption("half")
    await editor.getByRole("combobox", { name: "Overview state" }).selectOption("collapsed")
    await editor.getByRole("button", { name: "Save dashboard" }).click()

    await expect(editor).toBeHidden()
    await expect(customize).toBeFocused()
    expect(await widgets.evaluateAll(nodes => nodes.map(node => node.id))).toEqual([capture, overview, momentum, focus, recent])
    await expect(page.locator("#dashboard-recent")).toBeHidden()
    await expect(page.locator("#dashboard-overview [data-dashboard-widget-collapsed]")).toBeVisible()
    const tabs = page.locator("#dashboard-bar-tabs > [data-section-id]:not([hidden])")
    const titleSwitcher = page.locator("#dashboard-bar-switcher-btn")
    const sectionOrder = [capture, overview, momentum, focus]
    expect(await tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section-id")))).toEqual(sectionOrder)
    await tabs.last().press("ArrowRight")
    await expect(tabs.first()).toBeFocused()
    await tabs.first().press("ArrowLeft")
    await expect(tabs.last()).toBeFocused()

    // Reserve space for one tab. The title switcher still exposes the other visible widgets.
    await page.locator("#dashboard-bar-tabs").evaluate(node => { node.style.flex = "0 0 105px" })
    await expect(tabs.first()).not.toHaveAttribute("data-overflow-hidden", "")
    await expect(tabs.nth(1)).toHaveAttribute("data-overflow-hidden", "")
    await titleSwitcher.click()
    const items = page.getByRole("menu", { name: "Dashboard sections" }).getByRole("menuitem")
    expect(await items.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section-id")))).toEqual(sectionOrder)
    await items.last().press("ArrowDown")
    await expect(items.first()).toBeFocused()
    await items.first().press("ArrowUp")
    await expect(items.last()).toBeFocused()
    await items.last().press("Escape")
    await expect(titleSwitcher).toBeFocused()

    const pos = await page.locator("#dashboard-capture, #dashboard-overview").evaluateAll(nodes =>
      nodes.map(node => ({ left: node.getBoundingClientRect().left, top: node.getBoundingClientRect().top })))
    expect(pos[0]?.top).toEqual(pos[1]?.top)
    expect(pos[0]?.left).toBeLessThan(pos[1]?.left ?? 0)

    const saved = await page.evaluate(key => localStorage.getItem(key), layoutKey)
    await page.goto("/?view=dashboard#dashboard-recent")
    await expect(page.locator("#dashboard-recent")).toBeVisible()
    await expect(page.locator("#dashboard-bar-tabs > [data-section-id='dashboard-recent']")).toBeHidden()
    await page.goto("/?view=dashboard#dashboard-overview")
    await expect(page.locator("#dashboard-overview [data-dashboard-widget-body]")).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), layoutKey)).toEqual(saved)

    await page.goto("/?view=dashboard")
    await expect(page.locator("#dashboard-recent")).toBeHidden()
    await expect(page.locator("#dashboard-overview [data-dashboard-widget-body]")).toBeHidden()
    expect(await tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section-id")))).toEqual(sectionOrder)
    await tabs.nth(1).click()
    await expect(page.locator("#dashboard-overview [data-dashboard-widget-body]")).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), layoutKey)).toEqual(saved)
    await page.goto("/?view=dashboard")
    await page.setViewportSize({ width: 360, height: 800 })
    const widths = await page.locator("#dashboard-capture, #dashboard-overview").evaluateAll(nodes =>
      nodes.map(node => node.getBoundingClientRect().width))
    expect(widths[0]).toEqual(widths[1])
    expect(await page.locator("#dashboard-shell").evaluate(node => node.scrollWidth)).toBeLessThanOrEqual(360)

    // Browser Back encounters the saved hidden section before anchor lookup can see it.
    await page.evaluate(() => {
      history.replaceState(history.state, "", "#dashboard-recent")
      history.pushState(history.state, "", location.pathname + location.search)
      window.scrollTo(0, 0)
      history.back()
    })
    await expect(page).toHaveURL(/#dashboard-recent$/)
    const recentWidget = page.locator("#dashboard-recent")
    await expect(recentWidget).toBeInViewport()
    await expect(page.locator("#dashboard-bar-switcher-dropdown [data-section-id='dashboard-recent']")).toHaveAttribute("hidden", "")
  })

  test("restores a completely blank dashboard, leaving other workspace preferences alone", async ({ page }) => {
    const editor = page.getByRole("dialog", { name: "Customize dashboard" })
    const otherKey = "meitheal:dashboard-layout:v1:another-actor"
    await page.evaluate(key => localStorage.setItem(key, "other-layout"), otherKey)
    await page.getByRole("button", { name: "Customize dashboard" }).click()
    await expect(editor).toBeVisible()
    for (const checkbox of await editor.getByRole("checkbox").all()) await checkbox.uncheck()
    await editor.getByRole("button", { name: "Save dashboard" }).click()
    await expect(page.getByRole("heading", { name: "Your dashboard is empty" })).toBeVisible()
    await expect(page.locator("#dashboard-bar-switcher-btn")).toBeDisabled()
    await expect(page.locator("#dashboard-bar-tabs")).toBeHidden()
    await expect(page.getByRole("link", { name: "Open Tasks" })).toHaveAttribute("href", "/tasks")
    await page.reload()
    await expect(page.getByRole("heading", { name: "Your dashboard is empty" })).toBeVisible()
    await expect(page.locator("#dashboard-empty .empty")).toHaveCSS("text-align", "center")

    await page.getByRole("button", { name: "Add widgets" }).click()
    await editor.getByRole("button", { name: "Restore defaults" }).click()
    await editor.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByRole("heading", { name: "Your dashboard is empty" })).toBeVisible()
    await page.getByRole("button", { name: "Add widgets" }).click()
    await editor.getByRole("button", { name: "Restore defaults" }).click()
    await editor.getByRole("button", { name: "Save dashboard" }).click()
    await expect(page.getByRole("button", { name: "Customize dashboard" })).toBeFocused()
    await expect(page.locator("#dashboard-bar-switcher-btn")).toBeEnabled()
    await expect(page.locator("#dashboard-capture")).toBeVisible()
    expect(await page.evaluate(key => localStorage.getItem(key), otherKey)).toBe("other-layout")
  })

  test("drags the editor order without changing the live layout until Save", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.getByRole("button", { name: "Customize dashboard" }).click()
    const editor = page.getByRole("dialog", { name: "Customize dashboard" })
    const list = editor.getByRole("list", { name: "Dashboard widgets" })
    const rows = list.getByRole("listitem")
    await expect(list).toHaveAttribute("data-dashboard-drag-ready", "")
    const grip = rows.first().locator("[data-dashboard-drag]")
    const source = await grip.boundingBox()
    const target = await rows.nth(1).locator("[data-dashboard-drag]").boundingBox()
    if (!source || !target) throw new Error("Drag handles are unavailable")
    const startX = source.x + source.width / 2
    const startY = source.y + source.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX, target.y + target.height, { steps: 20 })
    await page.mouse.up()
    await expect(rows.first()).toHaveAttribute("data-dashboard-editor-widget", momentum)
    const sections = page.locator("#dashboard-shell > [data-dashboard-section]")
    expect(await sections.evaluateAll(nodes => nodes.map(node => node.id))).toEqual(defaultOrder)
    await editor.getByRole("button", { name: "Save dashboard" }).click()
    expect(await sections.evaluateAll(nodes => nodes.map(node => node.id))).toEqual([momentum, overview, capture, focus, recent])
  })

  test("submits inline Quick Add when Recent is absent", async ({ page }) => {
    await page.route("**/api/tasks", async route => {
      if (route.request().method() !== "POST") return route.continue()
      await route.fulfill({ status: 201, json: { id: "dashboard-quick-test" } })
    })
    await page.route("**/?view=dashboard", async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace('id="task-list"', 'id="task-list-absent"')
      await route.fulfill({ response, body })
    })
    await page.reload()
    await expect(page.locator("#task-list")).toHaveCount(0)
    const request = page.waitForRequest(item => item.method() === "POST" && new URL(item.url()).pathname === "/api/tasks")
    await page.locator("#quick-title").fill("Feed the cat")
    await page.locator("#quick-add-form button").click()
    expect((await request).postDataJSON().title).toBe("Feed the cat")
  })

  test("rejects a stale editor draft after its workspace is frozen", async ({ page }) => {
    await page.getByRole("button", { name: "Customize dashboard" }).click()
    const editor = page.getByRole("dialog", { name: "Customize dashboard" })
    await editor.getByRole("checkbox", { name: "Show Recent" }).uncheck()
    await page.evaluate(() => { document.documentElement.dataset.workspaceFrozen = "true" })
    await editor.getByRole("button", { name: "Save dashboard" }).click()
    await expect(editor.getByRole("status")).toContainText("Your session changed")
    expect(await page.evaluate(key => localStorage.getItem(key), layoutKey)).toBeNull()
    await expect(page.locator("#dashboard-recent")).toBeVisible()
  })
})
