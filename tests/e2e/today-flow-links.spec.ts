/**
 * Today Page Flow & Integration E2E Tests
 *
 * Tests the Today page's flow section links correctly point to parent
 * pages with hash anchors, and that the new Progress flow card is present.
 *
 * @domain navigation
 * @phase 15 — Hierarchy Architecture Overhaul
 */
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Today Page — Flow Section (Phase 15)", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  test("flow section renders all 5 handoff cards", async ({ page }) => {
    const flowGrid = page.locator(".page-flow-grid")
    await expect(flowGrid).toBeVisible()

    const cards = flowGrid.locator(".page-flow-card")
    await expect(cards).toHaveCount(5)
  })

  test("calendar flow card links to /boards/household?view=calendar#calendar", async ({ page }) => {
    const calendarCard = page.locator(".page-flow-card[href='/boards/household?view=calendar#calendar']")
    await expect(calendarCard).toBeVisible()
    await expect(calendarCard).toContainText("Calendar")
  })

  test("eisenhower flow card links to /planning?board_id=household#eisenhower", async ({ page }) => {
    const eisenhowerCard = page.locator(".page-flow-card[href='/planning?board_id=household#eisenhower']")
    await expect(eisenhowerCard).toBeVisible()
    await expect(eisenhowerCard).toContainText("Eisenhower")
  })

  test("kanban flow card links to /boards/household#kanban", async ({ page }) => {
    const kanbanCard = page.locator(".page-flow-card[href='/boards/household#kanban']")
    await expect(kanbanCard).toBeVisible()
    await expect(kanbanCard).toContainText("Kanban")
  })

  test("progress flow card links to /progress?board_id=household#routines", async ({ page }) => {
    const progressCard = page.locator(".page-flow-card[href='/progress?board_id=household#routines']")
    await expect(progressCard).toBeVisible()
    await expect(progressCard).toContainText("Progress")
  })

  test("flow section has inline helper", async ({ page }) => {
    const helper = page.locator("[data-helper-id='today-flow-explainer']")
    await expect(helper).toBeVisible()
    await expect(helper).toHaveClass(/inline-helper--tip/)
  })
})
