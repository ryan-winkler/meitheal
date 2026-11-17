import { expect, test, type Locator } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")

function badgeContrast(badge: Locator, surfaceSelector: string) {
  return badge.evaluate((element, surfaceSelector) => {
    const context = document.createElement("canvas").getContext("2d")!
    const paint = (color: string) => {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data, value => {
        const fraction = value / 255
        return fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const style = getComputedStyle(element)
    paint(getComputedStyle(element.closest(surfaceSelector)!).backgroundColor)
    const fill = paint(style.backgroundColor)
    const ink = paint(style.color)
    return (Math.max(fill, ink) + 0.05) / (Math.min(fill, ink) + 0.05)
  }, surfaceSelector)
}

test("Knight Rider persists and fills active work and task colors on Today and Board", async ({ page, request }, testInfo) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" })
  const dueDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", dateStyle: "short" }).format(new Date())
  async function create(title: string, status: string, color?: string, rice = 4): Promise<string> {
    const framework_payload = JSON.stringify({ reach: rice, impact: 1, confidence: 1, effort: 1 })
    const response = await request.post("/api/tasks", {
      data: { title, due_date: dueDate, status, color, priority: color || rice > 4 ? 3 : 1, framework_payload },
    })
    expect(response.status()).toBe(201)
    return (await response.json()).id
  }

  const activeId = await create("Review the household plan", "active")
  const coloredId = await create("Update automation notes", "pending", "#21a366")
  const idleId = await create("Review design feedback", "pending")
  const paleId = await create("Prime the new workshop controller", "active", "#fff")
  const mediumId = await create("Check the meter readings", "active", undefined, 10)
  const highId = await create("Send the maintenance schedule", "active", undefined, 16)
  expect((await request.put(`/api/tasks/${paleId}`, { data: {
    checklists: JSON.stringify([{ text: "Check stock", done: true }]),
    custom_fields: JSON.stringify({ Place: "Cabinet" }),
  } })).ok()).toBe(true)
  const themeSelect = page.locator("#theme-select")
  const root = page.locator("html")
  const themeColor = page.locator('meta[name="theme-color"]')
  const accent = page.locator("#accent-color-custom")

  try {
    await page.goto("/settings#look-and-feel-settings")
    await expect(themeSelect).toBeEnabled()
    await expect(themeSelect.locator('option[value="dark"]')).toHaveText("Emerald Isle")
    await themeSelect.selectOption("knight-rider")
    await expect(root).toHaveAttribute("data-theme", "knight-rider")
    await expect(root).toHaveCSS("color-scheme", "dark")
    await expect(themeColor).toHaveAttribute("content", "#131314")
    await expect(accent).toHaveValue("#6495ed")
    const persisted = await request.get("/api/settings?key=theme")
    expect((await persisted.json()).value).toBe("knight-rider")
    const invalid = await request.put("/api/settings", { data: { key: "theme", value: "unknown" } })
    expect(invalid.status()).toBe(400)
    await page.reload()
    await expect(themeSelect).toHaveValue("knight-rider")
    await expect(root).toHaveAttribute("data-theme", "knight-rider")

    await page.locator('.accent-swatch[data-color="#f59e0b"]').click()
    await expect(accent).toHaveValue("#f59e0b")
    await page.locator("#accent-reset").click()
    await expect(accent).toHaveValue("#6495ed")

    await page.evaluate(() => {
      document.addEventListener("astro:after-swap", () => { sessionStorage.setItem("knight-swap", "yes") }, { once: true })
    })
    await page.locator('#sidebar a[href="/today"]').first().click()
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem("knight-swap"))).toBe("yes")
    await expect(root).toHaveAttribute("data-theme", "knight-rider")
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(19, 19, 20)")

    const active = page.locator(`.tli[data-id="${activeId}"]`)
    const colored = page.locator(`.tli[data-id="${coloredId}"]`)
    const idle = page.locator(`.tli[data-id="${idleId}"]`)
    await expect(active).toBeVisible()
    await expect(active).toHaveCSS("border-bottom-color", "rgb(255, 94, 146)")
    await expect(active).toHaveCSS("background-color", "rgb(89, 53, 65)")
    const todayBadge = active.getByText("RICE: 4", { exact: true })
    await expect(todayBadge).toBeVisible()
    expect(await badgeContrast(todayBadge, ".tli")).toBeGreaterThanOrEqual(4.5)
    for (const [id, label] of [[mediumId, "RICE: 10"], [highId, "RICE: 16"]] as const) {
      const badge = page.locator(`.tli[data-id="${id}"]`).getByText(label, { exact: true })
      await expect(badge).toBeVisible()
      expect(await badgeContrast(badge, ".tli")).toBeGreaterThanOrEqual(4.5)
    }
    await expect(idle).toHaveCSS("background-color", /(?:transparent|0\s*\))/)
    await expect(colored.locator(".tli__color")).toBeHidden()
    expect(await colored.evaluate(el => getComputedStyle(el).backgroundColor))
      .not.toBe(await idle.evaluate(el => getComputedStyle(el).backgroundColor))
    await expect(page.locator(`.focus-card[data-id="${activeId}"] .status-badge`)).toHaveText("In Progress")
    await expect(page.locator(`.focus-card[data-id="${activeId}"]`)).toHaveCSS("background-color", "rgb(89, 53, 65)")
    const contrast = await page.evaluate(({ activeId, paleId }) => {
      const ctx = document.createElement("canvas").getContext("2d")!
      const luminance = (color: string) => {
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = color
        ctx.fillRect(0, 0, 1, 1)
        const [red, green, blue] = Array.from(ctx.getImageData(0, 0, 1, 1).data, value => {
          const n = value / 255
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!
      }
      const measure = (surface: HTMLElement, control: HTMLElement, property: string) => {
        const fill = luminance(getComputedStyle(surface).backgroundColor)
        const boundary = luminance(getComputedStyle(control).getPropertyValue(property))
        return (Math.max(fill, boundary) + 0.05) / (Math.min(fill, boundary) + 0.05)
      }
      const row = (id: string) => document.querySelector<HTMLElement>(`#today-due-list .tli[data-id="${CSS.escape(id)}"]`)!
      const focus = document.querySelector<HTMLElement>(`.focus-card[data-id="${CSS.escape(activeId)}"]`)!
      return [row(activeId), row(paleId)].map(surface =>
        measure(surface, surface.querySelector(".tli__checkbox")!, "outline-color"),
      ).concat(measure(focus, focus.querySelector(".focus-card__complete")!, "border-top-color"))
    }, { activeId, paleId })
    for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(3)
    await testInfo.attach("active-control-contrast", { body: JSON.stringify(contrast), contentType: "application/json" })
    await page.locator("#section-today").scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath("knight-rider-today-desktop.png"), animations: "disabled" })

    await page.setViewportSize({ width: 390, height: 844 })
    await active.scrollIntoViewIfNeeded()
    await expect(active).toBeVisible()
    await expect(active).toHaveCSS("border-bottom-color", "rgb(255, 94, 146)")
    await page.screenshot({ path: testInfo.outputPath("knight-rider-today-mobile.png"), animations: "disabled" })

    await expect(active.locator(".tli__title-text")).toHaveCSS("white-space", "normal")
    const completed = active.locator(".tli__checkbox")
    await page.route(`**/api/tasks/${activeId}`, route =>
      route.request().method() === "PUT" ? route.fulfill({ status: 503 }) : route.continue(), { times: 1 })
    await completed.click()
    await expect(completed).not.toBeChecked()
    await expect(active.locator(".status-badge")).toHaveText("In Progress")
    await completed.click()
    await expect(active).not.toHaveAttribute("data-work-active", "")
    await expect(active.locator(".status-badge")).toHaveText("Done")
    await completed.click()
    await expect(active.locator(".status-badge")).toHaveText("Todo")
    expect((await request.put(`/api/tasks/${activeId}`, { data: { status: "active" } })).ok()).toBe(true)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto("/tasks#kanban")
    const card = (id: string) => page.locator(`.kanban-card[data-id="${id}"]`)
    await expect(card(activeId)).toHaveCSS("background-color", "rgb(89, 53, 65)")
    const boardBadge = card(activeId).getByText("RICE: 4", { exact: true })
    await expect(boardBadge).toBeVisible()
    expect(await badgeContrast(boardBadge, ".kanban-card")).toBeGreaterThanOrEqual(4.5)
    await expect(card(coloredId)).toHaveCSS("border-inline-start-width", "1px")
    await expect(card(idleId)).toHaveCSS("background-color", "rgb(36, 36, 36)")
    expect(await card(coloredId).evaluate(el => getComputedStyle(el).backgroundColor))
      .not.toBe(await card(idleId).evaluate(el => getComputedStyle(el).backgroundColor))
    await expect(card(paleId)).toHaveCSS("border-bottom-color", "rgb(255, 94, 146)")
    expect(await card(paleId).evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgb(89, 53, 65)")
    await page.mouse.move(0, 0)
    await card(activeId).locator(".card-open-btn").focus()
    await expect(card(activeId)).toHaveCSS("outline-color", "rgb(166, 192, 249)")
    await page.screenshot({ path: testInfo.outputPath("knight-rider-board.png"), animations: "disabled" })
    await page.emulateMedia({ contrast: "more" })
    await expect.poll(() => root.evaluate(el => getComputedStyle(el).getPropertyValue("--text-muted").trim())).toBe("rgb(215 213 220)")
    await expect.poll(() => root.evaluate(el => getComputedStyle(el).getPropertyValue("--border").trim())).toBe("rgb(119 119 123)")
    await page.emulateMedia({ contrast: "no-preference" })

    await page.evaluate(() => localStorage.setItem("meitheal-appearance", JSON.stringify({ base: "mist" })))
    for (const [path, surface] of [["/today#today-work", ".tli"], ["/tasks#kanban", ".kanban-card"]] as const) {
      await page.goto(path)
      await expect(root).toHaveAttribute("data-appearance-base", "mist")
      const checklist = page.locator(`${surface}[data-id="${paleId}"]`).getByText("✓ 1/1", { exact: true })
      await expect(checklist).toBeVisible()
      expect(await badgeContrast(checklist, surface)).toBeGreaterThanOrEqual(4.5)
      if (surface === ".kanban-card") {
        const field = card(paleId).locator(".kanban-cf-chip").filter({ hasText: "Cabinet" })
        await expect(field).toBeVisible()
        expect(await badgeContrast(field, surface)).toBeGreaterThanOrEqual(4.5)
      } else {
        const task = page.locator(`.tli[data-id="${paleId}"]`)
        const toggle = task.locator(".tli__checkbox")
        await toggle.click()
        const title = task.locator(".tli__title-text")
        await expect(task).toHaveClass(/tli--done/)
        await expect(title).toHaveCSS("opacity", "1")
        expect(await badgeContrast(title, surface)).toBeGreaterThanOrEqual(4.5)
        await expect(task.locator(".status-badge")).toHaveText("Done")
        await toggle.click()
        await expect(task.locator(".status-badge")).toHaveText("Todo")
      }
    }
    await page.evaluate(() => localStorage.removeItem("meitheal-appearance"))

    const favorite = await request.put(`/api/tasks/${coloredId}`, { data: { is_favorite: 1 } })
    expect(favorite.ok()).toBe(true)
    await page.goto("/")
    await page.mouse.move(0, 0)
    const recent = (id: string) => page.locator(`#task-list .dashboard-task-card[data-id="${id}"]`)
    await expect(recent(idleId)).toHaveCSS("border-left-color", "rgb(239, 68, 68)")
    await expect(recent(mediumId)).toHaveCSS("border-left-color", "rgb(234, 179, 8)")
    await expect(recent(coloredId)).toHaveCSS("border-left-width", "1px")
    await recent(idleId).hover()
    await expect(recent(idleId)).toHaveCSS("border-left-color", "rgb(239, 68, 68)")
    const queue = page.locator("#dashboard-open")
    const queueIdle = queue.locator(`.task-item[data-id="${idleId}"]`)
    await expect(queueIdle).toBeVisible()
    const neutral = await queueIdle.evaluate(el => getComputedStyle(el).backgroundColor)
    for (const section of ["#dashboard-open", "#dashboard-momentum"]) {
      const row = page.locator(`${section} .task-item[data-id="${coloredId}"]`)
      await expect(row).toBeVisible()
      await expect(row).toHaveAttribute("data-task-color", "")
      expect(await row.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(neutral)
    }

    await page.goto("/settings#look-and-feel-settings")
    await themeSelect.selectOption("dark")
    await expect(root).toHaveAttribute("data-theme", "dark")
    await page.goto("/tasks#kanban")
    await expect(card(activeId)).toHaveCSS("background-color", "rgb(29, 33, 31)")
    await expect(card(coloredId)).toHaveCSS("border-inline-start-width", "3px")
    await expect(card(coloredId)).toHaveCSS("border-inline-start-color", "rgb(33, 163, 102)")
  } finally {
    for (const id of [activeId, coloredId, idleId, paleId, mediumId, highId]) await request.delete(`/api/tasks/${id}`)
    await request.put("/api/settings", { data: { key: "theme", value: "dark" } })
  }
})


