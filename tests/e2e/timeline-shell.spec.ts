import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Shell (Timeline/GANTT)", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/tasks?view=timeline#timeline")
    await page.waitForLoadState("networkidle")
  })

  test("timeline view container renders in unified tasks page", async ({ page }) => {
    const container = page.locator("#tasks-view-timeline")
    await expect(container).toBeVisible()
    await expect(page.locator("#tasks-view-kanban")).toHaveCount(0)
  })

  test("timeline data script tag exists with JSON blob", async ({ page }) => {
    const dataEl = page.locator("#timeline-data")
    await expect(dataEl).toBeAttached()

    // Should contain valid JSON (even if empty array)
    const content = await dataEl.textContent()
    expect(() => JSON.parse(content || "[]")).not.toThrow()
  })

  test("GANTT chart or empty state renders", async ({ page }) => {
    const ganttChart = page.locator("#gantt-chart")
    const emptyState = page.locator("#timeline-empty")
    const skeleton = page.locator("#timeline-skeleton")

    // Skeleton should be hidden after initialization
    await expect(skeleton).not.toBeVisible({ timeout: 5000 })

    // Either GANTT chart or empty state should be visible
    const ganttVisible = await ganttChart.isVisible()
    const emptyVisible = await emptyState.isVisible()
    expect(ganttVisible || emptyVisible).toBe(true)
  })

  test("timeline chart exposes grid semantics for assistive technology", async ({ page }) => {
    const ganttChart = page.locator("#gantt-chart")

    await expect(ganttChart).toHaveAttribute("role", "grid")
    await expect(ganttChart).toHaveAttribute("aria-label", "Task timeline Gantt chart")

    const rowCount = Number(await ganttChart.getAttribute("aria-rowcount"))
    const columnCount = Number(await ganttChart.getAttribute("aria-colcount"))
    expect(rowCount).toBeGreaterThanOrEqual(0)
    expect(columnCount).toBeGreaterThanOrEqual(1)
  })

  test("native GANTT chart renders SVG when tasks have dates", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const now = new Date()
    const response = await request.post("/api/tasks", { headers, data: {
      title: "Timeline dated fixture", start_date: now.toISOString(),
      due_date: new Date(now.getTime() + 86400000).toISOString(),
    } })
    expect(response.status()).toBe(201)
    const { id } = await response.json()
    try {
      await page.reload()
      const chart = page.locator("#gantt-chart")
      await expect(chart.locator("svg.gantt-native")).toBeAttached()
      await expect(chart.locator(".gantt-bar, .gantt-milestone").first()).toBeAttached()
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("Timeline keeps its filters and grouping across view switches", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const prefix = `Timeline filters ${crypto.randomUUID()}`
    const ids: string[] = []
    const now = Date.now()
    try {
      for (const [suffix, status] of [["Radiator", "active"], ["Paint", "pending"]]) {
        const response = await request.post("/api/tasks", { headers, data: {
          title: `${prefix} ${suffix}`,
          status,
          start_date: new Date(now).toISOString(),
          due_date: new Date(now + 86400000).toISOString(),
        } })
        expect(response.status(), await response.text()).toBe(201)
        ids.push((await response.json()).id)
      }
      await page.goto(`/tasks?view=timeline&search=${encodeURIComponent(prefix)}#timeline`)
      const timeline = page.locator("#tasks-view-timeline")
      const toolbar = timeline.getByRole("toolbar", { name: "Filter tasks" })
      const search = toolbar.getByRole("textbox", { name: "Filter by text" })
      const radiator = timeline.locator(`.gantt-bar[data-task-id="${ids[0]}"]`)
      const paint = timeline.locator(`.gantt-bar[data-task-id="${ids[1]}"]`)
      await expect(search).toHaveValue(prefix)
      await expect(radiator).toBeVisible()
      await expect(paint).toBeVisible()

      const groupBy = toolbar.locator('details[aria-label="Group tasks by"]')
      await groupBy.locator("summary").click()
      await groupBy.getByRole("button", { name: "By Status", exact: true }).click()
      await expect(timeline.locator('.gantt-sidebar-row[data-task-id="group-active"]')).toBeVisible()
      const status = toolbar.getByRole("combobox", { name: "Filter by status" })
      await status.selectOption("active")
      await expect(paint).toHaveCount(0)
      await status.selectOption("")
      await expect(paint).toBeVisible()
      await search.fill(`${prefix} Radiator`)
      await expect(paint).toHaveCount(0)

      await page.locator('[data-view-tab="table"]').click()
      await expect(page.locator("#tasks-view-table")).toBeVisible()
      await page.locator('[data-view-tab="timeline"]').click()
      await expect(search).toHaveValue(`${prefix} Radiator`)
      await expect(groupBy.locator("summary")).toContainText("Status")
      await expect(radiator).toBeVisible()
      await expect(paint).toHaveCount(0)
      await expect(page.locator("#tasks-view-kanban, #tasks-view-table")).toHaveCount(0)
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("Timeline keeps same-name projects and unassigned tasks in separate groups", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

    const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
    const token = crypto.randomUUID().slice(0, 8)
    const prefix = `Timeline projects ${token}`
    const title = `Renovation ${token} with the shared collection of household repairs, maintenance, materials and schedules`
    const kitchen = `Kitchen ${token}`
    const garden = `Garden ${token}`
    const start = Date.now()
    const dates = {
      start_date: new Date(start).toISOString().slice(0, 10),
      due_date: new Date(start + 86_400_000).toISOString().slice(0, 10),
    }
    const cleanup: string[] = []
    async function create(path: string, data: object): Promise<string> {
      const response = await request.post(path, { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      const { id } = await response.json() as { id: string }
      cleanup.push(`${path}/${id}`)
      return id
    }

    try {
      const kitchenId = await create("/api/areas", { name: kitchen })
      const gardenId = await create("/api/areas", { name: garden })
      const firstProject = await create("/api/projects", { title, area_id: kitchenId })
      const secondProject = await create("/api/projects", { title, area_id: gardenId })
      const reservedProject = await create("/api/projects", { title: "No Project", area_id: kitchenId })
      const firstTask = await create("/api/tasks", { ...dates, title: `${prefix} Shelves`, area_id: kitchenId, project_id: firstProject })
      const secondTask = await create("/api/tasks", { ...dates, title: `${prefix} Planters`, area_id: gardenId, project_id: secondProject })
      const reservedTask = await create("/api/tasks", { ...dates, title: `${prefix} Tiles`, area_id: kitchenId, project_id: reservedProject })
      const unassignedTask = await create("/api/tasks", { ...dates, title: `${prefix} Windows` })

      const query = new URLSearchParams({ view: "timeline", search: prefix, area: "", groupBy: "project" })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/tasks?${query}#timeline`)
      const timeline = page.locator("#tasks-view-timeline")
      const paneToggle = timeline.getByRole("button", { name: "Task pane" })
      await expect(paneToggle).toBeEnabled()
      if (await paneToggle.getAttribute("aria-expanded") === "false") await paneToggle.press("Enter")
      const projectRow = (id: string) => timeline.locator(`.gantt-sidebar-row[data-task-id="group-project-${id}"]`)
      const label = (id: string) => projectRow(id).locator(".gantt-sidebar-row-title")
      const qualifier = (id: string) => projectRow(id).locator(".gantt-sidebar-group-qualifier")
      const bar = (id: string) => timeline.locator(`.gantt-bar[data-task-id="${id}"]`)
      const firstToggle = projectRow(firstProject).getByRole("button")
      const secondToggle = projectRow(secondProject).getByRole("button")
      const firstQualifier = `#${firstProject.slice(-8)} · ${kitchen}`
      const secondQualifier = `#${secondProject.slice(-8)} · ${garden}`
      const reservedQualifier = `#${reservedProject.slice(-8)} · ${kitchen}`
      await expect(projectRow(firstProject)).toHaveAttribute("aria-label", `Group: ${title} · ${firstQualifier}`)
      await expect(projectRow(secondProject)).toHaveAttribute("aria-label", `Group: ${title} · ${secondQualifier}`)
      await expect(projectRow(reservedProject)).toHaveAttribute("aria-label", `Group: No Project · ${reservedQualifier}`)
      await expect(qualifier(firstProject)).toHaveText(firstQualifier)
      await expect(qualifier(firstProject)).toBeInViewport()
      await expect(qualifier(secondProject)).toHaveText(secondQualifier)
      await expect(qualifier(secondProject)).toBeInViewport()
      await expect(label("")).toHaveText("No Project")
      for (const id of [firstTask, secondTask, reservedTask, unassignedTask]) await expect(bar(id)).toBeVisible()

      await firstToggle.focus()
      await page.keyboard.press("Shift+Tab")
      await expect(firstToggle).not.toBeFocused()
      await page.keyboard.press("Tab")
      await expect(firstToggle).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(firstToggle).toHaveAttribute("aria-expanded", "false")
      await expect(firstToggle).toBeFocused()
      await expect(secondToggle).toHaveAttribute("aria-expanded", "true")
      await expect(bar(firstTask)).toHaveCount(0)
      for (const id of [secondTask, reservedTask, unassignedTask]) await expect(bar(id)).toBeVisible()

      const search = timeline.getByRole("textbox", { name: "Filter by text" })
      await search.fill(`${prefix} Planters`)
      await expect(projectRow(firstProject)).toHaveCount(0)
      await expect(projectRow(secondProject)).toHaveAttribute("aria-label", `Group: ${title} · ${secondQualifier}`)
      await search.fill(prefix)
      await expect(firstToggle).toHaveAttribute("aria-expanded", "false")
      await expect(bar(firstTask)).toHaveCount(0)
      await firstToggle.press("Space")
      await expect(firstToggle).toHaveAttribute("aria-expanded", "true")
      await expect(firstToggle).toBeFocused()
      await expect(bar(firstTask)).toBeVisible()

      const renamedTitle = `Cabinets ${token}`
      const renamed = await request.put(`/api/projects/${firstProject}`, { headers, data: { title: renamedTitle } })
      expect(renamed.ok(), await renamed.text()).toBe(true)
      await page.reload()
      await expect(label(firstProject)).toHaveText(renamedTitle)
      await expect(label(secondProject)).toHaveText(title)
      await expect(bar(firstTask)).toBeVisible()
      await expect(bar(secondTask)).toBeVisible()

      // Put the second project beyond the first virtual window.
      const extraTasks = 22
      for (let index = 1; index <= extraTasks; index++) {
        const day = start + index * 86_400_000
        await create("/api/tasks", {
          title: `${prefix} Cabinet ${index}`, area_id: kitchenId, project_id: firstProject,
          start_date: new Date(day).toISOString().slice(0, 10),
          due_date: new Date(day + 86_400_000).toISOString().slice(0, 10),
        })
      }
      // Exercise an Area label that produces the same header ID as the real project.
      const renamedArea = await request.put(`/api/areas/${gardenId}`, { headers, data: { name: `project-${secondProject}` } })
      expect(renamedArea.ok(), await renamedArea.text()).toBe(true)
      await page.setViewportSize({ width: 1440, height: 620 })
      await page.reload()
      await expect(firstToggle).toBeVisible()
      await expect(projectRow(secondProject)).toHaveCount(0)
      await firstToggle.focus()
      // Navigate the first project's tasks and the two groups between the projects.
      for (let step = 0; step < extraTasks + 6; step++) await page.keyboard.press("ArrowDown")
      await expect(secondToggle).toBeFocused()
      await page.keyboard.press("Enter")
      await expect(secondToggle).toHaveAttribute("aria-expanded", "false")
      await expect(secondToggle).toBeFocused()
      await expect(bar(secondTask)).toHaveCount(0)
      await page.keyboard.press("ArrowUp")
      await expect(bar(reservedTask)).toBeFocused()
      await page.keyboard.press("j")
      await expect(secondToggle).toBeFocused()
      await expect(secondToggle).toHaveAttribute("aria-expanded", "false")
      await page.keyboard.press("Equal")
      await expect(timeline.locator("#timeline-zoom-label")).toHaveText("Day")
      await expect(secondToggle).toBeFocused()
      await expect(secondToggle).toHaveAttribute("aria-expanded", "false")

      await search.fill(`${prefix} Planters`)
      await expect(firstToggle).toHaveCount(0)
      const groupBy = timeline.locator('details[aria-label="Group tasks by"]')
      await groupBy.locator("summary").click()
      await groupBy.getByRole("button", { name: "By Area", exact: true }).click()
      const areaToggle = timeline.locator(`.gantt-sidebar-row[data-task-id="group-area-${gardenId}"]`).getByRole("button")
      await expect(areaToggle).toHaveAttribute("aria-expanded", "true")
      await expect(bar(secondTask)).toBeVisible()
      await groupBy.locator("summary").click()
      await groupBy.getByRole("button", { name: "By Project", exact: true }).click()
      await expect(secondToggle).toHaveAttribute("aria-expanded", "false")
      await expect(bar(secondTask)).toHaveCount(0)
      await secondToggle.press("Space")
      await expect(secondToggle).toHaveAttribute("aria-expanded", "true")
      await expect(bar(secondTask)).toBeVisible()
    } finally {
      const failures: string[] = []
      for (const path of cleanup.reverse()) {
        const response = await request.delete(path, { headers, data: {} })
        if (!response.ok()) failures.push(`${path} returned ${response.status()} ${await response.text()}`)
      }
      expect(failures).toEqual([])
    }
  })

  test("Timeline keeps same-name Areas separate through filtering and renaming", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")
    const headers = { origin: new URL(baseURL!).origin }
    const token = crypto.randomUUID().slice(0, 8)
    const title = `Workshop ${token} with the shared collection of household repairs and workshop equipment`
    const prefix = `Timeline area ${token}`
    const dates = {
      start_date: new Date().toISOString().slice(0, 10),
      due_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    }
    const cleanup: string[] = []
    async function create(path: string, data: object): Promise<string> {
      const result = await request.post(path, { headers, data })
      expect(result.status(), await result.text()).toBe(201)
      const { id } = await result.json() as { id: string }
      cleanup.push(`${path}/${id}`)
      return id
    }
    async function rename(id: string, name: string) {
      const result = await request.put(`/api/areas/${id}`, { headers, data: { name } })
      expect(result.ok(), await result.text()).toBe(true)
    }

    try {
      const first = await create("/api/areas", { name: title })
      const second = await create("/api/areas", { name: `Other workshop ${token}` })
      await rename(second, title)
      const reserved = await create("/api/areas", { name: "Unknown Area" })
      const reservedTask = await create("/api/tasks", { ...dates, title: `${prefix} Tools`, area_id: reserved })
      const firstTask = await create("/api/tasks", { ...dates, title: `${prefix} Plumbing`, area_id: first })
      const secondTask = await create("/api/tasks", { ...dates, title: `${prefix} Painting`, area_id: second })
      const query = new URLSearchParams({ view: "timeline", search: prefix, area: "", groupBy: "area" })
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto(`/tasks?${query}#timeline`)
      const chart = page.locator("#tasks-view-timeline")
      const pane = chart.getByRole("button", { name: "Task pane" })
      await expect(pane).toBeEnabled()
      if (await pane.getAttribute("aria-expanded") === "false") await pane.press("Enter")
      const row = (areaId: string) => chart.locator(`.gantt-sidebar-row[data-task-id="group-area-${areaId}"]`)
      const bar = (taskId: string) => chart.locator(`.gantt-bar[data-task-id="${taskId}"]`)
      const firstToggle = row(first).getByRole("button")
      const secondToggle = row(second).getByRole("button")
      const search = chart.getByRole("textbox", { name: "Filter by text" })
      await expect(row(first)).toHaveAccessibleName(`Group: ${title} · #${first.slice(-8)}`)
      await expect(row(second)).toHaveAccessibleName(`Group: ${title} · #${second.slice(-8)}`)
      await expect(row(second).locator(".gantt-sidebar-group-qualifier")).toBeInViewport()
      await expect(bar(firstTask)).toBeVisible()
      await expect(bar(secondTask)).toBeVisible()

      await firstToggle.press("Enter")
      await expect(firstToggle).toBeFocused()
      await expect(firstToggle).toHaveAttribute("aria-expanded", "false")
      await expect(secondToggle).toHaveAttribute("aria-expanded", "true")
      await expect(bar(firstTask)).toHaveCount(0)
      await expect(bar(secondTask)).toBeVisible()

      await search.fill(`${prefix} Painting`)
      await expect(row(first)).toHaveCount(0)
      await expect(row(second)).toHaveAccessibleName(`Group: ${title} · #${second.slice(-8)}`)
      await search.fill(prefix)
      await expect(firstToggle).toHaveAttribute("aria-expanded", "false")
      await firstToggle.press("Space")
      await expect(bar(firstTask)).toBeVisible()

      const unique = `Tool shed ${token}`
      await rename(second, unique)
      await page.reload()
      await expect(row(first)).toHaveAccessibleName(`Group: ${title}`)
      await expect(row(second)).toHaveAccessibleName(`Group: ${unique}`)
      await expect(row(first).locator(".gantt-sidebar-group-qualifier")).toHaveCount(0)
      await expect(row(second).locator(".gantt-sidebar-group-qualifier")).toHaveCount(0)
      await expect(row(reserved)).toHaveAccessibleName(`Group: Unknown Area · #${reserved.slice(-8)}`)

      const original = await request.get(`/tasks?${query}`)
      expect(original.ok()).toBe(true)
      const html = await original.text()
      const remount = async (catalogText: string | null, assignedAreas: Record<string, string> = {}) => {
        await page.evaluate(({ html, catalogText, assignedAreas }) => {
          const incoming = new DOMParser().parseFromString(html, "text/html")
          const catalog = incoming.getElementById("timeline-areas")
          if (!catalog) throw new Error("Fixture did not return a Timeline Area catalog")
          if (catalogText === null) catalog.remove()
          else catalog.textContent = catalogText
          if (Object.keys(assignedAreas).length) {
            const data = incoming.getElementById("timeline-data")
            if (!data) throw new Error("Fixture did not return Timeline tasks")
            const tasks = JSON.parse(data.textContent ?? "[]") as { id: string; area_id: string }[]
            for (const task of tasks) {
              const area = assignedAreas[task.id]
              if (area) task.area_id = area
            }
            data.textContent = JSON.stringify(tasks)
          }
          const replacement = incoming.getElementById("tasks-view-timeline")
          const current = document.getElementById("tasks-view-timeline")
          if (!current || !replacement) throw new Error("Fixture Timeline root missing")
          document.dispatchEvent(Object.assign(new Event("astro:before-swap"), { newDocument: incoming }))
          current.replaceWith(replacement)
          document.dispatchEvent(new Event("astro:page-load"))
        }, { html, catalogText, assignedAreas })
      }

      const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaa112345678"
      const b = "aaaaaaaa-aaaa-4aaa-8aaa-aaa212345678"
      const assignments = { [firstTask]: a, [secondTask]: b, [reservedTask]: "literal" }
      const labels = { [a]: "İ", [b]: "i\u0307", literal: "İ · #12345678" }
      const verifyQualifiedLabels = async () => {
        await expect(row(a)).toHaveAccessibleName("Group: İ · #1-12345678")
        await expect(row(b)).toHaveAccessibleName("Group: i\u0307 · #2-12345678")
        await expect(row("literal")).toHaveAccessibleName("Group: İ · #12345678")
      }
      await remount(JSON.stringify(Object.fromEntries(Object.entries(labels).reverse())), assignments)
      await verifyQualifiedLabels()
      await page.setViewportSize({ width: 375, height: 760 })
      await expect(pane).toHaveAttribute("aria-expanded", "false")
      await pane.press("Enter")
      for (const id of [a, b]) {
        const qualifier = row(id).locator(".gantt-sidebar-group-qualifier")
        await expect(qualifier).toBeInViewport()
        expect(await qualifier.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      }
      await page.setViewportSize({ width: 1440, height: 900 })

      await remount(JSON.stringify({ [a]: "Straße", [b]: "STRASSE", literal: "Other place" }), assignments)
      await expect(row(a)).toHaveAccessibleName("Group: Straße · #12345678")
      await expect(row(b)).toHaveAccessibleName("Group: STRASSE · #1-12345678")

      await remount(JSON.stringify({ [a]: "Valid Area", [b]: " ", literal: false }), assignments)
      await expect(row(a)).toHaveAccessibleName("Group: Valid Area")
      await expect(row(b)).toHaveCount(0)
      await expect(row("literal")).toHaveCount(0)
      await expect(chart.getByRole("heading", { name: "Group: Unknown Area", exact: true })).toBeVisible()
      await expect(bar(secondTask)).toBeVisible()
      await expect(bar(reservedTask)).toBeVisible()

      for (const malformed of [null, "{", "null", "{}"]) {
        await remount(JSON.stringify(labels), assignments)
        await verifyQualifiedLabels()
        await remount(malformed, assignments)
        const fallback = chart.getByRole("heading", { name: "Group: Unknown Area", exact: true })
        await expect(fallback).toBeVisible()
        await expect(chart.locator(".gantt-sidebar-group-qualifier")).toHaveCount(0)
        await expect(row(a)).toHaveCount(0)
        await expect(row(b)).toHaveCount(0)
        await expect(row("literal")).toHaveCount(0)
        await expect(bar(reservedTask)).toBeVisible()
        await expect(bar(secondTask)).toBeVisible()
      }
    } finally {
      const failures: string[] = []
      for (const path of cleanup.reverse()) {
        const result = await request.delete(path, { headers, data: {}, maxRetries: 1 })
        if (!result.ok()) failures.push(`${path} returned ${result.status()}`)
      }
      expect(failures).toEqual([])
    }
  })

  test("Timeline filters stay in the background URL with Details docked", async ({ page, request, baseURL }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.evaluate(() => localStorage.setItem("meitheal-task-nav-prefs", JSON.stringify({ pinnedViews: ["table"] })))
    const title = "Inspect the heating system"
    const start = Date.now()
    const headers = { origin: new URL(baseURL!).origin }
    const response = await request.post("/api/tasks", { headers, data: {
      title, start_date: new Date(start).toISOString(), due_date: new Date(start + 86_400_000).toISOString(),
    } })
    expect(response.status()).toBe(201)
    const { id } = await response.json()
    try {
      await page.reload()
      const bar = page.locator(`.gantt-bar[data-task-id="${id}"]`)
      const search = page.locator("#timeline-filter-bar").getByRole("textbox", { name: "Filter by text" })
      const openDetails = async () => {
        await bar.press("Enter")
        await page.getByRole("button", { name: "View Details", exact: false }).click()
        await expect(page.locator("#td-status")).toBeEnabled()
        await expect(page).toHaveURL(/\/tickets\/[^?]+$/)
      }
      await openDetails()
      await search.fill(title)
      await expect.poll(() => page.evaluate(() => new URL(history.state.ticketDrawer.returnTo).searchParams.get("search"))).toBe(title)
      await page.locator("#td-close").click()
      await expect(page).toHaveURL(url => url.hash === "#timeline" && url.searchParams.get("search") === title)

      await openDetails()
      await search.fill("heating system")
      await expect.poll(() => page.evaluate(() => new URL(history.state.ticketDrawer.returnTo).searchParams.get("search"))).toBe("heating system")
      const pinned = page.locator('#sidebar [data-task-view-pinned-item="table"]').getByRole("link", { name: "Table" })
      await pinned.click()
      await expect(page).toHaveURL(url => url.hash === "#table" && url.searchParams.get("search") === "heating system")
      await expect(page.locator("#table-shell").getByRole("textbox", { name: "Filter by text" })).toHaveValue("heating system")
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers, data: {} })
    }
  })

  test("phone Timeline discloses filters and the task pane without crowding the chart", async ({ page, request, baseURL }) => {
    const title = "Phone Timeline milestone " + crypto.randomUUID()
    const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const headers = { origin: new URL(baseURL!).origin }
    const response = await request.post("/api/tasks", { headers, data: {
      title, start_date: date, due_date: date, color: "#000044",
    } })
    expect(response.status(), await response.text()).toBe(201)
    const { id } = await response.json()

    try {
      await page.setViewportSize({ width: 320, height: 780 })
      await page.goto(`/tasks?view=timeline&search=${encodeURIComponent(title)}#timeline`)
      const disclosure = page.getByRole("button", { name: "Filters Active" })
      const toolbar = page.locator("#timeline-filter-bar")
      const paneToggle = page.getByRole("button", { name: "Task pane" })
      const pane = page.locator("#timeline-task-pane")
      const chart = page.locator("#gantt-chart")
      const milestone = chart.locator(`.gantt-milestone[data-task-id="${id}"] polygon`)
      await expect(disclosure).toHaveAttribute("aria-expanded", "false")
      await expect(toolbar).toBeHidden()
      await expect(paneToggle).toBeEnabled()
      await expect(paneToggle).toHaveAttribute("aria-expanded", "false")
      await expect(pane).toBeHidden()
      await expect(chart).toBeInViewport()
      expect((await paneToggle.boundingBox())?.height).toBeGreaterThanOrEqual(44)
      expect((await chart.locator(".gantt-scroll-wrapper").boundingBox())?.width).toBeGreaterThan(240)

      const legend = page.locator(".timeline-legend")
      await legend.getByText("Legend", { exact: true }).click()
      const legendPanel = legend.locator(".timeline-legend-panel")
      await expect(legendPanel.getByText("Critical (P1)")).toBeVisible()
      expect(await legendPanel.evaluate(panel => {
        const rect = panel.getBoundingClientRect()
        const viewport = panel.closest("#tasks-view-timeline")!.getBoundingClientRect()
        return rect.left >= viewport.left && rect.right <= Math.min(innerWidth, viewport.right)
      })).toBe(true)
      await legend.getByText("Legend", { exact: true }).click()

      await disclosure.press("Enter")
      await page.keyboard.press("Tab")
      const search = toolbar.getByRole("textbox", { name: "Filter by text" })
      await expect(search).toBeFocused()
      await expect(search).toHaveValue(title)
      await page.keyboard.press("Escape")
      await expect(disclosure).toBeFocused()
      await expect(toolbar).toBeHidden()

      await paneToggle.press("Enter")
      await expect(paneToggle).toHaveAttribute("aria-expanded", "true")
      await expect(pane).toBeVisible()
      await page.reload()
      await expect(paneToggle).toHaveAttribute("aria-expanded", "true")
      await expect(pane).toBeVisible()
      await page.goto("/tasks?view=timeline&search=no_matching_timeline_tasks#timeline")
      await expect(paneToggle).toBeDisabled()
      await expect(paneToggle).toHaveAttribute("aria-expanded", "false")
      await expect(paneToggle).not.toHaveAttribute("aria-controls")
      await page.goBack()
      await expect(paneToggle).toBeEnabled()
      await expect(paneToggle).toHaveAttribute("aria-expanded", "true")

      for (const theme of ["light", "dark", "knight-rider", "auto", "custom"]) {
        await page.evaluate(mode => { localStorage.setItem("meitheal-theme", mode) }, theme)
        await page.reload()
        await expect(milestone).toHaveCSS("fill", "rgb(0, 0, 68)")
        const contrast = await milestone.evaluate(polygon => {
          const canvas = document.createElement("canvas")
          const context = canvas.getContext("2d")
          if (!context) throw new Error("Canvas unavailable")
          function luminance(color: string) {
            context!.fillStyle = color
            context!.fillRect(0, 0, 1, 1)
            const rgb = Array.from(context!.getImageData(0, 0, 1, 1).data.slice(0, 3)).map(value => {
              const channel = value / 255
              return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
            })
            return (rgb[0] ?? 0) * 0.2126 + (rgb[1] ?? 0) * 0.7152 + (rgb[2] ?? 0) * 0.0722
          }
          const stroke = luminance(getComputedStyle(polygon).stroke)
          return Array.from(polygon.closest("svg")?.querySelectorAll("#gantt-col-grid rect") ?? [], rect => {
            const fill = luminance(getComputedStyle(rect).fill)
            return (Math.max(stroke, fill) + 0.05) / (Math.min(stroke, fill) + 0.05)
          })
        })
        expect(contrast.length).toBeGreaterThanOrEqual(2)
        expect(Math.min(...contrast), theme).toBeGreaterThanOrEqual(3)
      }
      const past = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)
      const reschedule = await request.patch(`/api/tasks/${id}`, { headers, data: { start_date: past, due_date: past } })
      expect(reschedule.ok(), await reschedule.text()).toBe(true)
      await page.reload()
      await expect(chart.getByRole("button", { name: new RegExp(title + ", overdue") })).toBeVisible()
      await expect(milestone).toHaveCSS("fill", "rgb(0, 0, 68)")
      await expect(milestone).toHaveCSS("stroke-width", "2px")
      await page.evaluate(() => {
        localStorage.setItem("meitheal-theme", "knight-rider")
        localStorage.setItem("meitheal-accent-color", "#242424")
      })
      await page.reload()
      const milestoneControl = chart.getByRole("button", { name: new RegExp(title + ", overdue") })
      await milestoneControl.focus()
      await expect(milestoneControl).toHaveCSS("outline-color", "rgb(166, 192, 249)")
      await page.getByText("Legend", { exact: true }).click()
      await expect(page.getByText("Overdue milestone", { exact: true })).toBeVisible()
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("native GANTT sidebar renders task labels", async ({ page }) => {
    const isEmpty = await page.locator("#timeline-empty").isVisible()

    if (!isEmpty) {
      // Sidebar should have task rows
      const sidebar = page.locator(".gantt-sidebar")
      await expect(sidebar).toBeVisible({ timeout: 5000 })

      const rows = page.locator(".gantt-sidebar-row")
      const rowCount = await rows.count()
      expect(rowCount).toBeGreaterThan(0)
    }
  })

  test("zoom dropdown is present and functional", async ({ page }) => {
    const zoomDropdown = page.locator("#timeline-zoom-dropdown")
    await expect(zoomDropdown).toBeVisible()

    // Open the dropdown
    await zoomDropdown.locator("summary").click()

    // Should have Day/Week/Month options
    const options = zoomDropdown.locator(".timeline-zoom-option")
    expect(await options.count()).toBe(3)
    await expect(options.nth(0)).toContainText("Day")
    await expect(options.nth(1)).toContainText("Week")
    await expect(options.nth(2)).toContainText("Month")
  })

  test("legend disclosure chip is present", async ({ page }) => {
    const legend = page.locator(".timeline-legend")
    await expect(legend).toBeVisible()

    // Click to expand
    await legend.locator("summary").click()
    const panel = legend.locator(".timeline-legend-panel")
    await expect(panel).toBeVisible()
  })

  test("scroll-to-today FAB is present when chart renders", async ({ page }) => {
    const isEmpty = await page.locator("#timeline-empty").isVisible()

    if (!isEmpty) {
      const fab = page.locator(".gantt-today-fab")
      await expect(fab).toBeVisible({ timeout: 5000 })

      // Should have correct title/tooltip
      await expect(fab).toHaveAttribute("title", "Scroll to today (T)")
    }
  })

  test("/timeline redirects to /tasks#timeline", async ({ page }) => {
    await page.goto("/timeline")
    await page.waitForLoadState("networkidle")
    await expect(page).toHaveURL(/\/tasks.*#timeline/)
  })

  test("switching to timeline view via hash change works", async ({ page }) => {
    // Start on kanban
    await page.goto("/tasks#kanban")
    await page.waitForLoadState("networkidle")

    const kanbanView = page.locator("#tasks-view-kanban")
    await expect(kanbanView).toBeVisible()

    // Switch to timeline via hash
    await page.evaluate(() => {
      window.location.hash = "timeline"
    })

    await page.waitForTimeout(500)
    const timelineView = page.locator("#tasks-view-timeline")
    await expect(timelineView).toBeVisible()
  })

  test("empty state shows helpful guidance when no dated tasks", async ({ page }) => {
    const emptyState = page.locator("#timeline-empty")
    const isEmpty = await emptyState.isVisible()

    if (isEmpty) {
      await expect(emptyState.locator(".empty-title")).toHaveText(
        "No tasks on the timeline yet"
      )
      await expect(emptyState.locator(".empty-desc")).toContainText("start dates")
    }
  })

  test("no console errors from timeline initialization", async ({ page }) => {
    const errors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().includes("[timeline]")) {
        errors.push(msg.text())
      }
    })

    await page.goto("/tasks?view=timeline#timeline")
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(2000) // Allow chart to initialize

    expect(errors).toHaveLength(0)
  })
})
