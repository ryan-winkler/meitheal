import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Calendar Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/calendar")
    await page.waitForLoadState("networkidle")
  })

  test("legacy route opens Calendar and a keyboard user can inspect a day", async ({ page }) => {
    await expect(page).toHaveURL(/\/tasks\?view=calendar#calendar$/)
    await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible()
    const views = page.getByRole("navigation", { name: "Task views" })
    await expect(views.getByRole("link", { name: "Calendar" })).toHaveAttribute("aria-current", "page")

    await page.locator('.cal-cell[data-date]:not(.cal-other)').first().press("Enter")

    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
  })

  test("day drawer shows only tasks due that day with their shared status labels", async ({ page, request }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

    const cells = page.locator(".cal-cell[data-date]:not(.cal-other)")
    const day = await cells.first().getAttribute("data-date")
    const otherDay = await cells.nth(1).getAttribute("data-date")
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(otherDay).toMatch(/^\d{4}-\d{2}-\d{2}$/)

    const complete = await request.post("/api/tasks", {
      data: { title: "Calendar completed task", status: "complete", due_date: day },
    })
    expect(complete.status(), await complete.text()).toBe(201)
    const active = await request.post("/api/tasks", {
      data: { title: "Calendar active task", status: "active", due_date: day },
    })
    expect(active.status(), await active.text()).toBe(201)
    const other = await request.post("/api/tasks", {
      data: { title: "Calendar task on another day", status: "pending", due_date: otherDay },
    })
    expect(other.status(), await other.text()).toBe(201)

    await cells.first().press("Enter")

    const drawer = page.locator("#day-drawer-tasks")
    const completeRow = drawer.locator("[data-task-id]").filter({ hasText: "Calendar completed task" })
    await expect(completeRow).toContainText("Done")
    await expect(completeRow.locator(".day-drawer-item-icon")).toHaveText("✅")
    const activeRow = drawer.locator("[data-task-id]").filter({ hasText: "Calendar active task" })
    await expect(activeRow).toContainText("In Progress")
    await expect(activeRow.locator(".day-drawer-item-icon")).toHaveText("⚡")
    await expect(drawer.getByText("Calendar task on another day")).toHaveCount(0)
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.getByRole("button", { name: "Search Meitheal…" }).click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("day drawer add-task handoff opens the shared task modal", async ({ page }) => {
    await page.locator('.cal-cell[data-date]:not(.cal-other)').first().click()

    await expect(page.locator("#day-drawer")).toHaveAttribute("aria-hidden", "false")
    await page.locator("#day-drawer-add-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("view links preserve query string when switching routes", async ({ page }) => {
    await page.goto("/calendar?status=active&priority=1")
    await page.waitForLoadState("networkidle")

    const table = page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Table" })
    await table.click()

    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1&view=table#table$/)
    await expect(table).toHaveAttribute("aria-current", "page")
  })
})
