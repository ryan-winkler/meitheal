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

  await page.goto("/tasks?types=shopping_item#kanban")
  await viewToggle.press("Enter")
  await viewOptions.getByRole("button", { name: "Pin Table to navigation" }).focus()
  await page.keyboard.press("Tab")
  await expect(viewOptions).toBeHidden()
  await expect(viewToggle).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(url => url.searchParams.get("types") === "shopping_item")
  await expect(page.locator('.filter-toolbar [data-type="shopping_item"]')).toHaveAttribute("aria-pressed", "true")

  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
  const compactTouchTarget = await viewToggle.boundingBox()
  expect(compactTouchTarget!.width).toBeGreaterThanOrEqual(44)
  expect(compactTouchTarget!.height).toBeGreaterThanOrEqual(44)
})

test("pinned types fit narrow desktop top navigation and stay available in the mobile drawer", async ({ page }, testInfo) => {
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
  const sidebar = page.locator("#sidebar")
  const sidebarMenu = sidebar.locator("#sidebar-task-types")
  const sidebarTypeToggle = sidebarMenu.getByRole("button", { name: "Task types", exact: true })
  const overlay = page.locator("#new-task-overlay")
  const toolbar = page.locator("#taskbar-task-types")
  const toolbarTypeToggle = toolbar.locator("[data-task-creation-toggle]")
  const shortcut = toolbar.locator('[data-task-nav-pinned-item="calendar_event"] button')
  await expect(sidebarMenu).toBeHidden()
  await shortcut.click()
  await expect(page.locator("#new-task-kind")).toHaveValue("calendar_event")
  await page.keyboard.press("Escape")
  await expect(page.locator("#new-task-overlay")).toBeHidden()
  await expect(toolbar.locator("[data-task-creation-pins]")).toBeVisible()
  await toolbarTypeToggle.focus()
  await page.keyboard.press("Tab")
  await expect(shortcut).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(toolbar.locator('[data-task-nav-pinned-item="shopping_item"] button')).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800)
  await toolbarTypeToggle.click()
  await expect(toolbar.getByRole("button", { name: "Pin new checklist", exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("narrow-navbar-task-types.png"), animations: "disabled" })
  await page.keyboard.press("Escape")

  const more = page.locator("[data-nav-overflow=sidebar] [data-nav-overflow-more]")
  const taskViewToggle = page.getByRole("button", { name: "Task views", exact: true })
  await expect(more.locator("#tasks-submenu-toggle")).toBeAttached()
  await more.locator("summary").click()
  await taskViewToggle.click()
  await expect(page.locator("#tasks-nav-submenu").getByRole("link", { name: "Timeline (Gantt)", exact: true })).toBeVisible()
  await page.keyboard.press("Tab")
  await expect(page.locator("#tasks-nav-submenu").getByRole("link", { name: "Calendar", exact: true })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath("narrow-navbar-task-views.png"), animations: "disabled" })
  const tablePin = page.locator("#tasks-nav-submenu").getByRole("button", { name: "Pin Table to navigation" })
  for (const pressed of ["false", "true"]) {
    await tablePin.press("Enter")
    await expect(tablePin).toHaveAttribute("aria-pressed", pressed)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(tablePin).toBeFocused()
    await expect(taskViewToggle).toHaveAttribute("aria-expanded", "true")
  }
  await page.keyboard.press("Escape")

  await sidebarMenu.evaluate(menu => { menu.dataset.persistedTaskTypes = "yes" })
  const today = sidebar.locator('a[data-page="today"]')
  if (!(await today.isVisible())) await more.locator("summary").click()
  await today.click()
  await expect(page).toHaveURL(url => url.pathname === "/today")
  await expect(sidebarMenu).toHaveAttribute("data-persisted-task-types", "yes")
  await expect(overlay).toHaveAttribute("data-new-task-controller", "ready")
  await sidebar.locator("#sidebar-rail-new-task").click()
  await expect(overlay.locator("#new-task-kind")).toHaveValue("standard_action")
  await expect(overlay).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()
  await expect(page.getByRole("button", { name: "Task types", exact: true })).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(800)
  const sidebarPins = sidebarMenu.getByRole("list", { name: "Pinned task types" })
  await expect.poll(() => sidebarPins.evaluate(pins => pins.scrollWidth - pins.clientWidth)).toBeLessThanOrEqual(1)
  await sidebarTypeToggle.focus()
  await page.keyboard.press("Tab")
  await expect(sidebarMenu.locator('[data-task-nav-pinned-item="calendar_event"] button').first()).toBeFocused()
  await page.keyboard.press("Tab")
  const pinnedShopping = sidebarPins.getByRole("button", { name: "New shopping list", exact: true })
  await expect(pinnedShopping).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(overlay.locator("#new-task-kind")).toHaveValue("shopping_item")
  await expect(overlay).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()
  await expect(page).toHaveURL(url => url.pathname === "/today")

  await sidebarTypeToggle.click()
  await expect(sidebarMenu.getByRole("button", { name: "Pin new checklist", exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("narrow-navbar-shared-task-types.png"), animations: "disabled" })
  await sidebarMenu.getByRole("link", { name: "Choose visible types" }).click()
  await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "#navigation-settings")
  await expect(sidebarMenu).toHaveAttribute("data-persisted-task-types", "yes")
  await expect(overlay).toHaveAttribute("data-new-task-controller", "ready")
  await expect(sidebarTypeToggle).toHaveAttribute("aria-expanded", "false")
  await pinnedShopping.click()
  await expect(overlay.locator("#new-task-kind")).toHaveValue("shopping_item")
  await expect(overlay).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()
  await expect(page).toHaveURL(url => url.pathname === "/settings")

  const tasks = sidebar.locator('a[data-page="tasks"]')
  if (!(await tasks.isVisible())) await more.locator("summary").click()
  await tasks.click()
  await expect(page).toHaveURL(url => url.pathname === "/tasks")
  await expect(sidebarMenu).toBeHidden()
  await expect(overlay).toHaveAttribute("data-new-task-controller", "ready")
  await toolbarTypeToggle.click()
  await expect(toolbarTypeToggle).toHaveAttribute("aria-expanded", "true")

  await page.goto("/tasks?types=shopping_item#kanban")
  await toolbarTypeToggle.press("Enter")
  await toolbar.getByRole("link", { name: "Choose visible types", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(toolbarTypeToggle).toHaveAttribute("aria-expanded", "false")
  await expect(shortcut).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(url => url.searchParams.get("types") === "shopping_item")
  await expect(page.locator('.filter-toolbar [data-type="shopping_item"]')).toHaveAttribute("aria-pressed", "true")
  await toolbarTypeToggle.press("Enter")

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(toolbarTypeToggle).toHaveAttribute("aria-expanded", "false")
  await page.locator("#menu-toggle").click()
  const mobileSidebar = page.locator("#sidebar")
  const mobileTypeToggle = mobileSidebar.locator("#sidebar-task-types").getByRole("button", { name: "Task types", exact: true })
  await mobileTypeToggle.click()
  await expect(mobileTypeToggle).toHaveAttribute("aria-expanded", "true")
  const firstPin = sidebarPins.getByRole("button", { name: "New event", exact: true })
  await mobileSidebar.getByRole("link", { name: "Choose visible types", exact: true }).focus()
  await page.keyboard.press("Tab")
  await expect(mobileTypeToggle).toHaveAttribute("aria-expanded", "false")
  await expect(firstPin).toBeFocused()
  expect(await firstPin.evaluate(button => {
    const rect = button.getBoundingClientRect()
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
  })).toBe(true)
  await mobileTypeToggle.click()
  await page.keyboard.press("Escape")
  await expect(mobileTypeToggle).toHaveAttribute("aria-expanded", "false")
  await expect(mobileSidebar).toHaveClass(/open/)
  await expect(mobileSidebar.locator('[data-task-view-pinned-item="table"]')).toBeVisible()
  const checklist = sidebarPins.getByRole("button", { name: "New checklist", exact: true })
  await checklist.click()
  await expect(overlay.locator("#new-task-kind")).toHaveValue("checklist")
  await expect(overlay).toBeVisible()
  const title = overlay.locator("#new-task-title-input")
  await title.click()
  await expect(title).toBeFocused()
  await page.keyboard.type("Pack supplies")
  await expect(title).toHaveValue("Pack supplies")
  await page.keyboard.press("Escape")
  await expect(overlay).toBeHidden()
  await expect(checklist).toBeFocused()
  await expect(mobileSidebar).toHaveClass(/open/)
  await page.keyboard.press("Escape")
  await expect(mobileSidebar).not.toHaveClass(/open/)
  await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator("#menu-toggle")).toBeFocused()

  await page.setViewportSize({ width: 320, height: 280 })
  const touch = await page.context().newCDPSession(page)
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  await expect.poll(() => page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
  await page.locator("#menu-toggle").click()
  await mobileSidebar.locator("#tasks-submenu-toggle").click()
  await mobileSidebar.locator("#tasks-nav-submenu").getByRole("link", { name: "Calendar", exact: true }).scrollIntoViewIfNeeded()
  await expect.poll(() => mobileSidebar.locator(".sidebar-main").evaluate(panel => panel.scrollTop)).toBeGreaterThan(0)
  const close = mobileSidebar.getByRole("button", { name: "Close sidebar", exact: true })
  await expect(close).toBeInViewport()
  await close.click()
  await expect(page.locator("#menu-toggle")).toBeFocused()
})

test("short landscape sidebar keeps pinned types and view menus reachable", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 280 })
  const touch = await page.context().newCDPSession(page)
  await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-theme", "knight-rider")
    localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "sidebar", sidebar: "folded" }))
    localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({
      pinned: ["calendar_event", "shopping_item", "checklist", "standard"],
    }))
  })
  await page.goto("/tasks")
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/)
  const sidebar = page.locator("#sidebar")
  const typeToggle = sidebar.getByRole("button", { name: "Task types", exact: true })
  await typeToggle.click()
  const settings = sidebar.getByRole("link", { name: "Choose visible types" })
  await expect(settings).toBeVisible()
  await page.keyboard.press("Escape")
  const pins = sidebar.getByRole("list", { name: "Pinned task types" })
  await pins.locator("li").last().getByRole("button").first().scrollIntoViewIfNeeded()
  await expect.poll(() => pins.evaluate(list => list.scrollTop)).toBeGreaterThan(0)

  await sidebar.getByRole("button", { name: "Task views", exact: true }).click()
  const calendar = sidebar.locator("#tasks-nav-submenu").getByRole("link", { name: "Calendar", exact: true })
  await calendar.click()
  await expect(page).toHaveURL(url => url.searchParams.get("view") === "calendar")
})

