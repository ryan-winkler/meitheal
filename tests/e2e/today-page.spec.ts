/**
 * Today Page E2E Tests — Smart Today Maturation (42 gaps)
 *
 * @domain tasks
 * @bounded-context tasks (presentation)
 *
 * Tests cover all waves of the Smart Today page maturation:
 * - Wave 1: List View Feature Parity (G01-G11)
 * - Wave 2: Today-Specific Enhancements (G12-G17, G38-G42)
 * - Wave 3: Enhanced Today (G18-G29)
 * - Wave 4: Advanced Features (G30-G36)
 *
 * @kcs Browser specs require E2E_BASE_URL env var to be set.
 */
import { test, expect } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test("Today refreshes full task counters after an external completion", async ({ page, request, baseURL }) => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  const headers = { origin: new URL(baseURL!).origin, "Content-Type": "application/json" }
  const due_date = new Date().toISOString().slice(0, 10)
  const created = await request.post("/api/tasks", { headers, data: { title: "Today counter fixture", due_date } })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json()

  try {
    await page.clock.install()
    await page.goto("/today")
    const due = page.locator('[data-today-count="dueToday"]')
    const completed = page.locator('[data-today-count="completedToday"]')
    const initialDue = Number(await due.innerText())
    const initialCompleted = Number(await completed.innerText())
    expect(initialDue).toBeGreaterThan(0)

    const change = await request.patch(`/api/tasks/${id}`, { headers, data: { status: "complete" } })
    expect(change.status(), await change.text()).toBe(200)
    expect(typeof (await change.json()).updated_at).toBe("number")
    const polling = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/tasks/today-counts" && response.request().method() === "GET",
    )
    await page.clock.fastForward(30_100)
    const response = await polling
    expect(response.status()).toBe(200)
    expect(response.headers()["cache-control"]).toContain("no-store")
    const counts = await response.json()
    expect(Object.keys(counts).sort()).toEqual(["carriedForward", "completedToday", "completionPercent", "dueToday", "remaining"])
    expect(counts.dueToday).toBe(initialDue - 1)
    expect(counts.completedToday).toBe(initialCompleted + 1)

    await expect(due).toHaveText(String(counts.dueToday))
    await expect(completed).toHaveText(String(counts.completedToday))
    const fill = page.locator(".daily-stats-progress-fill")
    await expect(fill).toHaveAttribute("style", new RegExp(`width: ${counts.completionPercent}%`))
    await page.reload()
    await expect(completed).toHaveText(String(counts.completedToday))
    await expect(fill).toHaveAttribute("style", new RegExp(`width: ${counts.completionPercent}%`))
  } finally {
    const removed = await request.delete(`/api/tasks/${id}`, { headers })
    expect(removed.status(), await removed.text()).toBe(204)
  }
})

test("Today and Dashboard label shared favorites separately from personal pins", async ({ page, request, baseURL }) => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  const headers = { origin: new URL(baseURL!).origin, "Content-Type": "application/json" }
  const title = "Shared favorite fixture"
  const created = await request.post("/api/tasks", { headers, data: { title, is_favorite: true } })
  expect(created.status(), await created.text()).toBe(201)
  const { id } = await created.json()

  try {
    await page.goto("/today")
    const section = page.locator("#section-pinned")
    await expect(section.getByRole("button", { name: "Toggle Shared favorites section" })).toBeVisible()
    await expect(section.locator(".today-section__title")).toContainText("Shared favorites")
    await expect(section.locator(`.tli[data-id="${id}"]`)).toHaveAccessibleName(/in Shared favorites$/)

    await page.goto("/")
    const card = page.locator(".dashboard-card").filter({ has: page.getByText("Favorites", { exact: true }) })
    await expect(card.locator(".card-subtitle")).toHaveText(/^\d+ favorite tasks?$/)
    await expect(card.getByText(title, { exact: true })).toBeVisible()
  } finally {
    const removed = await request.delete(`/api/tasks/${id}`, { headers })
    expect(removed.status(), await removed.text()).toBe(204)
  }
})

