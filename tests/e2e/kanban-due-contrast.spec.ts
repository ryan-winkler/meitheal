import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

for (const [theme, colorScheme] of [["light", "light"], ["dark", "dark"], ["auto", "light"]] as const) {
  test(`Kanban due-today text has sufficient contrast with ${theme} theme and ${colorScheme} system appearance`, async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const dueDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Dublin",
      dateStyle: "short",
    }).format(new Date())
    const created = await request.post("/api/tasks", {
      headers, data: { title: "Due today contrast fixture", due_date: dueDate },
    })
    expect(created.status()).toBe(201)
    const { id } = await created.json()

    try {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" })
      await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)
      await page.goto("/tasks#kanban")
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      const selector = `[data-task-id="${id}"] .kanban-card-due.due-today`
      const due = page.locator(selector)
      await expect(due).toBeVisible()
      await due.evaluate(() => document.fonts.ready.then(() => undefined))

      const result = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze()
      expect(result.violations).toEqual([])
      expect(result.passes.map(({ id }) => id)).toContain("color-contrast")
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })
}
