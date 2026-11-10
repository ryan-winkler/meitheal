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
