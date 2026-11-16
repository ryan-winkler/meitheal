import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

test("old task pins and visibility move to New task while view pins navigate and preserve filters", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 950 })
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("task-nav-seeded")) {
      sessionStorage.setItem("task-nav-seeded", "true")
      localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({
        mode: "custom",
        visible: { shopping_item: false },
        pinned: ["shopping_item"],
      }))
    }
  })
  await page.goto("/tasks?types=calendar_event#kanban")
  const createMenu = page.locator("#sidebar-task-types")
  const typeOptions = createMenu.locator("[data-task-creation-options]")
  const creationToggle = createMenu.getByRole("button", { name: "Task types", exact: true })
  const viewToggle = page.getByRole("button", { name: "Task views", exact: true })
  const viewOptions = page.locator("#tasks-nav-submenu")
  const overlay = page.locator("#new-task-overlay")

  await page.locator("#sidebar-rail-new-task").click()
  await expect(overlay.locator('[data-kind="standard_action"]')).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()

  const oldPin = createMenu.locator('[data-task-nav-pinned-item="shopping_item"]')
  await oldPin.getByRole("button", { name: "New shopping list", exact: true }).click()
  await expect(overlay.getByRole("button", { name: "Shopping", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()

  await creationToggle.click()
  await expect(typeOptions.getByRole("button", { name: "New shopping list", exact: true })).toBeHidden()
  await expect(typeOptions.getByRole("link", { name: "Choose visible types" })).toHaveAttribute("href", "/settings#navigation-settings")
  await typeOptions.getByRole("button", { name: "Pin new event", exact: true }).click()
  await expect(typeOptions.getByRole("button", { name: "Pin new event", exact: true })).toHaveAttribute("aria-pressed", "true")
  await typeOptions.getByRole("button", { name: "New event", exact: true }).click()
  await expect(overlay.getByRole("button", { name: "Event", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator("#new-task-title-input")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(creationToggle).toBeFocused()

  await viewToggle.click()
  await expect(viewOptions.getByRole("link")).toHaveText(["Calendar", "Kanban", "Timeline (Gantt)", "Table"])
  await viewOptions.getByRole("button", { name: "Pin Table to navigation" }).click()
  const pinnedTable = page.locator('[data-task-view-pinned-item="table"]')
  await page.keyboard.press("Escape")
  await expect(viewToggle).toBeFocused()
  await pinnedTable.getByRole("link", { name: "Table", exact: true }).click()
  await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("table")
  await expect.poll(() => new URL(page.url()).searchParams.get("types")).toBe("calendar_event")
  await expect(pinnedTable.getByRole("link", { name: "Table", exact: true })).toHaveAttribute("aria-current", "page")

  await page.reload()
  await expect(createMenu.locator('[data-task-nav-pinned-item="calendar_event"]')).toBeVisible()
  await expect(pinnedTable).toBeVisible()
  await pinnedTable.getByRole("button", { name: "Unpin Table from navigation" }).click()
  await expect(pinnedTable).toHaveCount(0)
  await expect(viewToggle).toBeFocused()

  await page.locator("#sidebar-edge-toggle").click()
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/)
  await viewToggle.focus()
  await page.keyboard.press("Enter")
  await expect(viewToggle).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Tab")
  await expect(viewOptions.getByRole("link", { name: "Calendar", exact: true })).toBeFocused()
  await expect(viewOptions).toHaveCSS("position", "fixed")
  await page.screenshot({ path: testInfo.outputPath("compact-task-views.png"), animations: "disabled" })
  await page.keyboard.press("Escape")
  await expect(viewToggle).toBeFocused()
  await expect(viewOptions).toBeHidden()

  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
  const compactTouchTarget = await viewToggle.boundingBox()
  expect(compactTouchTarget!.width).toBeGreaterThanOrEqual(44)
  expect(compactTouchTarget!.height).toBeGreaterThanOrEqual(44)
})

test("pinned types fit the Tasks toolbar in a narrow desktop navbar and stay available in the mobile drawer", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 800, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" }))
    localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({
      mode: "all",
      pinned: ["calendar_event", "shopping_item", "checklist", "standard"],
      pinnedViews: ["calendar", "timeline", "table", "kanban"],
    }))
  })
  await page.goto("/tasks#kanban")
  await expect(page.locator("html")).toHaveAttribute("data-appearance-navigation", "navbar")
  const toolbar = page.locator("#taskbar-task-types")
  const shortcut = toolbar.locator('[data-task-nav-pinned-item="calendar_event"] button')
  await shortcut.click()
  await expect(page.locator("#new-task-kind")).toHaveValue("calendar_event")
  await page.keyboard.press("Escape")
  await expect(page.locator("#new-task-overlay")).toBeHidden()
  await expect(toolbar.locator("[data-task-creation-pins]")).toBeVisible()
  await toolbar.getByRole("button", { name: "Task types", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(shortcut).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(toolbar.locator('[data-task-nav-pinned-item="shopping_item"] button')).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800)
  await toolbar.getByRole("button", { name: "Task types", exact: true }).click()
  await expect(toolbar.getByRole("button", { name: "Pin new checklist", exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("narrow-navbar-task-types.png"), animations: "disabled" })
  await page.keyboard.press("Escape")

  const more = page.locator("[data-nav-overflow=sidebar] [data-nav-overflow-more]")
  const taskViewToggle = page.getByRole("button", { name: "Task views", exact: true })
  if (!(await taskViewToggle.isVisible())) await more.locator("summary").click()
  await taskViewToggle.click()
  await expect(page.locator("#tasks-nav-submenu").getByRole("link", { name: "Timeline (Gantt)", exact: true })).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.locator("#tasks-nav-submenu").getByRole("link", { name: "Calendar", exact: true })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath("narrow-navbar-task-views.png"), animations: "disabled" })
  await page.keyboard.press("Escape")

  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator("#menu-toggle").click()
  const mobileSidebar = page.locator("#sidebar")
  const mobileTypeToggle = mobileSidebar.locator("#sidebar-task-types").getByRole("button", { name: "Task types", exact: true })
  await mobileTypeToggle.click()
  await expect(mobileTypeToggle).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Escape")
  await expect(mobileTypeToggle).toHaveAttribute("aria-expanded", "false")
  await expect(mobileSidebar).toHaveClass(/open/)
  await expect(mobileSidebar.locator('[data-task-nav-pinned-item="checklist"]')).toBeVisible()
  await expect(mobileSidebar.locator('[data-task-view-pinned-item="table"]')).toBeVisible()
})
