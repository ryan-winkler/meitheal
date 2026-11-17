import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

test("explicit Kanban survives conflicting fragments without a hierarchy filter", async ({ page }) => {
  const board = page.locator("#kanban-shell")
  const isExplicitKanban = (url: URL) => url.searchParams.get("view") === "kanban" && url.hash === "#kanban"
  for (const suffix of ["", "#kanban"]) {
    await page.goto("about:blank")
    await page.goto("/tasks?view=kanban" + suffix)
    await expect(page).toHaveURL(isExplicitKanban)
    await expect(page.locator("[data-view-tabs]")).toHaveAttribute("data-switcher-ready", "true")
    await board.evaluate(shell => { shell.dataset.originalDocument = "true" })
    for (const hash of ["calendar", "timeline"]) {
      await page.evaluate(hash => { location.hash = hash }, hash)
      await expect(page).toHaveURL(isExplicitKanban)
      await expect(board).toHaveAttribute("data-original-document", "true")
    }
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
        href: taskType === "story" ? "/tasks?area=&task_type=story" : "/table?area=&task_type=epic",
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
    const allCalendarKinds = "/tasks?" + new URLSearchParams({
      ...query, view: "calendar", types: "standard_action," + nonStandardKinds,
    }) + "#calendar"
    shortcuts.push({ id: "all-calendar-kinds", label: "Calendar around the house", href: allCalendarKinds, icon: "calendar-event" })
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
    const legacyBoard = await request.get("/kanban?task_type=story", { maxRedirects: 0 })
    expect(legacyBoard.status()).toBe(301)
    const boardLocation = new URL(legacyBoard.headers().location!, baseURL)
    expect(boardLocation.searchParams.get("task_type")).toBe("story")
    const firstDocument = await request.get(boardLocation.href)
    expect(firstDocument.ok()).toBe(true)
    expect(await firstDocument.text()).toContain('id="kanban-shell"')
    const firstTableDocument = await request.get("/tasks?area=&task_type=story")
    expect(firstTableDocument.ok()).toBe(true)
    expect(await firstTableDocument.text()).toContain('id="table-shell"')
    await stories.click()
    await expect(page).toHaveURL(url => url.pathname === "/tasks" && url.hash === "#table" && url.searchParams.get("task_type") === "story")
    await expect(stories).toHaveAttribute("aria-current", "page")
    await expect(epics).not.toHaveAttribute("aria-current", "page")
    await expect(page.locator('#sidebar [data-page="tasks"]')).not.toHaveAttribute("aria-current", "page")
    await expect(table.getByText(titles[0]!, { exact: true })).toBeVisible()
    await expect(table.getByText(titles[1]!, { exact: true })).toHaveCount(0)
    await expect(page).toHaveURL(url => url.searchParams.get("view") === "table")
    await table.evaluate(shell => { shell.dataset.originalDocument = "true" })
    await page.evaluate(() => { location.hash = "calendar" })
    await expect(page).toHaveURL(url => url.searchParams.get("view") === "table" && url.hash === "#table")
    await expect(table).toHaveAttribute("data-original-document", "true")
    await table.locator('.filter-toolbar [data-type="standard_action"]').click()
    await expect(page).toHaveURL(url => url.searchParams.has("types") && url.searchParams.get("task_type") === "story")
    await expect(stories).toHaveAttribute("aria-current", "page")
    await views.getByRole("link", { name: "Kanban", exact: true }).click()
    await expect(page).toHaveURL(url => url.hash === "#kanban" &&
      url.searchParams.get("view") === "kanban" && url.searchParams.get("task_type") === "story")
    await expect(page.locator("#kanban-shell")).toBeVisible()
    await expect(stories).not.toHaveAttribute("aria-current", "page")
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
    const calendarLink = views.getByRole("link", { name: "Calendar", exact: true })
    if (!(await calendarLink.isVisible())) await views.locator("[data-nav-overflow-more] summary").click()
    await calendarLink.click()
    await expect(page).not.toHaveURL(/advancedFilter=/)
    await expect(calendar.locator(`.cal-cell[data-date="${due}"]`)).toHaveAccessibleName(/2 tasks$/)

    await page.goto(allCalendarKinds)
    const allKindsShortcut = page.locator('#sidebar [data-page="all-calendar-kinds"]')
    await expect(allKindsShortcut).toHaveAttribute("aria-current", "page")
    await calendar.getByRole("textbox", { name: "Filter by text" }).fill(suffix)
    await expect(page).toHaveURL(url => url.searchParams.get("search") === suffix && !url.searchParams.has("types"))
    await expect(allKindsShortcut).toHaveAttribute("aria-current", "page")
  } finally {
    await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})
