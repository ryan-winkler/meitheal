import { expect, test, type Locator, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Meitheal server")

test("a manual collapse beats pointer movement inside the hover rail", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-appearance", JSON.stringify({ sidebar: "hover" }))
  })
  await page.goto("/today")
  const edge = page.locator("#sidebar-edge-toggle")
  await expect(edge).toHaveAttribute("aria-expanded", "false")
  await edge.click()
  await expect(edge).toHaveAttribute("aria-expanded", "true")
  await edge.click()
  await expect(edge).toHaveAttribute("aria-expanded", "false")

  // Ctrl+B can close the sidebar while the pointer is still inside its compact bounds.
  await page.mouse.move(280, 140)
  await page.mouse.move(30, 140)
  await expect(edge).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Control+b")
  await page.mouse.move(32, 142, { steps: 4 })
  await expect(edge).toHaveAttribute("aria-expanded", "false")
  await page.setViewportSize({ width: 1430, height: 890 })
  await expect(edge).toHaveAttribute("aria-expanded", "false")
  await page.mouse.move(280, 140)
  await page.mouse.move(30, 140)
  await expect(edge).toHaveAttribute("aria-expanded", "true")
})

// Edit mode opens from the Keyboard utility menu and focuses the first move handle.
async function openSidebarEditor(page: Page, touch = false) {
  const trigger = page.locator("#sidebar #nav-utility-trigger")
  const item = page.getByRole("menuitem", { name: "Edit menu", exact: true })
  if (touch) {
    await trigger.tap()
    await item.tap()
  } else {
    await trigger.press("Enter")
    await item.press("Enter")
  }
  await expect(page.locator("#sidebar")).toHaveAttribute("data-sidebar-editing", "")
  return trigger
}

// Destination order, ignoring the optional Task view items that edit mode reveals.
function destinationOrder(sidebar: Locator) {
  return sidebar.locator("[data-sidebar-group]").evaluateAll(items =>
    items.map(item => item.getAttribute("data-sidebar-group")).filter(group => !group?.startsWith("view-") && group !== "system-pinned"))
}

test("drag and keyboard reorder keep the Boards subtree intact", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.goto("/today")
  const sidebar = page.locator("#sidebar")
  const order = () => destinationOrder(sidebar)
  const trigger = await openSidebarEditor(page)
  await expect(sidebar.getByRole("button", { name: "Move Dashboard", exact: true })).toBeFocused()

  const groupRoot = sidebar.locator('[data-sidebar-group="boards"]')
  await expect(groupRoot.locator('[data-named-board-shortcut="household"]')).toHaveCount(1)
  await expect(sidebar.locator('[data-sidebar-group="areas"]')).toHaveCount(0)
  const upcoming = sidebar.getByRole("button", { name: "Move Upcoming", exact: true })
  const dashboard = sidebar.getByRole("button", { name: "Move Dashboard", exact: true })
  await upcoming.dragTo(dashboard, { targetPosition: { x: 12, y: 4 } })
  await expect.poll(order).toEqual(["upcoming", "dashboard", "today", "tasks", "progress", "planning", "boards", "settings"])
  const tasks = sidebar.getByRole("button", { name: "Move Tasks", exact: true })
  for (let move = 0; move < 3; move++) await tasks.press("ArrowUp")
  await expect.poll(order).toEqual(["tasks", "upcoming", "dashboard", "today", "progress", "planning", "boards", "settings"])
  await expect(tasks).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath("reordered-desktop.png") })
  await tasks.press("Escape")
  await expect(sidebar).not.toHaveAttribute("data-sidebar-editing", "")
  await expect(trigger).toBeFocused()
  await expect(groupRoot.locator('[data-named-board-shortcut="household"]')).toHaveCount(1)
  await page.reload()
  await expect.poll(order).toEqual(["tasks", "upcoming", "dashboard", "today", "progress", "planning", "boards", "settings"])
  await sidebar.locator('[data-page="planning"]').click()
  await expect(page).toHaveURL(/\/planning/)
  await expect.poll(order).toEqual(["tasks", "upcoming", "dashboard", "today", "progress", "planning", "boards", "settings"])
  expect(errors).toEqual([])
})

test("the mobile drawer reorders via touch and keeps its close control", async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 320, height: 680 }, hasTouch: true, isMobile: true })
  try {
    const page = await context.newPage()
    await page.goto(new URL("/today", baseURL).href)
    const sidebar = page.locator("#sidebar")
    const menu = page.locator("#menu-toggle")
    await menu.tap()
    await openSidebarEditor(page, true)
    const up = sidebar.getByRole("button", { name: "Move Upcoming up", exact: true })
    const target = await up.boundingBox()
    expect(target?.width).toBeGreaterThanOrEqual(44)
    expect(target?.height).toBeGreaterThanOrEqual(44)
    await up.tap()
    await expect(sidebar.locator("[data-sidebar-group]").nth(1)).toHaveAttribute("data-sidebar-group", "upcoming")
    await expect(up).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await page.screenshot({ path: testInfo.outputPath("reordered-mobile.png") })
    await sidebar.getByRole("button", { name: "Close sidebar" }).tap()
    await expect(menu).toHaveAttribute("aria-expanded", "false")
    await menu.tap()
    await expect(sidebar.locator("#nav-utility-trigger")).toBeVisible()
    await expect(sidebar.locator("[data-sidebar-group]").nth(1)).toHaveAttribute("data-sidebar-group", "upcoming")
  } finally {
    await context.close()
  }
})

test("a drop keeps its destination when a descendant clears the visual marker", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/today")
  const sidebar = page.locator("#sidebar")
  await openSidebarEditor(page)
  const groups = sidebar.getByRole("button", { name: "Move Boards", exact: true })
  const dashboard = sidebar.getByRole("button", { name: "Move Dashboard", exact: true })
  const target = await dashboard.boundingBox()
  expect(target).not.toBeNull()
  const transfer = await page.evaluateHandle(() => new DataTransfer())
  const position = { clientX: target!.x + 12, clientY: target!.y + 4, dataTransfer: transfer }
  await groups.dispatchEvent("dragstart", position)
  await dashboard.dispatchEvent("dragover", position)
  await expect(sidebar.locator('[data-sidebar-group="dashboard"]')).toHaveAttribute("data-sidebar-drop", "before")
  await dashboard.dispatchEvent("dragleave", { ...position, relatedTarget: null })
  await expect(sidebar.locator("[data-sidebar-drop]")).toHaveCount(0)
  await dashboard.dispatchEvent("drop", position)
  await expect(sidebar.locator("[data-sidebar-group]").first()).toHaveAttribute("data-sidebar-group", "boards")
})