test.describe("Today Page — Structure & Sections", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  test("Today page renders with correct title", async ({ page }) => {
    await expect(page).toHaveTitle("Meitheal — Today")
    await expect(page.locator("#today-overview").getByRole("heading", { level: 1 })).toBeVisible()
  })

  test("Daily stats container renders", async ({ page }) => {
    const stats = page.locator("#daily-stats-container")
    await expect(stats).toBeVisible()
  })

  test("Daily stats shows Due Today count", async ({ page }) => {
    const stat = page.locator("#daily-stats .stat-item").first()
    await expect(stat).toBeVisible()
    await expect(stat.locator(".stat-label")).toContainText("Due Today")
  })

  test("Daily stats count newly scheduled and carried-forward tasks", async ({ page, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const headers = { origin, "Content-Type": "application/json" }
    const stats = page.locator("#daily-stats")
    const due = stats.locator(".stat-item").filter({ hasText: "Due Today" }).locator(".stat-value")
    const carried = stats.locator(".stat-item").filter({ hasText: "Carried Fwd" }).locator(".stat-value")
    const initialDue = Number(await due.innerText())
    const initialCarried = Number(await carried.innerText())
    const dates = [
      new Date().toISOString().slice(0, 10),
      new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10),
    ]
    const ids: string[] = []

    try {
      for (const due_date of dates) {
        const result = await request.post("/api/tasks", {
          headers,
          data: { title: "Today summary fixture", due_date },
        })
        expect(result.status(), await result.text()).toBe(201)
        ids.push((await result.json()).id)
      }

      await page.reload()
      await expect(due).toHaveText(String(initialDue + 1))
      await expect(carried).toHaveText(String(initialCarried + 1))
    } finally {
      for (const id of ids) {
        const result = await request.delete(`/api/tasks/${id}`, { headers })
        expect(result.status(), await result.text()).toBe(204)
      }
    }
  })

  test("Quick add form renders", async ({ page }) => {
    const form = page.locator("#quick-add-form")
    await expect(form).toBeVisible()
    await expect(page.locator("#quick-add-input")).toBeVisible()
  })

  test("Due Today section always renders", async ({ page }) => {
    const section = page.locator("#section-today")
    await expect(section).toBeVisible()
  })

  test("+ New Task button renders", async ({ page }) => {
    await expect(page.locator("#today-bar").getByRole("button", { name: "New Task" })).toBeVisible()
  })

  test("Clear Done button renders", async ({ page }) => {
    await expect(page.locator("#clear-completed-btn")).toBeVisible()
  })
})

// ── Wave 1: List View Feature Parity (G01-G11) ──────────────────────────

test.describe("Today Page — Wave 1: Feature Parity", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  // G05: Keyboard navigation
  test("G05: keyboard navigation — j/k keys move focus", async ({ page }) => {
    const tasks = page.locator(".tli")
    const count = await tasks.count()
    if (count < 2) {
      test.skip(true, "Need 2+ tasks to test keyboard nav")
      return
    }
    await page.keyboard.press("j")
    await page.waitForTimeout(100)
    await expect(tasks.first()).toHaveClass(/tli--focused/)
  })

  // G06: Filter bar
  test("G06: filter bar renders with all controls", async ({ page }) => {
    await expect(page.locator("#today-filter-bar")).toBeVisible()
    await expect(page.locator("#today-search")).toBeVisible()
    await expect(page.locator("#today-filter-status")).toBeVisible()
    await expect(page.locator("#today-filter-priority")).toBeVisible()
    await expect(page.locator("#today-filter-rice")).toBeVisible()
    await expect(page.locator("#today-sort")).toBeVisible()
  })

  // G06: Search filter
  test("G06: search filter input accepts text", async ({ page }) => {
    const search = page.locator("#today-search")
    await search.fill("test search")
    await expect(search).toHaveValue("test search")
  })

  // G11: Sort options
  test("G11: sort dropdown has 8 options", async ({ page }) => {
    const options = page.locator("#today-sort option")
    await expect(options).toHaveCount(8)
  })

  // G06: Clear filters button
  test("G06: clear filters button exists", async ({ page }) => {
    await expect(page.locator("#today-clear-filters")).toBeVisible()
  })
})

// ── Wave 2: Today-Specific Enhancements (G12-G17) ────────────────────────

test.describe("Today Page — Wave 2: Today Enhancements", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  // G14: Quick add defaults due_date to today
  test("G14: quick add input has NL-aware placeholder", async ({ page }) => {
    const input = page.locator("#quick-add-input")
    await expect(input).toHaveAttribute("placeholder", /shopping|task/)
  })

  // G15: Carried Forward section
  test("G15: carried forward section exists if overdue tasks present", async ({ page }) => {
    const section = page.locator("#section-carried")
    // Section only renders conditionally — just verify structure if present
    const count = await section.count()
    if (count > 0) {
      await expect(section.locator(".today-section__title")).toContainText("Carried Forward")
    }
  })

  // G38: Habits section
  test("G38: habits section renders when feature enabled", async ({ page }) => {
    const section = page.locator("#section-habits")
    const count = await section.count()
    if (count > 0) {
      await expect(section.locator(".today-section__title")).toContainText("Habits / Routines")
      // Verify habit card structure
      const card = section.locator(".habit-card").first()
      if (await card.count() > 0) {
        await expect(card.locator(".habit-card__icon")).toBeVisible()
        await expect(card.locator(".habit-card__name")).toBeVisible()
        await expect(card.locator(".habit-card__complete")).toBeVisible()
      }
    }
  })

  // G38: Habit complete button
  test("G38: habit complete button has correct initial state", async ({ page }) => {
    const incompleteCard = page.locator(".habit-card:not(.habit-card--done)").first()
    if (await incompleteCard.count() > 0) {
      const btn = incompleteCard.locator(".habit-card__complete")
      await expect(btn).not.toBeDisabled()
      await expect(btn).toContainText("Complete")
    }
  })

  // G38: Completed habit has disabled button
  test("G38: completed habit shows done state", async ({ page }) => {
    const doneCard = page.locator(".habit-card--done").first()
    if (await doneCard.count() > 0) {
      const btn = doneCard.locator(".habit-card__complete")
      await expect(btn).toBeDisabled()
      await expect(btn).toContainText("Done")
    }
  })
})