test("docked task Details retains Today as the active navigation and syncs a custom status", async ({ page, request, baseURL }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({ pinnedViews: ["kanban"] })))
  const headers = { origin: new URL(baseURL!).origin }
  const title = "Docked Today navigation fixture"
  const due_date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", dateStyle: "short" }).format(new Date())
  const created = await request.post("/api/tasks", { headers, data: { title, due_date } })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json()
  let laneId: string | undefined
  try {
    const lane = await request.post("/api/lanes", { headers, data: { label: "Waiting for review", key: "waiting_review" } })
    expect(lane.status(), await lane.text()).toBe(201)
    laneId = (await lane.json()).id
    await page.goto("/today#today-work")
    await page.locator("#page-shell").getByText(title, { exact: true }).first().click()
    await expect(page.locator("body")).toHaveClass(/has-docked-inspector/)
    await expect(page).toHaveURL(/\/tickets\//)
    const sidebar = page.locator("#sidebar")
    await sidebar.getByRole("button", { name: "Task views", exact: true }).click()
    await expect(sidebar.locator('a[data-page="today"]')).toHaveAttribute("aria-current", "page")
    await expect(sidebar.locator('[data-task-view-pinned-item="kanban"] a')).not.toHaveAttribute("aria-current", "page")
    await page.keyboard.press("Escape")
    const status = page.locator("#td-status")
    await status.selectOption({ label: "Waiting for review" })
    const badge = page.locator(`.tli[data-id="${id}"] [data-badge-status]`).first()
    await expect(badge).toHaveText("waiting_review")
    await page.goto("/today#today-work")
    await expect(badge).toHaveText("waiting_review")
  } finally {
    await request.delete(`/api/tasks/${id}`, { headers })
    if (laneId) await request.delete(`/api/lanes/${laneId}`, { headers })
  }
})

