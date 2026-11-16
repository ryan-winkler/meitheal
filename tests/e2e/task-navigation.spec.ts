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

  // Standalone Astro navigation persists the sidebar, including the pinned anchor.
  const pinnedLink = pinnedTable.getByRole("link", { name: "Table", exact: true })
  await pinnedLink.evaluate(link => { link.dataset.persistedTaskView = "yes" })
  await page.locator('.sidebar .nav-link[data-page="dashboard"]').click()
  await expect(page).toHaveURL(url => url.pathname === "/")
  await expect(pinnedLink).toHaveAttribute("data-persisted-task-view", "yes")
  await expect.poll(() => pinnedLink.evaluate(link => new URL((link as HTMLAnchorElement).href).searchParams.get("types"))).toBeNull()
  await pinnedLink.click()
  await expect(page).toHaveURL(url => url.pathname === "/tasks" && url.searchParams.get("view") === "table")
  expect(new URL(page.url()).searchParams.get("types")).toBeNull()

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

for (const theme of ["light", "dark", "knight-rider", "auto", "custom"] as const) {
  test(`Shopping shortcuts keep their destination in ${theme}`, async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const previous = (await (await request.get("/api/settings")).json()).sidebar_config
    const shoppingPath = "/tasks?types=shopping_item"
    const calendarPath = "/tasks?view=calendar#calendar"
    const customCSS = ":root { --bg-primary: #161616; }"
    try {
      const saveSidebar = await request.put("/api/settings", {
        headers,
        data: { key: "sidebar_config", value: {
          order: ["dashboard", "tasks", "shopping-shortcut"],
          customItems: [{ id: "shopping-shortcut", label: "Shopping shortcut", href: shoppingPath, icon: "shopping-cart" }],
        } },
      })
      expect(saveSidebar.ok()).toBe(true)
      await page.setViewportSize({ width: 1440, height: 950 })
      await page.emulateMedia({ colorScheme: "light" })
      await page.addInitScript(({ theme, customCSS }) => {
        localStorage.setItem("meitheal-theme", theme)
        localStorage.setItem("meitheal-appearance", JSON.stringify({ sidebar: "expanded" }))
        localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({ mode: "all", pinned: ["shopping_item"] }))
        if (theme === "custom") localStorage.setItem("meitheal-custom-theme-css", customCSS)
      }, { theme, customCSS })

      await page.goto(calendarPath)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme === "custom" ? "dark" : theme)
      if (theme === "custom") await expect(page.locator("html")).toHaveCSS("--bg-primary", "#161616")
      await expect(page.locator("#calendar-shell")).toHaveAttribute("data-calendar-ready", "true")
      await expect.poll(() => page.evaluate(() => localStorage.getItem("meitheal:tasks-last-view"))).toBe("calendar")

      const navigations: string[] = []
      page.on("framenavigated", frame => {
        if (frame === page.mainFrame()) navigations.push(frame.url())
      })
      const createMenu = page.locator("#sidebar-task-types")
      const overlay = page.locator("#new-task-overlay")
      const pinnedShopping = createMenu.locator('[data-task-nav-pinned-item="shopping_item"]')
        .getByRole("button", { name: "New shopping list", exact: true })
      const menuShopping = createMenu.locator("[data-task-creation-options]")
        .getByRole("button", { name: "New shopping list", exact: true })
      await pinnedShopping.click()
      await expect(overlay.locator("#new-task-kind")).toHaveValue("shopping_item")
      await expect(overlay).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(overlay).toBeHidden()
      await createMenu.getByRole("button", { name: "Task types", exact: true }).click()
      await menuShopping.click()
      await expect(overlay.locator("#new-task-kind")).toHaveValue("shopping_item")
      await expect(overlay).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(overlay).toBeHidden()
      await expect(page).toHaveURL(calendarPath)
      expect(navigations).toEqual([])

      await page.goto("/")
      const shopping = page.locator("#sidebar").getByRole("link", { name: "Shopping shortcut", exact: true })
      await expect(shopping).toHaveAttribute("href", shoppingPath)
      await shopping.click()
      await expect(page).toHaveURL(shoppingPath + "#kanban")
      await expect(page.locator("#kanban-shell")).toBeVisible()
      await expect(page.locator("#calendar-shell")).toHaveCount(0)
      await expect(page.locator('.filter-toolbar [data-type="shopping_item"]')).toHaveAttribute("aria-pressed", "true")
      await expect(page.locator('.filter-toolbar [data-type="standard_action"]')).toHaveAttribute("aria-pressed", "false")
      expect(navigations.some(url => new URL(url).searchParams.get("view") === "calendar")).toBe(false)

      if (theme === "light") {
        await page.goBack()
        await expect(page).toHaveURL("/")
        await page.evaluate(() => localStorage.setItem("meitheal:tasks-last-view", "calendar"))
        await page.goForward()
        await expect(page).toHaveURL(shoppingPath + "#kanban")
        await expect(page.locator("#kanban-shell")).toBeVisible()

        await page.evaluate(() => localStorage.setItem("meitheal:tasks-last-view", "calendar"))
        await page.locator('#sidebar a[data-page="tasks"]').click()
        await expect(page).toHaveURL(calendarPath)
        await expect(page.locator("#calendar-shell")).toBeVisible()
      }
    } finally {
      await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })
    }
  })
}
