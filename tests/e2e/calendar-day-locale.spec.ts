import { expect, test } from "@playwright/test"
import { formatCalendarDay } from "../../apps/web/src/lib/calendar-day"

test("calendar dates retain the stored day and reject invalid dates", () => {
  expect(formatCalendarDay("2032-02-29T23:59:59-08:00", "ga", true)).toBe("29 Feabh 2032")
  expect(formatCalendarDay("2031-03-08", "ga")).toBe("8 Márta")
  expect(formatCalendarDay("2031-03-08T00:00:00+13:00", "en", true)).toBe("Mar 8, 2031")
  expect(formatCalendarDay("2031-03-08", "en")).toBe("8 Mar")
  expect(formatCalendarDay("2031-02-29", "ga", true)).toBeUndefined()
  expect(formatCalendarDay(null, "ga")).toBeUndefined()
})

test.describe("Irish calendar dates in the App", () => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  test.use({ locale: "en-US", timezoneId: "America/Los_Angeles", serviceWorkers: "block" })

  test("Triage and Habits honor selected Gaeilge through SSR and client updates", async ({ baseURL, context, page, request }) => {
    const headers = { origin: new URL(baseURL!).origin }
    let backlogId: string | undefined
    let habitId: string | undefined
    let completedId: string | undefined
    try {
      const mode = await request.put("/api/settings", { headers, data: { key: "backlog_mode", value: "visible" } })
      expect(mode.status()).toBe(200)
      const backlog = await request.post("/api/tasks", {
        headers,
        data: { title: "Irish date fixture", status: "backlog", due_date: "2031-03-08T23:59:59-08:00" },
      })
      expect(backlog.status()).toBe(201)
      backlogId = (await backlog.json()).id
      const habit = await request.post("/api/habits", {
        headers, data: { action: "create", name: "Irish habit fixture", cadence: "daily" },
      })
      expect(habit.status()).toBe(201)
      habitId = (await habit.json()).id

      await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
      const triage = await page.goto("/triage")
      expect(await triage?.text()).toContain("Spriocdháta 8 Márta 2031")
      await expect(page.locator(`[data-triage-card="${backlogId}"]`)).toContainText("Spriocdháta 8 Márta 2031")

      const habits = await page.goto("/habits")
      expect(await habits?.text()).toContain("Gan chríochnú fós")
      await expect(page.locator("html")).toHaveAttribute("lang", "ga")
      const card = page.locator(`[data-habit-id="${habitId}"]`)
      await expect(card).toContainText("Gan chríochnú fós")
      const completed = page.waitForResponse(response =>
        new URL(response.url()).pathname === "/api/habits" && response.request().method() === "POST")
      await card.getByRole("button", { name: "Complete Irish habit fixture today" }).click()
      const completion = await completed
      expect(completion.status()).toBe(200)
      completedId = (await completion.json()).taskId

      const habitList = await request.get("/api/habits")
      expect(habitList.status()).toBe(200)
      const updated = (await habitList.json()).habits.find((row: { id: string }) => row.id === habitId)
      const completionDate = new Intl.DateTimeFormat("ga-IE", { month: "short", day: "numeric", timeZone: "UTC" })
        .format(new Date(updated.lastCompletedDate + "T00:00:00Z"))
      const completionText = `Déanta den uair dheireanach ${completionDate}`
      await expect(card).toContainText(completionText)
      const reloaded = await page.reload()
      expect(await reloaded?.text()).toContain(completionText)
      await expect(card).toContainText(completionText)
    } finally {
      if (habitId) {
        const removed = await request.post("/api/habits", { headers, data: { action: "delete", templateId: habitId } })
        expect(removed.status()).toBe(200)
      }
      for (const id of [backlogId, completedId]) {
        if (id) expect((await request.delete(`/api/tasks/${id}`, { headers, data: {} })).status()).toBe(204)
      }
    }
  })
})