test("mobile task type settings dismiss the sidebar and focus the destination", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/today")

  const toggle = page.locator("#menu-toggle")
  await toggle.click()
  const sidebar = page.locator("#sidebar")
  const menu = sidebar.locator("#sidebar-task-types")
  await menu.getByRole("button", { name: "Task types", exact: true }).click()
  await menu.getByRole("link", { name: "Choose visible types" }).click()

  await expect(page).toHaveURL(/\/settings#navigation-settings$/)
  await expect(sidebar).not.toHaveClass(/open/)
  await expect(page.locator("body")).not.toHaveClass(/sidebar-open/)
  const destination = page.locator("#navigation-settings h2[data-settings-destination]")
  await expect(destination).toBeFocused()
  await expect(destination).toBeInViewport()
})

test("selected menu pins remain visible with a black personal accent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 950 })
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-theme", "knight-rider")
    localStorage.setItem("meitheal-accent-color", "#000000")
    localStorage.setItem("meitheal_sidebar_collapsed", "false")
  })
  await page.goto("/today")
  const sidebar = page.locator("#sidebar")
  const creation = sidebar.getByRole("button", { name: "Task types", exact: true })
  const views = sidebar.getByRole("button", { name: "Task views", exact: true })
  for (const [toggle, name] of [[creation, "Pin new event"], [views, "Pin Table to navigation"]] as const) {
    await toggle.click()
    const pin = sidebar.getByRole("button", { name, exact: true })
    await pin.click()
    await expect(pin).toHaveAttribute("aria-pressed", "true")
    await expect(pin).toHaveCSS("color", "rgb(230, 230, 230)")
    await expect(pin).toHaveCSS("border-top-color", "rgb(230, 230, 230)")
    await page.keyboard.press("Escape")
  }

  await page.goto("/tasks?view=calendar#calendar")
  await page.keyboard.press("Tab")
  const header = page.getByRole("banner")
  for (const action of [header.getByRole("button", { name: "New Task", exact: true }),
    header.getByRole("button", { name: "Search Meitheal…", exact: true })]) {
    await action.focus()
    await expect(action).toHaveCSS("outline-style", "solid")
    await expect(action).toHaveCSS("outline-color", "rgb(166, 192, 249)")
  }
})

