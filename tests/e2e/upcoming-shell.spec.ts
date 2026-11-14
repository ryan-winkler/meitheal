import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Upcoming Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/upcoming")
    await page.waitForLoadState("networkidle")
  })

  test("unified bar tabs jump to the week section", async ({ page }) => {
    const weekTab = page.locator(
      '#upcoming-bar-tabs [data-unified-bar-section="upcoming-week"]',
    )

    await weekTab.click()

    await expect(page).toHaveURL(/#upcoming-week$/)
    await expect(weekTab).toHaveClass(/is-active/)
    await expect(page.locator("#upcoming-week")).toBeVisible()
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#upcoming-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("new task button opens the shared task modal", async ({ page }) => {
    await page.locator("#upcoming-bar-new-task").click()

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("task detail and completion work independently across both date windows", async ({ page, request, baseURL, browser }) => {
    const origin = new URL(baseURL!).origin
    const headers = { origin }
    const dayMs = 86_400_000
    const now = Date.now()
    const fixtures = [
      { section: "#upcoming-next", title: "Upcoming controls soon", dueDate: new Date(now + dayMs) },
      { section: "#upcoming-week", title: "Upcoming controls later", dueDate: new Date(now + 3 * dayMs) },
    ] as const
    const ids: string[] = []

    try {
      for (const { title, dueDate } of fixtures) {
        const created = await request.post("/api/tasks", {
          headers,
          data: { title, due_date: dueDate.toISOString().slice(0, 10), status: "pending" },
        })
        expect(created.status(), await created.text()).toBe(201)
        ids.push((await created.json()).id)
      }

      await page.reload()
      await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
      const detail = page.locator("#task-detail-overlay")
      for (const [index, { section, title }] of fixtures.entries()) {
        const id = ids[index]!
        const link = page.locator(section).getByRole("link", { name: title, exact: true })
        const checkbox = page.locator(section).getByRole("checkbox", { name: `Complete ${title}` })
        await expect(link).toHaveAttribute("href", `/tickets/${id}`)
        await checkbox.focus()
        await page.keyboard.press("Tab")
        await expect(link).toBeFocused()
        await expect(link).toHaveCSS("outline-style", "solid")
        await page.keyboard.press("Enter")
        await expect(detail).toHaveAttribute("data-open-task-id", id)
        await expect(detail).toBeVisible()
        await detail.getByRole("button", { name: "Close detail" }).click()
        await expect(detail).toBeHidden()
        await expect(link).toBeFocused()
        await expect(page).toHaveURL(/\/upcoming$/)
      }

      const title = fixtures[0].title
      const firstTaskId = ids[0]!
      const checkbox = page.getByRole("checkbox", { name: `Complete ${title}` })
      const row = page.locator(".task-item").filter({ has: checkbox })
      const priority = row.getByTitle("Priority: Medium")
      await priority.hover({ timeout: 5000 })
      await priority.click()
      await expect(detail).toHaveAttribute("data-open-task-id", firstTaskId)
      await expect(detail).toBeVisible()
      await detail.getByRole("button", { name: "Close detail" }).click()
      await expect(detail).toBeHidden()

      const dayCard = page.locator(".day-card--populated").filter({
        has: page.locator(`a[data-task-detail-link="${firstTaskId}"]`),
      })
      const dayHeader = dayCard.getByRole("button").first()
      const dayLabel = await dayHeader.locator(".day-label").innerText()
      await dayHeader.press("Space")
      await expect(dayHeader).toHaveAttribute("aria-expanded", "false")
      await expect(dayCard.locator(".task-list")).toHaveAttribute("inert", "")
      await page.keyboard.press("Tab")
      await expect.poll(() => dayCard.evaluate(card => card.contains(document.activeElement))).toBe(false)
      await dayHeader.press("Space")
      await expect(dayHeader).toHaveAttribute("aria-expanded", "true")

      const noScript = await browser.newContext({ javaScriptEnabled: false, baseURL: origin })
      try {
        const noScriptPage = await noScript.newPage()
        await noScriptPage.goto("/upcoming")
        await noScriptPage.getByRole("link", { name: title, exact: true }).press("Enter", { timeout: 5000 })
        await expect(noScriptPage).toHaveURL(`${origin}/tickets/${firstTaskId}`)
      } finally {
        await noScript.close()
      }

      const taskPath = `/api/tasks/${firstTaskId}`
      const requestHeld = deferred<void>()
      const releaseFailure = deferred<void>()
      let completionWrites = 0
      await page.route(taskPath, async route => {
        completionWrites++
        requestHeld.resolve()
        await releaseFailure.promise
        await route.fulfill({ status: 503, json: { error: "Fixture unavailable" } })
      })
      try {
        await checkbox.click({ position: { x: 2, y: 2 } })
        await requestHeld.promise
        await expect(checkbox).toHaveAttribute("aria-disabled", "true")
        await page.keyboard.press("Space")
        await expect(checkbox).toBeChecked()
        expect(completionWrites).toBe(1)
      } finally {
        releaseFailure.resolve()
      }
      await expect(page.getByText("Failed to update", { exact: true })).toBeVisible()
      expect(completionWrites).toBe(1)
      await expect(checkbox).not.toBeChecked()
      await expect(checkbox).toBeEnabled()
      await expect(checkbox).toBeFocused()
      await expect(detail).toBeHidden()
      await page.unroute(taskPath)

      async function completeWhileMovingFocus(taskId: string, taskCheckbox: typeof checkbox, moveFocus: () => Promise<void>) {
        const held = deferred<void>()
        const release = deferred<void>()
        const target = `/api/tasks/${taskId}`
        await page.route(target, async route => {
          held.resolve()
          await release.promise
          await route.continue()
        }, { times: 1 })
        try {
          await taskCheckbox.press("Space")
          await held.promise
          await moveFocus()
        } finally {
          release.resolve()
        }
      }

      const firstLink = row.getByRole("link", { name: title })
      await completeWhileMovingFocus(firstTaskId, checkbox, async () => {
        await page.keyboard.press("Tab")
        await expect(firstLink).toBeFocused()
      })
      await expect(row).toHaveCount(0)
      expect((await (await request.get(taskPath)).json()).status).toBe("complete")
      await expect(page.locator(`${fixtures[0].section} .day-header`).filter({ hasText: dayLabel })).toBeFocused()

      const laterCheckbox = page.getByRole("checkbox", { name: `Complete ${fixtures[1].title}` })
      const outside = page.locator("#upcoming-bar-new-task")
      await completeWhileMovingFocus(ids[1]!, laterCheckbox, () => outside.focus())
      await expect(laterCheckbox).toHaveCount(0)
      await expect(outside).toBeFocused()
      await expect(detail).toBeHidden()
      await expect(page).toHaveURL(/\/upcoming$/)
    } finally {
      for (const id of ids) {
        await request.delete(`/api/tasks/${id}`, { headers })
      }
    }
  })

  test("a dense day exposes its final row after keyboard collapse and reopen", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const dueDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const taskCount = 36
    const titlePrefix = "Upcoming dense day fixture"
    const ids: string[] = []

    try {
      for (let index = 1; index <= taskCount; index++) {
        const created = await request.post("/api/tasks", {
          headers,
          data: { title: `${titlePrefix} ${index}`, due_date: dueDate, status: "pending" },
        })
        expect(created.status()).toBe(201)
        ids.push((await created.json()).id)
      }

      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.setViewportSize({ width: 320, height: 860 })
      await page.reload()
      await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")

      const card = page.locator(".day-card--populated").filter({ hasText: `${titlePrefix} 1` })
      const header = card.getByRole("button").first()
      const list = card.locator(".task-list")
      await header.press("Space")
      await expect(header).toHaveAttribute("aria-expanded", "false")
      await expect(list).toHaveAttribute("inert", "")
      await expect(list).toBeHidden()
      await header.press("Enter")
      await expect(header).toHaveAttribute("aria-expanded", "true")
      await expect(list).not.toHaveAttribute("inert", "")
      const dimensions = await list.evaluate(element => ({ height: element.clientHeight, contentHeight: element.scrollHeight }))
      expect(dimensions.height).toBeGreaterThan(2000)
      expect(dimensions.height).toBe(dimensions.contentHeight)

      const lastRow = list.locator(".task-item").last()
      const lastLink = lastRow.getByRole("link")
      const lastId = await lastLink.getAttribute("data-task-detail-link")
      await lastRow.scrollIntoViewIfNeeded()
      await expect(lastLink).toBeInViewport({ ratio: 1 })
      expect(await lastLink.evaluate(element => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return element.contains(document.elementFromPoint(x + width / 2, y + height / 2))
      })).toBe(true)
      await lastRow.getByRole("checkbox").focus()
      await page.keyboard.press("Tab")
      await expect(lastLink).toBeFocused()
      await page.keyboard.press("Enter")
      const detail = page.locator("#task-detail-overlay")
      await expect(detail).toHaveAttribute("data-open-task-id", lastId!)
      await expect(detail).toBeVisible()
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("task controls meet minimum target size with long titles in both themes", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const title = "Upcoming accessibility fixture " + "W".repeat(160)
    const assignee = "custom_household-member"
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const created = await request.post("/api/tasks", {
      headers,
      data: {
        title, due_date: tomorrow, status: "active", assigned_to: assignee,
        color: "#2563eb", recurrence_rule: "FREQ=DAILY",
        checklists: JSON.stringify([{ id: "upcoming-target-step", text: "Review the schedule", done: false }]),
      },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json()

    try {
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => localStorage.setItem("meitheal-theme", value), theme)
        await page.reload()
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        for (const width of [320, 1440]) {
          await page.setViewportSize({ width, height: 860 })
          const link = page.getByRole("link", { name: title, exact: true })
          const checkbox = page.getByRole("checkbox", { name: `Complete ${title}` })
          const avatar = page.getByRole("img", { name: `Assigned to ${assignee}` })
          await avatar.hover({ timeout: 5000 })
          const taskRow = page.locator(".task-item").filter({ has: link })
          await taskRow.scrollIntoViewIfNeeded()
          for (const metadata of [
            taskRow.locator('[data-badge-status="active"]'), taskRow.locator(".task-color-swatch"),
            taskRow.getByTitle("Recurring"), taskRow.getByTitle("Checklist: 0/1"), avatar,
          ]) {
            await expect(metadata).toBeInViewport({ ratio: 1 })
          }
          const row = await taskRow.boundingBox()
          if (!row) throw new Error("The Upcoming task row is outside the rendered layout")
          expect(row.x).toBeGreaterThanOrEqual(0)
          expect(row.x + row.width).toBeLessThanOrEqual(width)
          const measureHitArea = (control: typeof link) => control.evaluate(element => {
            const { left, right, top, bottom, width, height } = element.getBoundingClientRect()
            const cornersHitControl = [left + 2, right - 2].every(x =>
              [top + 2, bottom - 2].every(y => element.contains(document.elementFromPoint(x, y))))
            return { left, right, top, bottom, width, height, cornersHitControl }
          })
          const hitAreas = await Promise.all([measureHitArea(link), measureHitArea(checkbox)])
          for (const area of hitAreas) {
            expect(area.width).toBeGreaterThanOrEqual(44)
            expect(area.height).toBeGreaterThanOrEqual(44)
            expect(area.cornersHitControl).toBe(true)
          }
          const [detailArea, completionArea] = hitAreas
          expect(Math.min(detailArea.right, completionArea.right) <= Math.max(detailArea.left, completionArea.left)
            || Math.min(detailArea.bottom, completionArea.bottom) <= Math.max(detailArea.top, completionArea.top)).toBe(true)
          const { violations } = await new AxeBuilder({ page }).include(".task-item").withRules([
            "nested-interactive", "label-content-name-mismatch", "target-size", "aria-prohibited-attr",
          ]).analyze()
          expect(violations.map(({ id, nodes }) => [id, nodes.map(({ target }) => target)]), `${width}px ${theme}`).toEqual([])
        }
      }
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })
  test("day labels and assignee initials keep AA contrast in both themes", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const created = await request.post("/api/tasks", { headers, data: { title: "Upcoming contrast fixture", due_date: tomorrow, assigned_to: "ha_household" } })
    expect(created.status(), await created.text()).toBe(201)
    const { id } = await created.json()
    try {
      for (const theme of ["light", "dark"]) {
        await page.evaluate(value => localStorage.setItem("meitheal-theme", value), theme)
        await page.reload()
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await expect(page.locator(".day-empty").first()).toBeVisible()
        await expect(page.locator(".avatar").first()).toBeVisible()
        const { violations } = await new AxeBuilder({ page }).include(".upcoming-grid").withRules(["color-contrast"]).analyze()
        expect(violations.flatMap(({ nodes }) => nodes.map(({ target }) => target.join(" "))), theme).toEqual([])
      }
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })
})