test("Details completion clears Knight Rider active work on Dashboard and Board", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Finish the active card from Details"
  const created = await request.post("/api/tasks", { data: { title, status: "active" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const status = page.locator("#td-status")
  const done = page.locator("#td-toggle-done")
  const close = page.getByRole("button", { name: "Close detail" })
  const card = page.locator(`.kanban-card[data-id="${id}"]`)
  const link = card.locator(".card-open-btn")
  try {
    await page.goto("/")
    const dashboard = page.locator(`#dashboard-recent .bento-card[data-id="${id}"]`)
    const openQueue = page.locator(`#my-open-list [data-id="${id}"]`)
    await expect(dashboard).toHaveAttribute("data-work-active", "")
    await expect(openQueue).toBeVisible()
    const edit = dashboard.getByRole("button", { name: "Edit task" })
    await edit.click()
    await expect(status).toHaveValue("active")
    await done.click()
    await expect(status).toHaveValue("complete")
    await expect(dashboard).not.toHaveAttribute("data-work-active", "")
    await expect(dashboard.locator(".task-badge")).toHaveText("Done")
    await expect(openQueue).toBeHidden()
    await expect(page.locator("#my-open-empty")).toHaveText("No open tasks for this selection.")
    await close.click()
    await expect(edit).toBeFocused()

    await page.goto("/tasks#kanban")
    await expect(card).toHaveAttribute("data-status", "complete")
    await link.press("Enter")
    await expect(status).toHaveValue("complete")
    await status.selectOption("active")
    await expect(card).toHaveAttribute("data-status", "active")
    await expect(card).toHaveAttribute("data-work-active", "")
    await done.click()
    await expect(card).toHaveAttribute("data-status", "complete")
    await expect(card).not.toHaveAttribute("data-work-active", "")
    await close.click()
    await expect(link).toBeFocused()
  } finally {
    await request.delete(`/api/tasks/${id}`)
  }
})