test("pinned Table and Timeline keep the current workspace filters", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("task-entry-seeded")) return
    sessionStorage.setItem("task-entry-seeded", "true")
    localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({ pinnedViews: ["table", "timeline"] }))
    localStorage.setItem("meitheal-task-view-filters", JSON.stringify({ search: "previous workspace search" }))
  })
  await page.setViewportSize({ width: 1440, height: 950 })
  for (const from of ["/", "/tasks#kanban"]) {
    for (const [view, title] of [["timeline", "Timeline (Gantt)"], ["table", "Table"]] as const) {
      await page.goto(from)
      const link = page.locator(`#sidebar [data-task-view-pinned-item="${view}"]`).getByRole("link", { name: title, exact: true })
      await link.click()
      await expect(page).toHaveURL(url => url.pathname === "/tasks" && url.searchParams.get("view") === view)
      await expect(page.locator(view === "table" ? "#table-shell" : "#tasks-view-timeline")
        .getByRole("textbox", { name: "Filter by text" })).toHaveValue("")
    }
  }
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
      const sidebar = page.locator("#sidebar")
      const shopping = sidebar.getByRole("link", { name: "Shopping shortcut", exact: true })
      const tasks = sidebar.locator('a[data-page="tasks"]')
      await expect(tasks).toHaveAttribute("aria-current", "page")
      await expect(shopping).not.toHaveAttribute("aria-current", "page")
      await expect(shopping).not.toHaveClass(/active/)
      const createMenu = sidebar.locator("#sidebar-task-types")
      const overlay = page.locator("#new-task-overlay")
      const pinnedShopping = createMenu.locator('[data-task-nav-pinned-item="shopping_item"]')
        .getByRole("button", { name: "New shopping list", exact: true })
      const menuShopping = createMenu.locator("[data-task-creation-options]")
        .getByRole("button", { name: "New shopping list", exact: true })
      await pinnedShopping.click()
      await expect(overlay.locator("#new-task-kind")).toHaveValue("shopping_item")
      await expect(overlay).toBeVisible()
      if (theme === "knight-rider") {
        await expect(overlay.locator("#new-task-title-input")).toHaveCSS("border-top-color", "rgb(136, 136, 140)")
        await expect(overlay.locator(".nt-kind-pill[aria-pressed=false]").first()).toHaveCSS("border-top-color", "rgb(136, 136, 140)")
      }
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
      await expect(shopping).toHaveAttribute("href", shoppingPath)
      await shopping.click()
      await expect(page).toHaveURL(shoppingPath + "#kanban")
      await expect(page.locator("#kanban-shell")).toBeVisible()
      await expect(page.locator("#calendar-shell")).toHaveCount(0)
      await expect(page.locator('.filter-toolbar [data-type="shopping_item"]')).toHaveAttribute("aria-pressed", "true")
      await expect(page.locator('.filter-toolbar [data-type="standard_action"]')).toHaveAttribute("aria-pressed", "false")
      await expect(shopping).toHaveAttribute("aria-current", "page")
      await expect(shopping).toHaveClass(/active/)
      await expect(tasks).not.toHaveAttribute("aria-current", "page")
      expect(navigations.some(url => new URL(url).searchParams.get("view") === "calendar")).toBe(false)

      if (theme === "light") {
        await page.goBack()
        await expect(page).toHaveURL("/")
        await page.evaluate(() => localStorage.setItem("meitheal:tasks-last-view", "calendar"))
        await page.goForward()
        await expect(page).toHaveURL(shoppingPath + "#kanban")
        await expect(page.locator("#kanban-shell")).toBeVisible()

        await page.evaluate(() => localStorage.setItem("meitheal:tasks-last-view", "calendar"))
        await tasks.click()
        await expect(page).toHaveURL(calendarPath)
        await expect(page.locator("#calendar-shell")).toBeVisible()
        await expect(tasks).toHaveAttribute("aria-current", "page")
        await expect(shopping).not.toHaveAttribute("aria-current", "page")

        await page.goto("/tasks#kanban")
        await expect(tasks).toHaveAttribute("aria-current", "page")
        await expect(shopping).not.toHaveClass(/active/)
        await shopping.click()
        await expect(shopping).toHaveAttribute("aria-current", "page")
        const shoppingFilter = page.locator('.filter-toolbar [data-type="shopping_item"]')
        await expect(shoppingFilter).toHaveAttribute("aria-pressed", "true")
        await shoppingFilter.click()
        await expect(page).toHaveURL(url => !url.searchParams.has("types"))
        await expect(tasks).toHaveAttribute("aria-current", "page")
        await expect(shopping).not.toHaveAttribute("aria-current", "page")
      }
    } finally {
      await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })
    }
  })
}

