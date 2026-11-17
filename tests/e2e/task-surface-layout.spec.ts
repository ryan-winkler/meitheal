import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")

const themes = ["light", "dark", "knight-rider", "auto", "custom"] as const

for (const theme of themes) {
  test(`Today and Board keep names, dates, and controls readable in ${theme}`, async ({ page, request }, testInfo) => {
    const assignee = `Aleksandra Wiśniewska-Kowalczyk (${theme})`
    const person = await request.post("/api/users/custom", { data: { name: assignee } })
    expect(person.status()).toBe(201)
    const { id: assigneeId } = await person.json()
    const now = new Date()
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", dateStyle: "short" }).format(now)
    const response = await request.post("/api/tasks", { data: {
      title: "Replace the controllers for the greenhouse irrigation system before the next scheduled maintenance",
      description: "<p>Check the <strong>replacement controller</strong> &amp; wiring.</p><p>Keep spare valves ready.</p>",
      due_date: `${date}T20:00:00Z`,
      assigned_to: assigneeId,
      status: "active",
      priority: 1,
      color: "#abc",
    } })
    expect(response.status()).toBe(201)
    const { id } = await response.json()

    try {
      if (theme === "custom") {
        const result = await request.put("/api/settings", { data: {
          key: "custom_theme_css", name: "contrast-fixture.css", value: ":root { --bg-primary: #161616; }",
        } })
        expect(result.ok()).toBe(true)
      } else {
        expect((await request.put("/api/settings", { data: { key: "theme", value: theme } })).ok()).toBe(true)
      }

      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
      await page.setViewportSize({ width: 1680, height: 900 })
      await page.addInitScript(value => {
        localStorage.setItem("meitheal-theme", value)
        localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" }))
      }, theme)
      await page.goto("/settings#look-and-feel-settings")
      await expect(page.locator("#theme-select")).toHaveValue(theme)
      await page.goto("/tasks#kanban")
      const card = page.locator(`.kanban-card[data-id="${id}"]`)
      await expect(card.locator(".kanban-assignee-name")).toHaveText(assignee)
      await expect(card.locator(".kanban-assignee-badge")).toHaveAttribute("title", `Assigned to ${assignee}`)
      await expect(card.locator(".kanban-card-desc")).toHaveText("Check the replacement controller & wiring. Keep spare valves ready.")
      await expect(card.locator(".kanban-card-due")).toHaveCSS("white-space", "nowrap")
      await expect(card.locator(".kanban-card-actions")).toHaveCSS("opacity", "1")
      await expect.poll(() => page.locator("#kanban-shell").evaluate(el => getComputedStyle(el).rowGap)).toBe("12px")
      const bounds = await page.locator("#tasks-filter-row").evaluate(el => {
        const filters = el.querySelector(".filter-toolbar")!.getBoundingClientRect()
        const actions = el.querySelector(".kanban-toolbar-right")!.getBoundingClientRect()
        const headerActions = document.querySelector("#kanban-bar .unified-bar__actions")!.getBoundingClientRect()
        return {
          wraps: actions.top >= filters.bottom,
          gap: actions.left - filters.right,
          alignment: Math.abs(headerActions.right - actions.right),
          headerAbove: headerActions.bottom < actions.top,
        }
      })
      expect(bounds.wraps || bounds.gap >= 0).toBe(true)
      expect(bounds.alignment).toBeLessThanOrEqual(2)
      expect(bounds.headerAbove).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${theme}-board-wide.png`), animations: "disabled" })

      await card.locator(".card-open-btn").click()
      await expect(page.locator("#td-assigned-to")).toHaveValue(assigneeId)
      await expect(page.locator("#td-assigned-to option:checked")).toHaveText(assignee)
      await page.goto("/today")
      await expect(page.locator("#today-bar .unified-bar__tab-icon svg")).toHaveCount(6)
      await expect(page.locator(`.tli[data-id="${id}"] [data-task-assignee]`)).toHaveText(assignee)
      await expect(page.locator("#today-bar .unified-bar__title-icon-emoji")).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath(`${theme}-today-wide.png`), animations: "disabled" })

      await page.setViewportSize({ width: 320, height: 800 })
      const session = await page.context().newCDPSession(page)
      await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
      await page.goto("/today#today-work")
      const row = page.locator(`.tli[data-id="${id}"]`)
      await expect(row.locator("[data-task-assignee]")).toHaveText(assignee)
      await expect(row.locator(".tli__actions")).toHaveCSS("opacity", "1")
      const target = await row.locator(".tli__completion").boundingBox()
      expect(target!.width).toBeGreaterThanOrEqual(44)
      expect(target!.height).toBeGreaterThanOrEqual(44)
      const completeInFocus = page.locator(`.focus-card__complete[data-id="${id}"]`)
      await expect(completeInFocus).toBeVisible()
      const focusTarget = await completeInFocus.boundingBox()
      expect(focusTarget!.width).toBeGreaterThanOrEqual(44)
      expect(focusTarget!.height).toBeGreaterThanOrEqual(44)
      if (theme === "knight-rider") {
        await page.locator("html").evaluate(root => { root.style.fontSize = "200%" })
        const card = page.locator(`.focus-card[data-id="${id}"]`)
        expect(await card.evaluate(el => {
          const edge = el.querySelector(".focus-card__complete")!.getBoundingClientRect().left
          return Array.from(el.querySelectorAll(".focus-card__meta > *"))
            .every(item => item.getBoundingClientRect().right <= edge)
        })).toBe(true)
        await page.locator("html").evaluate(root => { root.style.removeProperty("font-size") })
      }
      expect((await row.locator("[data-task-assignee]").boundingBox())!.width).toBeGreaterThan(64)
      await row.scrollIntoViewIfNeeded()
      if (theme === "light" || theme === "knight-rider") {
        await page.screenshot({ path: testInfo.outputPath(`${theme}-today-mobile.png`), animations: "disabled" })
      }
      await page.goto("/tasks#kanban")
      await card.scrollIntoViewIfNeeded()
      await expect(card.locator(".card-more-btn")).toBeVisible()
      await expect(card.locator(".kanban-assignee-name")).toHaveText(assignee)
      const boardActions = page.getByRole("button", { name: "Board actions" })
      await expect(boardActions).toHaveAttribute("aria-expanded", "false")
      await boardActions.click()
      await expect(page.locator("#kanban-toolbar-actions")).toBeVisible()
      await boardActions.click()
      await card.scrollIntoViewIfNeeded()
      await expect.poll(() => card.evaluate(el => {
        const box = el.getBoundingClientRect()
        const children = el.querySelectorAll(".card-action-btn, .kanban-card-due, .kanban-assignee-badge")
        return Array.from(children).every(child => {
          const bounds = child.getBoundingClientRect()
          return bounds.left >= box.left && bounds.right <= box.right
        })
      })).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`${theme}-board-mobile.png`), animations: "disabled" })
    } finally {
      await request.delete(`/api/tasks/${id}`)
      await request.delete(`/api/users/custom?id=${encodeURIComponent(assigneeId)}`)
    }
  })
}
