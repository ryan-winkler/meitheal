import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Shell (Timeline/GANTT)", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/tasks#timeline")
    await page.waitForLoadState("networkidle")
  })

  test("timeline view container renders in unified tasks page", async ({ page }) => {
    const container = page.locator("#tasks-view-timeline")
    await expect(container).toBeVisible()
    await expect(container).toHaveAttribute("aria-hidden", "false")
  })

  test("timeline data script tag exists with JSON blob", async ({ page }) => {
    const dataEl = page.locator("#timeline-data")
    await expect(dataEl).toBeAttached()

    // Should contain valid JSON (even if empty array)
    const content = await dataEl.textContent()
    expect(() => JSON.parse(content || "[]")).not.toThrow()
  })

  test("GANTT chart or empty state renders", async ({ page }) => {
    // One of these should be visible: the GANTT chart or the empty state
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

  test("GANTT chart renders SVG when tasks have dates", async ({ page }) => {
    const ganttChart = page.locator("#gantt-chart")
    const isEmpty = await page.locator("#timeline-empty").isVisible()

    if (!isEmpty) {
      // If not empty, Frappe Gantt should have rendered SVG content
      const svg = ganttChart.locator("svg")
      await expect(svg).toBeAttached({ timeout: 5000 })

      // Should have at least one bar element
      const bars = ganttChart.locator(".bar-wrapper")
      const barCount = await bars.count()
      expect(barCount).toBeGreaterThan(0)
    }
  })

  test("view mode selector is present when chart is active", async ({ page }) => {
    const ganttChart = page.locator("#gantt-chart")
    const isEmpty = await page.locator("#timeline-empty").isVisible()

    if (!isEmpty) {
      // Frappe Gantt's view mode selector should render
      const viewSelect = ganttChart.locator(".gantt-container")
      await expect(viewSelect).toBeVisible({ timeout: 5000 })
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

    await page.goto("/tasks#timeline")
    await page.waitForLoadState("networkidle")
    await page.waitForTimeout(2000) // Allow chart to initialize

    expect(errors).toHaveLength(0)
  })
})