test("Shopping links identify their own Area and follow applied Board filters", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const previous = (await (await request.get("/api/settings")).json()).sidebar_config
  const names = ["Kitchen supplies", "Workshop supplies"] as const
  const areas: string[] = []
  const paths = ["/tasks?types=shopping_item"]
  try {
    for (const name of names) {
      const response = await request.post("/api/areas", { headers, data: { name } })
      expect(response.status()).toBe(201)
      const { id } = await response.json()
      areas.push(id)
      paths.push("/tasks?" + new URLSearchParams({ types: "shopping_item", area: id }))
    }
    const calendarParams = new URLSearchParams({
      view: "calendar", types: "shopping_item", area_id: areas[0]!, area: areas[1]!,
    })
    const groceryParams = new URLSearchParams({ types: "shopping_item", area: areas[0]!, label: "groceries" })
    const ruleParams = new URLSearchParams(groceryParams)
    ruleParams.set("advancedFilter", JSON.stringify({
      id: "saved-shopping-group", logic: "AND",
      conditions: [{ id: "saved-grocery-rule", field: "title", operator: "contains", value: "grocery" }],
    }))
    const ruleWithView = (view: string) => "/tasks?" + new URLSearchParams({ ...Object.fromEntries(ruleParams), view })
    const invalidRule = new URLSearchParams({ types: "shopping_item", area: areas[0]!, advancedFilter: "{invalid" })
    const completedCalendar = new URLSearchParams({ ...Object.fromEntries(calendarParams), status: "done" })
    paths.push("/tasks?" + calendarParams + "#calendar", "/tasks?" + groceryParams, "/tasks?" + ruleParams,
      ruleWithView("calendar"), ruleWithView("table"), "/tasks?" + invalidRule, "/tasks?" + completedCalendar)
    const shortcuts = ["All Shopping", ...names, "Kitchen shopping calendar", "Grocery shopping", "Grocery rule",
      "Grocery Calendar rule", "Grocery Table rule", "Invalid Grocery rule", "Completed shopping calendar"].map((label, index) => ({
      id: `shopping-route-${index}`,
      label,
      href: paths[index],
      icon: "shopping-cart",
    }))
    const save = await request.put("/api/settings", {
      headers,
      data: { key: "sidebar_config", value: {
        order: ["dashboard", "tasks", ...shortcuts.map(shortcut => shortcut.id)],
        customItems: shortcuts,
      } },
    })
    expect(save.ok()).toBe(true)
    await page.goto("/")
    const sidebar = page.locator("#sidebar")
    const current = sidebar.locator('[aria-current="page"][data-page^="shopping-route-"]')
    const areaTrigger = page.locator("#area-selector-trigger")
    await sidebar.getByRole("link", { name: names[0], exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("area") === areas[0])
    await expect(current).toHaveText(names[0])
    await areaTrigger.click()
    await page.locator(`#area-selector-dropdown [data-area-id="${areas[1]}"]`).click()
    await expect(page).toHaveURL(url => url.searchParams.get("area") === areas[1])
    await expect(current).toHaveText(names[1])
    await areaTrigger.click()
    await page.locator('#area-selector-dropdown [data-area-id=""]').click()
    await expect(page).toHaveURL(url => url.searchParams.get("area") === "")
    await expect(current).toHaveText("All Shopping")

    await sidebar.getByRole("link", { name: "Kitchen shopping calendar", exact: true }).click()
    await expect(page.locator("#calendar-shell")).toBeVisible()
    await expect(current).toHaveText("Kitchen shopping calendar")
    await expect(page).toHaveURL(url => url.searchParams.get("area_id") === areas[0])
    await sidebar.getByRole("button", { name: "Task views", exact: true }).click()
    await sidebar.locator("#tasks-nav-submenu").getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page).toHaveURL(url => url.hash === "#kanban" && url.searchParams.get("area") === areas[0])
    await expect(areaTrigger).toContainText(names[0])

    await sidebar.getByRole("link", { name: "Kitchen shopping calendar", exact: true }).click()
    const calendar = page.locator("#calendar-shell")
    await expect(calendar).toHaveAttribute("data-calendar-ready", "true")
    const calendarFilters = calendar.locator(".filter-toolbar")
    await expect(calendarFilters).toHaveAttribute("data-initialized", "true")
    await calendarFilters.getByRole("textbox", { name: "Filter by text" }).fill("pan")
    await expect(page).toHaveURL(url => url.searchParams.get("area") === areas[0] && url.searchParams.get("search") === "pan")
    await expect(current).toHaveText("Kitchen shopping calendar")

    await sidebar.getByRole("link", { name: "Completed shopping calendar", exact: true }).click()
    await expect(current).toHaveText("Completed shopping calendar")
    await expect(calendarFilters).toHaveAttribute("data-initialized", "true")
    await calendarFilters.getByRole("textbox", { name: "Filter by text" }).fill("groceries")
    await expect(page).toHaveURL(url => url.searchParams.get("status") === "complete" && url.searchParams.get("search") === "groceries")
    await expect(current).toHaveText("Completed shopping calendar")

    await sidebar.getByRole("link", { name: "Grocery shopping", exact: true }).click()
    await expect(current).toHaveText("Grocery shopping")
    const board = page.locator("#kanban-shell")
    await expect(board).toHaveAttribute("data-kanban-booted", "true")
    await page.getByRole("textbox", { name: "Filter by text" }).fill("pan")
    await expect(page).toHaveURL(url => url.searchParams.get("labels") === "groceries" && url.searchParams.get("search") === "pan")
    await expect(current).toHaveText("Grocery shopping")

    await sidebar.getByRole("link", { name: "Grocery rule", exact: true }).click()
    await expect(current).toHaveText("Grocery rule")
    await expect(board).toHaveAttribute("data-kanban-booted", "true")
    await page.getByRole("textbox", { name: "Filter by text" }).fill("bread")
    await expect(page).toHaveURL(url => url.searchParams.get("search") === "bread" &&
      decodeURIComponent(url.searchParams.get("advancedFilter") ?? "").includes('"value":"grocery"'))
    await expect(current).toHaveText("Grocery rule")

    for (const name of ["Grocery Calendar rule", "Grocery Table rule"]) {
      await sidebar.getByRole("link", { name, exact: true }).click()
      await expect(current).toHaveText(name)
      const filters = page.getByRole("toolbar", { name: "Filter tasks" })
      await filters.getByRole("button", { name: "Toggle filter builder" }).click()
      await filters.getByRole("button", { name: "Apply Rules" }).press("Enter")
      await expect(page).toHaveURL(url => {
        const rule = url.searchParams.get("advancedFilter")
        return Boolean(rule && JSON.parse(decodeURIComponent(rule)).conditions[0]?.logic === "AND")
      })
      await expect(current).toHaveText(name)
      const duplicateRule = new URL(page.url())
      const savedRule = duplicateRule.searchParams.get("advancedFilter")!
      duplicateRule.searchParams.set("advancedFilter", "{invalid")
      duplicateRule.searchParams.append("advancedFilter", savedRule)
      await page.goto(duplicateRule.href)
      await expect(current).toHaveText(name)
      if (name === "Grocery Calendar rule") {
        await filters.getByRole("combobox", { name: "Filter by priority" }).selectOption("3")
        await expect(page).toHaveURL(url => url.searchParams.get("priority") === "3" &&
          url.searchParams.getAll("advancedFilter").length === 1 &&
          decodeURIComponent(url.searchParams.get("advancedFilter") ?? "").includes('"value":"grocery"'))
        await expect(current).toHaveText(name)
      }
    }

    await sidebar.getByRole("link", { name: "Invalid Grocery rule", exact: true }).click()
    await expect(current).toHaveText(names[0]!)

    const boardParams = new URLSearchParams({ types: "shopping_item", area: areas[0]!, area_id: areas[1]! })
    await page.goto("/tasks?" + boardParams + "#kanban")
    await expect(page.locator("#area-selector-trigger")).toContainText(names[0]!)
    const views = page.getByRole("navigation", { name: "Task views" })
    await views.getByRole("link", { name: "Calendar", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("area") === areas[0] && !url.searchParams.has("area_id"))
    await expect(page.locator("#area-selector-trigger")).toContainText(names[0]!)
  } finally {
    await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })
    for (const id of areas) await request.delete(`/api/areas/${id}`, { headers })
  }
})

