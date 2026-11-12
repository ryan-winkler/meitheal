import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { calendarToday } from "../../apps/web/src/lib/date"
import { shouldSkipBrowserSpecs } from "./_helpers"

function shiftDay(day: string, days: number) {
  const date = new Date(day + "T00:00:00Z")
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

test.describe("Launch layout and due-date regressions", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("a first visit follows the system or Home Assistant appearance", async ({ browser }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme })
      const page = await context.newPage()
      await page.goto("/today")
      await expect(page.locator("html")).toHaveAttribute("data-theme", "auto")
      await context.close()
    }
  })

  test("the sidebar never covers page content at tablet and ingress widths", async ({ page }) => {
    for (const width of [800, 1024]) {
      await page.setViewportSize({ width, height: 800 })
      await page.goto("/today")
      const sidebar = await page.locator("#sidebar").boundingBox()
      const main = await page.locator(".main-content").first().boundingBox()
      expect(sidebar, `sidebar at ${width}px`).not.toBeNull()
      expect(main!.x, `content starts after the sidebar at ${width}px`).toBeGreaterThanOrEqual(sidebar!.x + sidebar!.width - 1)
    }
  })

  test("Kanban cards keep their height in a busy lane and overdue counts use calendar days", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
    const prefix = `Launch ${randomUUID().slice(0, 8)}`
    const today = calendarToday("Europe/Dublin")
    const ids: string[] = []
    const create = async (title: string, due_date: string | null) => {
      const response = await request.post("/api/tasks", { headers, data: { title, status: "pending", due_date } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    const overdueCount = async () => {
      await page.goto("/")
      return Number((await page.locator("#stat-overdue .stat-value").innerText()).trim())
    }

    try {
      const before = await overdueCount()
      await create(`${prefix} due today`, today)
      await create(`${prefix} due tomorrow`, shiftDay(today, 1))
      expect(await overdueCount(), "tasks due today or later are not overdue").toBe(before)
      await create(`${prefix} due yesterday`, shiftDay(today, -1))
      expect(await overdueCount(), "a task due yesterday is overdue").toBe(before + 1)

      for (let i = 0; i < 18; i++) await create(`${prefix} lane card ${i}`, null)
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto("/tasks?view=kanban#kanban")
      const card = page.locator(".kanban-card", { hasText: `${prefix} lane card 0` }).first()
      await card.scrollIntoViewIfNeeded()
      const box = await card.boundingBox()
      expect(box!.height, "a card keeps at least its title row and padding").toBeGreaterThan(40)
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
    }
  })
})
