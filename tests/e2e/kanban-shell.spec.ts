import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks Shell (Kanban)", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test.beforeEach(async ({ page }) => {
    await page.goto("/tasks")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await expect(page).toHaveURL(/\/tasks#kanban$/)
  })

  test("fields toolbar opens the card customizer without leaving Kanban", async ({ page }) => {
    const panel = page.locator("#kanban-fields-panel")

    await expect(panel).toHaveClass(/hidden/)
    await page.locator("#toggle-fields-btn").click()
    await expect(panel).not.toHaveClass(/hidden/)
    await expect(page).toHaveURL(/\/tasks#kanban$/)
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#kanban-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("card names include the key and only the newest quick action accepts input", async ({ page, request, baseURL }) => {
    const title = "Check kitchen tap"
    const headers = { origin: new URL(baseURL!).origin }
    const created = await request.post("/api/tasks", { headers, data: { title, priority: 2 } })
    expect(created.status()).toBe(201)
    const { id, ticket_key: key } = await created.json()
    try {
      await page.reload()
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
      const card = page.locator(`.kanban-card[data-id="${id}"]`)
      await expect(card.getByRole("link", { name: `Task: ${title}, Priority: High, ${key}` })).toBeVisible()
      const menus = await card.getByRole("button", { name: `Assign user to: ${title}` }).evaluate(trigger => {
        if (!(trigger instanceof HTMLButtonElement)) throw new Error("Expected the card assignment button")
        trigger.click()
        trigger.click()
        return Array.from(document.querySelectorAll<HTMLElement>(".quick-action-popover"), menu => ({
          inert: menu.inert,
          hidden: menu.getAttribute("aria-hidden"),
        }))
      })
      expect(menus).toEqual([{ inert: true, hidden: "true" }, { inert: false, hidden: null }])
      await expect(page.getByRole("dialog", { name: "Assign User" })).toHaveCount(1)
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("color saves keep focus on the card during the request and after refresh", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const created = await request.post("/api/tasks", { headers, data: { title: "Color focus regression", priority: 2 } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    let release: (() => void) | undefined
    const writes: unknown[] = []
    try {
      await page.reload()
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
      const card = page.locator(`.kanban-card[data-id="${id}"]`)
      const more = card.locator(".card-more-btn")
      await page.route(`**/api/tasks/${id}`, async route => {
        if (route.request().method() === "PUT") {
          writes.push(route.request().postDataJSON())
          await new Promise<void>(resolve => { release = resolve })
        }
        await route.continue()
      })
      await card.hover()
      await card.locator(".card-color-btn").evaluate(trigger => {
        if (!(trigger instanceof HTMLButtonElement)) throw new Error("Expected the card color button")
        const callbacks: FrameRequestCallback[] = []
        const requestFrame = window.requestAnimationFrame
        // Focus a swatch before the opening frame runs.
        window.requestAnimationFrame = callback => callbacks.push(callback)
        try {
          trigger.focus()
          trigger.click()
        } finally {
          window.requestAnimationFrame = requestFrame
        }
        const blue = document.querySelector<HTMLElement>('.quick-action-popover [aria-label="Set color: Blue"]')
        if (!blue) throw new Error("Expected the Blue swatch")
        blue.focus()
        for (const callback of callbacks) callback(performance.now())
      })
      await page.keyboard.press("Enter")
      await expect(card.locator(".card-color-btn")).toBeDisabled()
      await expect(more).toBeFocused()
      await expect.poll(() => Boolean(release)).toBe(true)
      release?.()
      await expect(card.locator(".card-color-btn")).toHaveAttribute("data-color", "#3b82f6")
      expect(writes).toEqual([{ color: "#3b82f6" }])
      await expect(more).toBeFocused()
    } finally {
      release?.()
      await page.unroute(`**/api/tasks/${id}`)
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("manage lanes opens the lane management panel", async ({ page }) => {
    const panel = page.locator("#lane-mgmt")

    await expect(panel).toHaveClass(/hidden/)
    await page.locator("#manage-lanes-btn").click()
    await expect(panel).not.toHaveClass(/hidden/)

    await page.locator("#lane-mgmt-close").click()
    await expect(panel).toHaveClass(/hidden/)
  })

  test("custom lane labels remain text in the management panel", async ({ page }) => {
    const label = 'Review " data-lane-injection="yes <img data-lane-injection>'
    await page.route("**/api/lanes", route => route.fulfill({
      json: { lanes: [{ id: "fixture", label, builtIn: false, position: 1, wip_limit: 0 }] },
    }))

    await page.locator("#manage-lanes-btn").click()

    const lane = page.locator('#lane-list .lane-item[data-id="fixture"]')
    await expect(lane.locator(".lane-item-label")).toContainText(label)
    await expect(lane.getByRole("button", { name: "Rename lane" })).toHaveAttribute("data-label", label)
    await expect(page.locator("#lane-list [data-lane-injection]")).toHaveCount(0)
  })

  test("compact card density applies to rendered card class names", async ({ page }) => {
    const board = page.locator(".kanban-board")

    await page.locator("#toggle-fields-btn").click()
    await expect(page.locator("#kanban-fields-panel")).not.toHaveClass(/hidden/)
    await page.locator('.card-density-btn[data-density="compact"]').click()

    await expect(board).toHaveClass(/density-compact/)
    await page.evaluate(() => {
      const boardEl = document.querySelector(".kanban-board")
      if (!boardEl) return
      const card = document.createElement("div")
      card.className = "kanban-card e2e-density-card"
      card.innerHTML = `
        <div class="kanban-card-title">Synthetic task</div>
        <div class="kanban-card-desc">Description should collapse</div>
        <div class="kanban-card-meta">Priority and due date</div>
        <div class="kanban-progress">Progress</div>
        <div class="label-badges">Labels</div>
        <div class="kanban-custom-fields">Custom fields</div>
      `
      boardEl.appendChild(card)
    })

    await expect(page.locator(".e2e-density-card .kanban-card-meta")).toBeHidden()
    await expect(page.locator(".e2e-density-card .kanban-card-desc")).toBeHidden()
    await expect(page.locator(".e2e-density-card .label-badges")).toBeHidden()
  })

  test("mobile keeps task sub-view pills reachable by touch", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto("/tasks")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")

    const viewPills = page.locator(".unified-bar__view-pills")
    await expect(viewPills).toBeVisible()
    await expect(viewPills.locator(".unified-bar__view-pill")).toHaveCount(4)

    await expect.poll(() => viewPills.locator(".unified-bar__view-pill").evaluateAll((items) =>
      items.map((item) => {
        const { width, height } = item.getBoundingClientRect()
        return width >= 44 && height >= 44
      }),
    )).toEqual([true, true, true, true])
  })

  test("narrow screens keep all task type filters inside the toolbar", async ({ page }) => {
    const toolbar = page.locator("#kanban-filter-bar")
    const types = toolbar.locator(".filter-toolbar__type-btn")
    await expect(types).toHaveCount(4)
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await expect.poll(() => toolbar.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return Array.from(element.querySelectorAll(".filter-toolbar__type-btn")).every(button => {
          const box = button.getBoundingClientRect()
          return box.height >= 44 && box.left >= Math.max(0, bounds.left)
            && box.right <= Math.min(window.innerWidth, bounds.right)
            && button.scrollWidth <= button.clientWidth
        })
      })).toBe(true)
    }
  })

  test("quick actions stay below card details on narrow screens and reveal on desktop", async ({ page, request, baseURL }) => {
    const title = "Kanban fixture with a long household task title that wraps onto multiple lines"
    const headers = { origin: new URL(baseURL!).origin }
    const response = await request.post("/api/tasks", {
      headers,
      data: { title, status: "active", description: "Inspect the spare parts and note any replacements." },
    })
    expect(response.status()).toBe(201)
    const { id } = await response.json()
    try {
      await page.setViewportSize({ width: 320, height: 844 })
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.reload()
      const card = page.locator(`.kanban-card[data-id="${id}"]`)
      const actions = card.locator(".kanban-card-actions")
      const hasRoom = () => card.evaluate(element => {
        const bounds = element.getBoundingClientRect()
        const titleBounds = element.querySelector(".kanban-title-text")!.getBoundingClientRect()
        const description = element.querySelector(".kanban-card-desc")!.getBoundingClientRect()
        const row = element.querySelector(".kanban-card-actions")!
        const rowBounds = row.getBoundingClientRect()
        return titleBounds.bottom <= rowBounds.top && description.bottom <= rowBounds.top &&
          rowBounds.bottom <= bounds.bottom && [...row.querySelectorAll("button")].every(button => {
            const box = button.getBoundingClientRect()
            return box.left >= bounds.left && box.right <= bounds.right && box.bottom <= bounds.bottom
          })
      })
      await expect(card).toBeVisible()
      await expect(card).toHaveCSS("opacity", "1")
      await expect(card.locator(".kanban-title-text")).toHaveText(title)
      await expect(actions).toHaveCSS("opacity", "1")
      await expect(actions).toHaveCSS("pointer-events", "auto")
      await expect(actions).toHaveCSS("transition-duration", "0s")
      await expect.poll(hasRoom).toBe(true)

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.mouse.move(0, 0)
      await expect(actions).toHaveCSS("opacity", "0")
      await expect(actions).toHaveCSS("pointer-events", "none")
      await card.locator(".card-open-btn").focus()
      await page.keyboard.press("Tab")
      const more = card.getByRole("button", { name: `Task actions for ${title}` })
      await expect(more).toBeFocused()
      await expect(actions).toHaveCSS("opacity", "1")
      await expect(actions).toHaveCSS("pointer-events", "auto")
      await expect.poll(hasRoom).toBe(true)
      await more.blur()
      await expect(actions).toHaveCSS("opacity", "0")
      await card.hover()
      await expect(actions).toHaveCSS("opacity", "1")
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("view pills preserve query string when switching routes", async ({ page }) => {
    await page.goto("/tasks?status=active&priority=1")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1#kanban$/)

    await page.locator('.unified-bar__view-pill[data-view-tab="calendar"]').click()

    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1&view=calendar#calendar$/)
  })

  test("/kanban redirects to /tasks", async ({ page }) => {
    await page.goto("/kanban")
    await expect(page).toHaveURL(/\/tasks/)
  })

  test("a denied optional reaction count releases its response body", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const created = await request.post("/api/tasks", { headers, data: { title: "Reaction count cancellation fixture" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      await page.addInitScript(() => {
        const originalFetch = window.fetch.bind(window)
        window.fetch = (input, init) => {
          if (typeof input !== "string" || !new URL(input, location.origin).pathname.endsWith("/api/tasks/reaction-counts")) {
            return originalFetch(input, init)
          }
          const body = new ReadableStream({
            cancel() { document.documentElement.dataset.reactionCountClosed = "true" },
          })
          return Promise.resolve(new Response(body, { status: 403 }))
        }
      })
      await page.reload()
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
      await expect(page.locator("html")).toHaveAttribute("data-reaction-count-closed", "true")
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })
})

test.describe("Kanban card workflows", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("uses the focused card, exposes lane actions and leaves rejected moves in place", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const area = await request.post("/api/areas", { headers, data: { name: "Card workflow fixture area" } })
    expect(area.status()).toBe(201)
    const { id: areaId } = await area.json()
    const created = await request.post("/api/tasks", {
      headers,
      data: { title: "Inspect kitchen smoke alarm", status: "pending", area_id: areaId },
    })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    const taskUrl = `/api/tasks/${id}`
    const active = page.locator('.kanban-column[data-status="active"]')
    const pending = page.locator('.kanban-column[data-status="pending"]')
    const card = page.locator(`.kanban-card[data-id="${id}"]`)

    try {
      await page.goto(`/tasks?area=${areaId}#kanban`)
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
      const open = card.getByRole("link", { name: /^Task: Inspect kitchen smoke alarm,/ })
      await open.press("Enter")
      const detail = page.getByRole("dialog", { name: "Task detail: Inspect kitchen smoke alarm" })
      await expect(detail).toBeVisible()
      await detail.getByRole("button", { name: "Close detail", exact: true }).click()
      await expect(detail).toBeHidden()

      const actions = card.getByRole("button", { name: "Task actions for Inspect kitchen smoke alarm" })
      await actions.press("Enter")
      const menu = page.getByRole("group", { name: "Task actions", exact: true })
      await expect(menu).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(actions).toBeFocused()

      await page.route(`**${taskUrl}`, route => route.request().method() === "PUT"
        ? route.fulfill({ status: 409, json: { blocked_by: [{ id: "blocked-fixture" }] } })
        : route.continue())
      await actions.press("Space")
      await menu.getByRole("button", { name: "In Progress" }).press("Enter")
      await expect(page.getByText("Finish the blocking tasks before moving this one into progress.")).toBeVisible()
      await expect(pending.locator(card)).toBeVisible()
      await page.unroute(`**${taskUrl}`)

      await actions.press("Enter")
      await menu.getByRole("button", { name: "In Progress" }).press("Enter")
      await expect(active.locator(card)).toBeVisible()
      await expect(actions).toBeFocused()
      const saved = await request.get(taskUrl)
      expect((await saved.json()).status).toBe("active")

      await card.dragTo(pending.locator(".kanban-column-header"), {
        sourcePosition: { x: 100, y: 35 },
      })
      await expect(pending.locator(card)).toBeVisible()
      expect((await (await request.get(taskUrl)).json()).status).toBe("pending")
    } finally {
      await request.delete(taskUrl, { headers })
      await request.delete(`/api/areas/${areaId}`, { headers })
    }
  })

  test("filters by the selected area and retries capture without losing focus or text", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const area = await request.post("/api/areas", { headers, data: { name: "Capture fixture area" } })
    expect(area.status()).toBe(201)
    const { id: areaId } = await area.json()
    const outside = await request.post("/api/tasks", { headers, data: { title: "Outside the capture area" } })
    expect(outside.status()).toBe(201)
    const { id: outsideId } = await outside.json()
    let savedId: string | undefined

    try {
      await page.goto("/tasks#kanban")
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
      await page.locator("#area-selector-trigger").click()
      await expect(page.locator("#area-selector-trigger")).toHaveAttribute("aria-expanded", "true")
      await page.locator(`#area-selector-dropdown [data-area-id="${areaId}"]`).click({ timeout: 5000 })
      await expect(page.locator(`.kanban-card[data-id="${outsideId}"]`)).toBeHidden()
      const lane = page.locator('.kanban-column[data-status="pending"]')
      await expect(lane.locator(".kanban-empty")).toBeVisible()
      const add = lane.locator(":scope > .kanban-add-btn")
      await add.click()
      const input = lane.getByRole("textbox", { name: "New task title" })
      await input.press("Enter")
      await expect(lane.getByRole("alert")).toHaveText("Enter a task title.")
      await input.fill("Rinse the boiler filter")
      await page.route("**/api/tasks", route => route.request().method() === "POST"
        ? route.fulfill({ status: 503, json: { error: "Temporary test failure" } })
        : route.continue())
      await input.press("Enter")
      await expect(lane.getByRole("alert")).toContainText("Your title is still here")
      await expect(input).toHaveValue("Rinse the boiler filter")
      await expect(page.locator("#task-detail-overlay")).toBeHidden()
      await page.locator("#area-selector-trigger").focus()
      await expect(input).toBeVisible()
      await page.unroute("**/api/tasks")
      const [response] = await Promise.all([
        page.waitForResponse(res => res.url().endsWith("/api/tasks") && res.request().method() === "POST"),
        input.press("Enter"),
      ])
      expect(response.status()).toBe(201)
      const saved = lane.locator(`.kanban-card[data-area="${areaId}"]`)
        .getByRole("link", { name: /^Task: Rinse the boiler filter,/ })
      await expect(saved).toBeVisible()
      savedId = (await saved.getAttribute("data-id")) ?? undefined
      expect(savedId).toBeTruthy()
      expect((await (await request.get(`/api/tasks/${savedId}`)).json()).area_id).toBe(areaId)
    } finally {
      if (savedId) await request.delete(`/api/tasks/${savedId}`, { headers })
      await request.delete(`/api/tasks/${outsideId}`, { headers })
      await request.delete(`/api/areas/${areaId}`, { headers })
    }
  })
})