// ── Wave 2: Calendar & Migration (G27, G28) ──────────────────────────────

test.describe("Today Page — Calendar & Migration", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  // G28: Calendar events section structure
  test("G28: calendar events section HTML exists", async ({ page }) => {
    const section = page.locator("#section-calendar-events")
    // This section starts hidden and is shown by controller
    await expect(section).toHaveCount(1)
    await expect(section.locator("#calendar-events-list")).toHaveCount(1)
    await expect(section.locator("#calendar-events-count")).toHaveCount(1)
  })

  // G27: Migration prompt structure
  test("G27: migration prompt container exists", async ({ page }) => {
    const prompt = page.locator("#migration-prompt")
    await expect(prompt).toHaveCount(1)
  })
})

// ── Wave 3: Enhanced Today (G18-G29) ─────────────────────────────────────

test.describe("Today Page — Wave 3: Enhanced Features", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  // G24: Hash deep-link
  test("G24: hash deep-link scrolls to task", async ({ page }) => {
    // Get first task ID
    const firstTask = page.locator(".tli").first()
    if (await firstTask.count() > 0) {
      const taskId = await firstTask.getAttribute("data-id")
      if (taskId) {
        await page.goto("about:blank")
        await page.goto(`/today#task-${taskId}`)
        await expect(page.locator(`.tli[data-id="${taskId}"]`).first()).toHaveClass(/tli--focused/)
      }
    }
  })

  // G29: Context grouping structure
  test("G29: context group headers render when multiple contexts", async ({ page }) => {
    const headers = page.locator(".context-group-header")
    // Groups only appear when 2+ contexts exist
    const count = await headers.count()
    if (count > 0) {
      expect(count).toBeGreaterThanOrEqual(2)
      await expect(headers.first()).toContainText("@")
    }
  })
})

// ── Wave 4: Advanced Features (G30-G36) ──────────────────────────────────

test.describe("Today Page — Wave 4: Advanced", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  // G35: Effort indicators
  test("G35: effort indicators render on tasks", async ({ page }) => {
    const efforts = page.locator(".tli__effort")
    if (await efforts.count() > 0) {
      await expect(efforts.first()).toContainText(/Deep|Regular|Quick/)
    }
  })

  // G36: Gamification stats
  test("G36: streak stat renders when streak active", async ({ page }) => {
    const streak = page.locator(".stat-streak")
    if (await streak.count() > 0) {
      await expect(streak.locator(".stat-value")).toContainText("🔥")
    }
  })

  test("G36: XP stat renders when points earned", async ({ page }) => {
    const xp = page.locator(".stat-xp")
    if (await xp.count() > 0) {
      await expect(xp.locator(".stat-value")).toContainText("+")
    }
  })

  // G36: Progress bar
  test("G36: daily progress bar renders", async ({ page }) => {
    const track = page.locator(".daily-stats-progress-bar")
    await expect(track).toBeVisible()
    // With no completions the fill intentionally occupies zero width.
    await expect(track.locator(".daily-stats-progress-fill")).toHaveAttribute(
      "style",
      /^width: (?:100|[0-9]{1,2})%/,
    )
  })
})

// ── Section Toggle Behavior ──────────────────────────────────────────────

test.describe("Today Page — Section Toggle", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
    await page.waitForLoadState("networkidle")
  })

  test("sections toggle collapsed on header click", async ({ page }) => {
    const section = page.locator("#section-today")
    const toggle = section.locator(".today-section__toggle")
    await toggle.click()
    await page.waitForTimeout(200)
    await expect(section).toHaveClass(/today-section--collapsed/)

    // Click again to expand
    await toggle.click()
    await page.waitForTimeout(200)
    await expect(section).not.toHaveClass(/today-section--collapsed/)
  })

  test("unscheduled section starts collapsed", async ({ page }) => {
    const section = page.locator("#section-unscheduled")
    if (await section.count() > 0) {
      await expect(section).toHaveClass(/today-section--collapsed/)
    }
  })
})
