import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Dashboard Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the focused dashboard section", async ({ page }) => {
    const focusTab = page.locator(
      '#dashboard-bar-tabs [data-unified-bar-section="dashboard-open"]',
    )

    await focusTab.click()

    await expect(page).toHaveURL(/#dashboard-open$/)
    await expect(focusTab).toHaveClass(/is-active/)
    await expect(page.locator("#dashboard-open")).toBeVisible()
  })

  test("search launcher opens the global search hub", async ({ page }) => {
    await page.locator("#dashboard-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("new task button opens the shared task modal", async ({ page }) => {
    await page.locator("#dashboard-bar-new-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("achievement badges link to /progress#achievements with hover titles and timed ISO due dates match today", async ({ page, request }) => {
    // Creates a task and relies on the fixture's Europe/Dublin household timezone, so it only
    // runs against the disposable fixture.
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

    // Noon UTC is the same Dublin calendar day in both winter (UTC+0) and summer (UTC+1).
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date())
    const headers = await currentBoardWriteHeaders(request, "household", {})
    const createRes = await request.post("/api/tasks", {
      headers,
      data: { title: "Timed ISO due today task", due_date: `${today}T12:00:00Z` },
    })
    expect(createRes.status()).toBe(201)

    const { id } = await createRes.json()
    expect(typeof id).toBe("string")
    try {
      await page.reload({ waitUntil: "domcontentloaded" })
      const taskRow = page.locator(".dashboard-shell").getByText("Timed ISO due today task").first()
      await expect(taskRow).toBeVisible()
      await expect(page.locator(".dashboard-shell").getByText("Due today").first()).toBeVisible()

      const streakLink = page.locator(".gam-stat--link")
      await expect(streakLink).toHaveAttribute("href", /\/progress#achievements$/)
      await expect(streakLink).toHaveAttribute("title", /.+/)

      const badges = page.locator(".gam-achievement-badge")
      expect(await badges.count()).toBeGreaterThan(0)
      const firstBadge = badges.first()
      await expect(firstBadge).toHaveAttribute("href", /\/progress#achievements$/)
      await expect(firstBadge).toHaveAttribute("title", /—/)
      await expect(firstBadge).toContainText(/\S/)

      await firstBadge.click()
      await expect(page).toHaveURL(/\/progress#achievements$/)
      const achievementsSection = page.locator("#progress-section-achievements")
      await expect(achievementsSection).toBeVisible()
      const card = page.locator(".achievements-tab__achievement-card").first()
      await expect(card).toHaveAttribute("title", /—/)
      await expect(card).toContainText(/\S/)
    } finally {
      await request.delete("/api/tasks/" + encodeURIComponent(id), { headers })
    }
  })
})