test("legacy Shopping type filters survive view switches and respect Table search spacing", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const previous = (await (await request.get("/api/settings")).json()).sidebar_config
  const suffix = crypto.randomUUID()
  const titles = [`Pantry ${suffix}`, `Frying pan ${suffix}`]
  const due = "2031-07-27"
  const ids: string[] = []
  try {
    for (const [index, title] of titles.entries()) {
      const created = await request.post("/api/tasks", { headers, data: {
        title, status: index === 0 ? "active" : "pending", task_kind: "shopping_item", task_type: index === 0 ? "story" : "epic",
        start_date: `2031-07-${25 + index}`, due_date: due,
      } })
      expect(created.ok(), await created.text()).toBe(true)
      ids.push((await created.json()).id)
    }
    const query = { view: "table", area: "", types: '["shopping_item"]', year: "2031", month: "6" }
    const labels = ["All pantry search", "Word pantry search"] as const
    const shortcuts: Array<{ id: string; label: string; href: string; icon: string }> = labels.map((label, index) => ({
      id: `legacy-shopping-${index}`,
      label,
      href: "/tasks?" + new URLSearchParams({ ...query, search: (index ? " " : "") + "pan" }) + "#table",
      icon: "shopping-cart",
    }))
    for (const taskType of ["story", "epic"]) {
      shortcuts.push({
        id: `legacy-task-type-${taskType}`,
        label: taskType === "story" ? "Stories" : "Epics",
        href: `/table?area=&task_type=${taskType}`,
        icon: "checkbox",
      })
    }
    const nonStandardKinds = "shopping_item,checklist,routine_instance,calendar_event,quick_capture"
    shortcuts.push({
      id: "legacy-task-type-epic-kinds",
      label: "Epics by kind",
      href: `/tasks?view=table&area=&task_type=epic&types=${nonStandardKinds}#table`,
      icon: "checkbox",
    }, {
      id: "legacy-calendar-stories",
      label: "Calendar stories",
      href: "/calendar?area=&task_type=story&year=2031&month=6",
      icon: "calendar-event",
    })
    const scopedShopping = new URLSearchParams({ ...query, search: suffix })
    for (const active of [false, true]) {
      shortcuts.push({
        id: active ? "active-shopping" : "all-shopping",
        label: active ? "Active shopping" : "All shopping by name",
        href: "/tasks?" + scopedShopping + (active ? "&status=active" : "") + "#table",
        icon: "shopping-cart",
      })
    }
    const calendarShopping = new URLSearchParams({ ...query, view: "calendar", search: suffix, promoted: "1" })
    shortcuts.push({
      id: "promoted-shopping",
      label: "Promoted shopping",
      href: "/tasks?" + calendarShopping + "#calendar",
      icon: "shopping-cart",
    })
    const save = await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: {
      order: ["tasks", ...shortcuts.map(shortcut => shortcut.id)], customItems: shortcuts,
    } } })
    expect(save.ok()).toBe(true)
    await page.goto(shortcuts[1]!.href)
    await expect(page.locator('#sidebar [data-page="legacy-shopping-1"]')).toHaveAttribute("aria-current", "page")
    const table = page.locator("#table-shell")
    await expect(table.getByText(titles[1]!, { exact: true })).toBeVisible()
    await expect(table.getByText(titles[0]!, { exact: true })).toHaveCount(0)
    await page.getByRole("link", { name: labels[0], exact: true }).click()
    await expect(page.locator('#sidebar [data-page="legacy-shopping-0"]')).toHaveAttribute("aria-current", "page")
    await expect(table.getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(table.getByText(titles[1]!, { exact: true })).toBeVisible()

    const views = page.getByRole("navigation", { name: "Task views" })
    const shopping = page.locator('.filter-toolbar [data-type="shopping_item"]')
    const calendar = page.locator("#calendar-shell")
    await views.getByRole("link", { name: "Calendar", exact: true }).click()
    await expect(shopping).toHaveAttribute("aria-pressed", "true")
    await expect(calendar).toHaveAttribute("data-calendar-ready", "true")
    await calendar.locator(`.cal-cell[data-date="${due}"]`).press("Enter")
    for (const title of titles) await expect(page.locator("#day-drawer-tasks").getByText(title, { exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await views.getByRole("link", { name: "Timeline (Gantt)", exact: true }).click()
    for (const id of ids) await expect(page.locator(`.gantt-bar[data-task-id="${id}"]`)).toBeAttached()
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(shopping).toHaveAttribute("aria-pressed", "true")
    for (const title of titles) await expect(page.locator("#kanban-shell").getByText(title, { exact: true })).toBeVisible()

    await page.goto("/tasks?view=calendar&types=quick_capture&status=backlog#calendar")
    await views.getByRole("link", { name: "Timeline (Gantt)", exact: true }).click()
    const timeline = page.locator("#timeline-filter-bar")
    await expect(timeline.locator('[data-type="quick_capture"]')).toHaveAttribute("aria-pressed", "true")
    await expect(timeline.getByRole("combobox", { name: "Filter by status" })).toHaveValue("backlog")
    await timeline.getByRole("combobox", { name: "Filter by priority" }).selectOption("3")
    await expect(page).toHaveURL(url => url.searchParams.get("types") === "quick_capture" &&
      url.searchParams.get("status") === "backlog" && url.searchParams.get("priority") === "3")
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    const filters = page.locator("#kanban-filter-bar")
    await expect(filters.locator('[data-type="quick_capture"]')).toHaveAttribute("aria-pressed", "true")
    await filters.getByRole("textbox", { name: "Filter by text" }).fill("receipt")
    await expect(page).toHaveURL(url => url.searchParams.get("types") === "quick_capture" &&
      url.searchParams.get("status") === "backlog" && url.searchParams.get("search") === "receipt")

    const legacyStatus = new URLSearchParams({ ...query, view: "calendar", search: suffix, status: "in_progress" })
    await page.goto("/tasks?" + legacyStatus + "#calendar")
    await expect(calendar).toHaveAttribute("data-calendar-ready", "true")
    await calendar.locator(`.cal-cell[data-date="${due}"]`).press("Enter")
    await expect(page.locator("#day-drawer-tasks").getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(page.locator("#day-drawer-tasks").getByText(titles[1]!, { exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await views.getByRole("link", { name: "Timeline (Gantt)", exact: true }).click()
    await expect(timeline.getByRole("combobox", { name: "Filter by status" })).toHaveValue("active")
    await expect(page.locator(`.gantt-bar[data-task-id="${ids[0]}"]`)).toBeAttached()
    await expect(page.locator(`.gantt-bar[data-task-id="${ids[1]}"]`)).toHaveCount(0)
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page.locator("#kanban-shell").getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(page.locator("#kanban-shell").getByText(titles[1]!, { exact: true })).toHaveCount(0)

    const stories = page.locator('#sidebar [data-page="legacy-task-type-story"]')
    const epics = page.locator('#sidebar [data-page="legacy-task-type-epic"]')
    await stories.click()
    await expect(page).toHaveURL(url => url.pathname === "/tasks" && url.hash === "#table" && url.searchParams.get("task_type") === "story")
    await expect(stories).toHaveAttribute("aria-current", "page")
    await expect(epics).not.toHaveAttribute("aria-current", "page")
    await expect(page.locator('#sidebar [data-page="tasks"]')).not.toHaveAttribute("aria-current", "page")
    await expect(table.getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(table.getByText(titles[1]!, { exact: true })).toHaveCount(0)
    await table.locator('.filter-toolbar [data-type="standard_action"]').click()
    await expect(page).toHaveURL(url => url.searchParams.has("types") && url.searchParams.get("task_type") === "story")
    await expect(stories).toHaveAttribute("aria-current", "page")
    await page.goto("/tasks?view=table&area=&task_type=story&task_type=epic#table")
    await expect(epics).toHaveAttribute("aria-current", "page")
    await expect(table.getByText(titles[1]!, { exact: true })).toBeVisible()
    await expect(table.getByText(titles[0]!, { exact: true })).toHaveCount(0)
    await table.locator('.filter-toolbar [data-type="standard_action"]').click()
    await expect(page.locator('#sidebar [data-page="legacy-task-type-epic-kinds"]')).toHaveAttribute("aria-current", "page")
    await expect(epics).not.toHaveAttribute("aria-current", "page")

    const calendarStories = page.locator('#sidebar [data-page="legacy-calendar-stories"]')
    await calendarStories.click()
    await expect(page).toHaveURL(url => url.pathname === "/tasks" && url.hash === "#calendar" && url.searchParams.get("task_type") === "story")
    await expect(calendarStories).toHaveAttribute("aria-current", "page")
    await expect(calendar).toHaveAttribute("data-calendar-ready", "true")
    await calendar.locator('.filter-toolbar [data-type="standard_action"]').click()
    await expect(page).toHaveURL(url => url.searchParams.has("types") && url.searchParams.get("task_type") === "story")
    await expect(calendarStories).toHaveAttribute("aria-current", "page")

    legacyStatus.delete("status")
    legacyStatus.set("advancedFilter", JSON.stringify({
      id: "root", logic: "AND",
      conditions: [{ id: "status", field: "status", operator: "equals", value: "in_progress" }],
    }))
    await page.goto("/tasks?" + legacyStatus + "#calendar")
    await expect(calendar).toHaveAttribute("data-calendar-ready", "true")
    await calendar.locator(`.cal-cell[data-date="${due}"]`).press("Enter")
    await expect(page.locator("#day-drawer-tasks").getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(page.locator("#day-drawer-tasks").getByText(titles[1]!, { exact: true })).toHaveCount(0)
    await page.keyboard.press("Escape")
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page.locator("#kanban-shell").getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(page.locator("#kanban-shell").getByText(titles[1]!, { exact: true })).toHaveCount(0)

    legacyStatus.set("advancedFilter", "{invalid")
    legacyStatus.append("advancedFilter", JSON.stringify({
      id: "legacy-or", logic: "OR",
      conditions: [
        { id: "pantry", field: "title", operator: "contains", value: "pantry" },
        { id: "frying", field: "title", operator: "contains", value: "frying pan" },
      ],
    }))
    await page.goto("/tasks?" + legacyStatus + "#calendar")
    await expect(calendar.locator(`.cal-cell[data-date="${due}"]`)).toHaveAccessibleName(/2 tasks$/)
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.getAll("advancedFilter").length === 1 &&
      url.searchParams.get("advancedFilter")?.includes('"logic":"OR"') === true)
    for (const title of titles) await expect(page.locator("#kanban-shell").getByText(title, { exact: true })).toBeVisible()

    const appliedRule = legacyStatus.getAll("advancedFilter").at(-1)!
    legacyStatus.delete("view")
    legacyStatus.set("advancedFilter", appliedRule)
    legacyStatus.append("advancedFilter", "{invalid")
    const defaultBoard = await request.get("/tasks?" + legacyStatus)
    expect(defaultBoard.ok()).toBe(true)
    const target = await page.evaluate(html => new DOMParser().parseFromString(html, "text/html")
      .querySelector('[data-view-tab="table"]')?.getAttribute("href"), await defaultBoard.text())
    expect(new URL(target!, baseURL).searchParams.getAll("advancedFilter")).toEqual([appliedRule])

    await page.goto("/tasks?" + scopedShopping + "&status=pending&status=in_progress#table")
    await expect(page.locator('#sidebar [data-page="active-shopping"]')).toHaveAttribute("aria-current", "page")
    await expect(page.locator('#sidebar [data-page="all-shopping"]')).not.toHaveAttribute("aria-current", "page")
    await expect(table.getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(table.getByText(titles[1]!, { exact: true })).toHaveCount(0)
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.getAll("status").join() === "in_progress")
    await expect(page.locator("#kanban-shell").getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(page.locator("#kanban-shell").getByText(titles[1]!, { exact: true })).toHaveCount(0)

    const promote = await request.patch(`/api/tasks/${ids[0]}`, { headers, data: { is_promoted: true } })
    expect(promote.ok(), await promote.text()).toBe(true)
    await page.goto("/tasks?" + calendarShopping + "&promoted=0#calendar")
    await expect(page.locator('#sidebar [data-page="promoted-shopping"]')).toHaveAttribute("aria-current", "page")
    await expect(calendar.locator(`.cal-cell[data-date="${due}"]`)).toHaveAccessibleName(/1 task$/)
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.getAll("promoted").join() === "1")
    await expect(page.locator("#kanban-shell").getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(page.locator("#kanban-shell").getByText(titles[1]!, { exact: true })).toHaveCount(0)

    calendarShopping.delete("promoted")
    calendarShopping.set("advancedFilter", JSON.stringify({
      id: "range", logic: "AND",
      conditions: [{ id: "priority", field: "priority", operator: "between", value: ["1", "2"] }],
    }))
    calendarShopping.append("advancedFilter", "{invalid")
    await page.goto("/tasks?" + calendarShopping + "#calendar")
    await expect(calendar.locator(`.cal-cell[data-date="${due}"]`)).toHaveAccessibleName(/2 tasks$/)
    await views.getByRole("link", { name: "Table", exact: true }).click()
    await expect(page).not.toHaveURL(/advancedFilter=/)
    for (const title of titles) await expect(table.getByText(title, { exact: true })).toBeVisible()

    calendarShopping.set("view", "timeline")
    calendarShopping.delete("advancedFilter")
    for (const title of titles) calendarShopping.append("advancedFilter", JSON.stringify({
      id: "legacy-title", logic: "AND",
      conditions: [{ id: "title", field: "title", operator: "equals", value: title }],
    }))
    await page.goto("/tasks?" + calendarShopping + "#timeline")
    for (const id of ids) await expect(page.locator(`.gantt-bar[data-task-id="${id}"]`)).toBeAttached()
    await views.getByRole("link", { name: "Calendar", exact: true }).click()
    await expect(page).not.toHaveURL(/advancedFilter=/)
    await expect(calendar.locator(`.cal-cell[data-date="${due}"]`)).toHaveAccessibleName(/2 tasks$/)
  } finally {
    await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})
