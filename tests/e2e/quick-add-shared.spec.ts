import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { calendarToday } from "../../apps/web/src/lib/date"
import { shouldSkipBrowserSpecs } from "./_helpers"

function shiftDay(day: string, days: number) {
  const date = new Date(day + "T00:00:00Z")
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

test.describe("Quick add reads the same shorthand on the Dashboard and Today", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  test.use({ timezoneId: "Europe/Dublin" })

  for (const surface of [
    { path: "/", input: "#quick-title", defaultDue: null },
    { path: "/today", input: "#quick-add-input", defaultDue: "today" },
  ] as const) {
    test(`${surface.path} parses date, priority and labels`, async ({ page, request, baseURL }) => {
      const headers = { origin: new URL(baseURL!).origin }
      const today = calendarToday("Europe/Dublin")
      const title = `Call the plumber ${randomUUID().slice(0, 6)}`
      const ids: string[] = []
      try {
        await page.goto(surface.path)
        for (const [text, due] of [
          [`${title} tomorrow p1 #repair`, shiftDay(today, 1)],
          [`${title} plain`, surface.defaultDue ? today : null],
        ] as const) {
          const created = page.waitForResponse(r => new URL(r.url()).pathname === "/api/tasks" && r.request().method() === "POST")
          // Today reloads its list after a create; the Dashboard adds the card in place.
          const reloaded = surface.defaultDue ? page.waitForEvent("load") : null
          await page.locator(surface.input).fill(text)
          await page.locator(surface.input).press("Enter")
          expect((await created).status()).toBe(201)
          // Today reloads after a create, so read the saved task back from the list instead of the response body.
          const list = await (await request.get("/api/tasks?sort=created_at&order=desc&limit=20")).json()
          const task = (Array.isArray(list) ? list : list.tasks).find((row: { id: string; title: string }) =>
            row.title.startsWith(title) && !ids.includes(row.id))
          expect(task, `saved task for "${text}"`).toBeTruthy()
          ids.push(task.id)
          if (text.endsWith("#repair")) {
            expect(task).toMatchObject({ title, due_date: due, priority: 1 })
            expect(JSON.parse(task.labels)).toEqual(["repair"])
          } else {
            expect(task.due_date ?? null).toBe(due)
          }
          await reloaded
        }
      } finally {
        for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
      }
    })
  }
})
