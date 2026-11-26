import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })


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
      expect(saveSidebar.ok(), await saveSidebar.text()).toBe(true)
      await page.setViewportSize({ width: 1440, height: 950 })
      await page.emulateMedia({ colorScheme: "light" })
      await page.addInitScript(({ theme, customCSS }) => {
        localStorage.setItem("meitheal-theme", theme)
        localStorage.setItem("meitheal-appearance", JSON.stringify({ sidebar: "expanded" }))
        localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({ mode: "all", pinned: ["shopping_item"] }))
        if (theme === "custom") localStorage.setItem("meitheal-custom-theme-css", customCSS)
      }, { theme, customCSS })

      await page.goto(calendarPath)
      const resolvedTheme = theme === "custom" ? "dark" : theme === "auto" ? "light" : theme
      await expect(page.locator("html")).toHaveAttribute("data-theme", resolvedTheme)
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
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
    const allCalendarKinds = new URLSearchParams({
      view: "calendar", area: "", types: "standard_action,shopping_item,checklist,routine_instance,calendar_event,quick_capture",
    })
    paths.push("/tasks?" + calendarParams + "#calendar", "/tasks?" + groceryParams, "/tasks?" + ruleParams,
      ruleWithView("calendar"), ruleWithView("table"), "/tasks?" + invalidRule, "/tasks?" + completedCalendar,
      "/tasks?" + allCalendarKinds + "#calendar")
    const shortcuts = ["All Shopping", ...names, "Kitchen shopping calendar", "Grocery shopping", "Grocery rule",
      "Grocery Calendar rule", "Grocery Table rule", "Invalid Grocery rule", "Completed shopping calendar", "All Calendar kinds"].map((label, index) => ({
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

    await page.goto("/tasks?view=calendar&area=&types=shopping_item#calendar")
    await expect(calendarFilters.locator('[data-type="shopping_item"]')).toHaveAttribute("aria-pressed", "true")
    await expect(current).toHaveCount(0)
    await expect(sidebar.locator('[data-page="tasks"]')).toHaveAttribute("aria-current", "page")
    await sidebar.getByRole("link", { name: "All Calendar kinds" }).click()
    await expect(current).toHaveText("All Calendar kinds")
    await page.goto("/tasks?view=calendar&area=#calendar")
    await expect(current).toHaveText("All Calendar kinds")
  } finally {
    await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })
    for (const id of areas) await request.delete(`/api/areas/${id}`, { headers })
  }
})
