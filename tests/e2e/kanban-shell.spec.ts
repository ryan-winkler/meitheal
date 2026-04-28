import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Shell (Kanban)", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/tasks")
    await page.waitForLoadState("networkidle")
    await expect(page).toHaveURL(/\/tasks#kanban$/)
  })

  test("fields toolbar opens the card customizer without leaving Kanban", async ({ page }) => {
    const panel = page.locator("#kanban-fields-panel")

    await expect(panel).toHaveClass(/hidden/)
    await page.locator("#toggle-fields-btn").click()
    await expect(panel).not.toHaveClass(/hidden/)
    await expect(page).toHaveURL(/\/tasks#kanban$/)
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#kanban-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("manage lanes opens the lane management panel", async ({ page }) => {
    const panel = page.locator("#lane-mgmt")

    await expect(panel).toHaveClass(/hidden/)
    await page.locator("#manage-lanes-btn").click()
    await expect(panel).not.toHaveClass(/hidden/)

    await page.locator("#lane-mgmt-close").click()
    await expect(panel).toHaveClass(/hidden/)
  })

  test("compact card density applies to rendered card class names", async ({ page }) => {
    const board = page.locator(".kanban-board")

    await page.locator("#toggle-fields-btn").click()
    await expect(page.locator("#kanban-fields-panel")).not.toHaveClass(/hidden/)
    await page.locator('.card-density-btn[data-density="compact"]').click()

    await expect(board).toHaveClass(/density-compact/)
    await page.evaluate(() => {
      const boardEl = document.querySelector(".kanban-board")
      if (!boardEl) return
      const card = document.createElement("div")
      card.className = "kanban-card e2e-density-card"
      card.innerHTML = `
        <div class="kanban-card-title">Synthetic task</div>
        <div class="kanban-card-desc">Description should collapse</div>
        <div class="kanban-card-meta">Priority and due date</div>
        <div class="kanban-progress">Progress</div>
        <div class="label-badges">Labels</div>
        <div class="kanban-custom-fields">Custom fields</div>
      `
      boardEl.appendChild(card)
    })

    await expect(page.locator(".e2e-density-card .kanban-card-meta")).toBeHidden()
    await expect(page.locator(".e2e-density-card .kanban-card-desc")).toBeHidden()
    await expect(page.locator(".e2e-density-card .label-badges")).toBeHidden()
  })

  test("mobile keeps task sub-view pills reachable by touch", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto("/tasks")
    await page.waitForLoadState("networkidle")

    const viewPills = page.locator(".unified-bar__view-pills")
    await expect(viewPills).toBeVisible()
    await expect(viewPills.locator(".unified-bar__view-pill")).toHaveCount(4)

    const boxes = await viewPills.locator(".unified-bar__view-pill").evaluateAll((items) =>
      items.map((item) => {
        const rect = item.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      }),
    )

    expect(boxes.every((box) => box.width >= 44 && box.height >= 44)).toBe(true)
  })

  test("view pills preserve query string when switching routes", async ({ page }) => {
    await page.goto("/tasks?status=active&priority=1")
    await page.waitForLoadState("networkidle")
    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1#kanban$/)

    await page.locator('.unified-bar__view-pill[href="#calendar"]').click()

    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1#calendar$/)
  })

  test("/kanban redirects to /tasks", async ({ page }) => {
    const response = await page.goto("/kanban")
    await page.waitForLoadState("networkidle")

    await expect(page).toHaveURL(/\/tasks/)
  })
})
