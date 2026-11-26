import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { expect } from "@playwright/test"
import { test } from "../helpers/stored-assignee-fixture"
import { shouldSkipBrowserSpecs } from "./_helpers"
import { expectVisibleFocusRing } from "../helpers/focus-ring"
import { moveCardToLane } from "../helpers/kanban-drag"

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

  test("RICE grouping puts scored and unscored cards in their real swimlanes", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const ids: string[] = []
    try {
      for (const [group, rice] of [
        ["high", { reach: 10, impact: 3, confidence: 100, effort: 1 }],
        ["medium", { reach: 4, impact: 3, confidence: 100, effort: 1 }],
        ["low", { reach: 2, impact: 2, confidence: 90, effort: 1 }],
        ["none", null],
      ] as const) {
        const created = await request.post("/api/tasks", {
          headers,
          data: { title: `RICE fixture: ${group}`, status: "pending", ...(rice ? { framework_payload: { rice } } : {}) },
        })
        expect(created.status()).toBe(201)
        const { id } = await created.json()
        ids.push(id)
      }
      await page.goto("/tasks?area=&groupBy=rice#kanban")
      for (const [index, group] of ["high", "medium", "low", "none"].entries()) {
        await expect(page.locator(`[data-swimlane-type="${group}"] .kanban-card[data-id="${ids[index]}"]`)).toBeVisible()
      }
    } finally {
      await Promise.all(ids.map(id => request.delete(`/api/tasks/${id}`, { headers })))
    }
  })

  test("search launcher opens SearchHub and Assist remains available", async ({ page }) => {
    await expect(page.locator("#ask-ha-btn")).toBeVisible()
    await page.locator("#kanban-bar-search-launcher").click()

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
  })

  test("card previews show plain text for descriptions saved in Details", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const create = await request.post("/api/tasks", { headers, data: { title: "Check the supply controller", description: "Original description." } })
    expect(create.status()).toBe(201)
    const { id } = await create.json()
    try {
      await page.reload()
      const card = page.locator(`.kanban-card[data-id="${id}"]`)
      await card.locator(".card-open-btn").click()
      await expect(page.locator("#td-status")).toBeEnabled()
      await page.locator("#td-desc-preview-container").click()
      await page.getByRole("tab", { name: "Markdown", exact: true }).click()
      await page.locator("#td-description").fill("Check **replacement controller**. Read [the manual](https://example.com/).")
      const saved = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/tasks/${id}`)
      await page.locator("#td-desc-save-btn").click()
      expect((await saved).ok()).toBe(true)
      await page.goto("/tasks#kanban")
      await expect(card.locator(".kanban-card-desc")).toHaveText("Check replacement controller. Read the manual.")
      for (const [description, preview] of [
        ["<table><tr><td>Morning</td><td>Meeting</td></tr></table>", "Morning Meeting"],
        ["- Collect the supplies", "Collect the supplies"],
      ] as const) {
        const update = await request.put(`/api/tasks/${id}`, { headers, data: { description } })
        expect(update.ok()).toBe(true)
        await page.reload()
        await expect(card.locator(".kanban-card-desc")).toHaveText(preview)
      }
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("card names include the key and only the newest quick action accepts input", async ({ page, request, baseURL }) => {
    const title = "Check kitchen tap"
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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

  test("retains the assigned Home Assistant identity when its directory cannot verify it", async ({
    assigneeFixture: { page, request, headers, setStoredAssignee },
  }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const idFromHa = "ha_0123456789abcdef0123456789abcdef"
    await page.addInitScript(() => {
      localStorage.setItem("meitheal-theme", "knight-rider")
      localStorage.setItem("meitheal-accent-color", "#000000")
    })
    const response = await request.post("/api/tasks", { headers, data: {
      title: "Check assignee availability",
    } })
    expect(response.status()).toBe(201)
    const { id } = await response.json()
    setStoredAssignee(id, idFromHa)
    const olderUser = { id: "ha_old_account", name: "A cached Home Assistant user" }
    const currentUser = { id: idFromHa, name: "Home Assistant housemate" }
    const localUser = { id: "local_account", name: "Custom assignee" }
    let directoryMode: "verified" | "stale" | "failed" = "stale"
    let resolveDirectory: () => void = () => {}
    const heldDirectory = new Promise<void>(resolve => { resolveDirectory = resolve })
    let holdRetry = false
    await page.route("**/api/users", async route => {
      if (holdRetry) await heldDirectory
      if (directoryMode === "failed") return route.fulfill({ status: 503, json: { error: "Unavailable" } })
      return route.fulfill({ json: {
        users: directoryMode === "verified" ? [olderUser, localUser, currentUser] : [olderUser, localUser],
        ha_connected: true, ha_roster_verified: directoryMode === "verified",
      } })
    })
    const card = page.locator(`.kanban-card[data-id="${id}"]`)
    const selected = page.locator("#td-assigned-to option:checked")
    try {
      await page.goto("/tasks")
      await expect(card.locator("[data-task-assignee]")).toHaveText("Home Assistant assignee not verified")
      await card.locator(".card-open-btn").click()
      await expect(selected).toHaveText("Home Assistant assignee not verified")
      await expect(selected).toHaveAttribute("value", idFromHa)

      directoryMode = "failed"
      await page.goto("/tasks")
      await expect(card.locator("[data-task-assignee]")).toHaveText("Could not load assignee")
      const trigger = card.locator(".card-assign-btn")
      await trigger.press("Enter")
      const dialog = page.getByRole("dialog", { name: "Assign User" })
      const retry = dialog.getByRole("button", { name: "Retry" })
      await expect(retry).toBeFocused()
      await expectVisibleFocusRing(retry)
      directoryMode = "stale"
      await retry.press("Enter")
      await expect(dialog).toContainText("Home Assistant assignee not verified")

      holdRetry = true
      directoryMode = "failed"
      await retry.press("Enter")
      await expect(dialog.getByRole("status")).toHaveText("Checking assignees…")
      await expect(retry).toHaveAttribute("aria-disabled", "true")
      await expect(dialog.getByRole("menuitem", { name: olderUser.name })).toBeEnabled()
      const localChoice = dialog.getByRole("menuitem", { name: localUser.name })
      await localChoice.focus()
      await expect(localChoice).toBeFocused()
      holdRetry = false
      resolveDirectory()
      await expect(dialog.getByRole("status")).toHaveText("Could not load assignees")
      await expect(localChoice).toBeFocused()

      await page.keyboard.press("Escape")
      await expect(trigger).toBeFocused()

      directoryMode = "verified"
      await card.locator(".card-open-btn").click()
      await expect(selected).toHaveText(currentUser.name)
      await page.keyboard.press("Escape")
      await expect(page.locator("#task-detail-overlay")).toBeHidden()

      directoryMode = "failed"
      await card.locator(".card-open-btn").click()
      await expect(selected).toHaveText("Could not load assignee")
      await expect(selected).toHaveAttribute("value", idFromHa)
      await expect(page.locator(`#td-assigned-to option[value="${olderUser.id}"]`)).toHaveCount(0)
      await page.keyboard.press("Escape")
      await card.locator(".card-color-btn").press("Enter")
      const blue = page.getByRole("radio", { name: "Set color: Blue" })
      await blue.focus()
      await expectVisibleFocusRing(blue)
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("offers a retry when an empty assignment directory is unverified", async ({ page, request }) => {
    const headers = await currentBoardWriteHeaders(request, "household", {})
    const created = await request.post("/api/tasks", { headers, data: { title: "Check empty assignment directory" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    let verified = false
    try {
      await page.reload()
      const trigger = page.locator(`.kanban-card[data-id="${id}"] .card-assign-btn`)
      await trigger.press("Enter")
      const dialog = page.getByRole("dialog", { name: "Assign User" })
      const retry = dialog.getByRole("button", { name: "Retry" })
      await expect(dialog).toContainText("No users configured")
      await expect(retry).toHaveCount(0)
      await page.keyboard.press("Escape")
      await page.route("**/api/users", route => route.fulfill({ json: {
        users: [], ha_connected: true, ha_roster_verified: verified,
      } }))
      await page.reload()
      await trigger.press("Enter")
      await expect(dialog).toContainText("Home Assistant assignees could not be verified")
      await expect(dialog.getByText("No users configured")).toHaveCount(0)
      await expect(retry).toBeFocused()

      verified = true
      await retry.press("Enter")
      await expect(dialog).toContainText("No users configured")
      await expect(retry).toHaveCount(0)
      await page.keyboard.press("Escape")
      await expect(trigger).toBeFocused()
    } finally {
      await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("color saves keep focus on the card during the request and after refresh", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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

  test("Manage Swimlanes labels stay on the board and lane controls still work", async ({ page }) => {
    const lanes = [
      { id: "fixture-pending", key: "pending", label: "Todo", builtIn: true, position: 0, wip_limit: 0 },
      { id: "fixture-review", key: "review", label: "Review", builtIn: false, position: 1, wip_limit: 0 },
    ]
    await page.route("**/api/lanes", route => route.fulfill({ json: { lanes } }))
    await page.route("**/api/lanes/fixture-pending", route => {
      Object.assign(lanes[0]!, route.request().postDataJSON())
      return route.fulfill({ json: lanes[0] })
    })

    const boardUrl = page.url()
    await page.locator("#manage-lanes-btn").click()
    const panel = page.getByRole("dialog", { name: "Manage Swimlanes" })
    const lane = panel.getByRole("row").filter({ hasText: "Todo" })
    const label = lane.getByText("Todo", { exact: true })
    await expect(label).toBeVisible()
    // The global task detail handler cancels activation for task rows.
    expect(await label.evaluate(node => node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })))).toBe(true)
    await label.click()
    await lane.getByText("status: pending", { exact: true }).click()
    await expect(page).toHaveURL(boardUrl)
    await expect(panel).toBeVisible()

    const drag = lane.getByRole("button", { name: "Reorder Todo" })
    const reordered = page.waitForRequest(request => request.method() === "PUT" && request.url().endsWith("/api/lanes"))
    await drag.press("Alt+ArrowDown")
    expect((await reordered).postDataJSON()).toEqual({ ordered_ids: ["fixture-review", "fixture-pending"] })
    await expect(drag).toBeFocused()

    const colorChanged = page.waitForRequest(request => request.method() === "PUT" && request.url().endsWith("/api/lanes/fixture-pending"))
    await lane.getByLabel("Color for Todo").fill("#2563eb")
    expect((await colorChanged).postDataJSON()).toEqual({ color: "#2563eb" })

    const wip = lane.getByRole("spinbutton", { name: "WIP limit for Todo" })
    const wipChanged = page.waitForRequest(request => request.method() === "PUT" && request.url().endsWith("/api/lanes/fixture-pending"))
    await wip.fill("3")
    await wip.press("Tab")
    expect((await wipChanged).postDataJSON()).toEqual({ wip_limit: 3 })

    await lane.getByRole("button", { name: "Rename Todo" }).click()
    const alias = page.getByRole("dialog", { name: "Alias Built-in Lane" }).getByRole("textbox")
    await expect(alias).toHaveValue("Todo")
    await alias.fill("Ready")
    await alias.press("Enter")
    await expect(panel.getByText("Ready", { exact: true })).toBeVisible()
    await expect(page).toHaveURL(boardUrl)
  })

  test("custom lane labels remain text in the management panel", async ({ page }) => {
    const label = 'Review " data-lane-injection="yes <img data-lane-injection>'
    await page.route("**/api/lanes", route => route.fulfill({
      json: { lanes: [{ id: "fixture", key: "fixture", label, builtIn: false, position: 1, wip_limit: 0 }] },
    }))

    await page.locator("#manage-lanes-btn").click()

    const lane = page.locator('#lane-list .lane-item[data-lane-id="fixture"]')
    await expect(lane.locator(".lane-visual-label")).toHaveText(label)
    await expect(lane.getByRole("button", { name: `Rename ${label}`, exact: true })).toHaveAttribute("data-label", label)
    await expect(page.locator("#lane-list [data-lane-injection]")).toHaveCount(0)
  })

  test("named Board card field choices work at every size and after reload", async ({ page, request, baseURL }) => {
    const origin = new URL(baseURL!).origin
    const headers = await currentBoardWriteHeaders(request, "household", { origin })
    const created = await request.post("/api/boards", { headers, data: { name: "Card Fields Board" } })
    expect(created.status()).toBe(201)
    const { id: boardId } = await created.json()
    const scoped = await currentBoardWriteHeaders(request, boardId, { origin })
    const taskIds: string[] = []
    try {
      const extraFields = Array.from({ length: 9 }, (_, i) => ({ name: `Extra field ${i + 1}`, type: "text" }))
      const definitions = await request.put("/api/custom-fields", {
        headers: scoped,
        data: { fields: [{ name: "Reviewed", type: "checkbox" }, { name: "Missing", type: "text" }, ...extraFields] },
      })
      expect(definitions.status()).toBe(200)
      for (const data of [{
        title: "Populated card field fixture",
        description: "Visible description",
        labels: ["Fixture label"],
        framework_payload: { rice: { reach: 10, impact: 2, confidence: 80, effort: 4, confidence_unit: "percent" } },
        custom_fields: {
          ...Object.fromEntries(extraFields.map(({ name }) => [name, "Extra value"])),
          Sprint: "S8",
          story_points: 0,
          reviewed: true,
          "Imported note": "Legacy value",
        },
      }, { title: "Empty card field fixture" }]) {
        const result = await request.post("/api/tasks", { headers: scoped, data })
        expect(result.status()).toBe(201)
        taskIds.push((await result.json()).id)
      }

      const board = page.locator("#kanban-board")
      const card = (id: string) => board.locator(`.kanban-card[data-id="${id}"]`)
      const populated = card(taskIds[0]!)
      const empty = card(taskIds[1]!)
      const picker = page.getByRole("region", { name: "Card Customization" })
      await page.goto(`/boards/${boardId}?view=kanban#kanban`)
      await page.locator("#toggle-fields-btn").click()
      for (const field of ["Description", "Labels", "RICE Score", "Sprint", "Story points", "Reviewed", "Missing"]) {
        await expect(picker.getByRole("checkbox", { name: field, exact: true })).toBeChecked()
      }
      const padding: number[] = []
      for (const size of ["compact", "comfortable", "spacious"]) {
        await picker.locator(`[data-density="${size}"]`).click()
        await expect(board).toHaveClass(new RegExp(`density-${size}`))
        for (const field of ["Visible description", "Fixture label", "RICE: 4", "Sprint: S8", "Story points: 0", "Reviewed: Yes", "Imported note: Legacy value"]) {
          await expect(populated.getByText(field, { exact: true })).toBeVisible()
        }
        await expect(populated.getByText(/^Missing:/)).toHaveCount(0)
        await expect(empty.locator(".kanban-card-desc, .label-badges, .kanban-rice-badge, .kanban-cf-chip")).toHaveCount(0)
        padding.push(await populated.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingTop)))
      }
      expect(padding[0]!).toBeLessThan(padding[1]!)
      expect(padding[1]!).toBeLessThan(padding[2]!)

      await picker.locator('[data-density="compact"]').click()
      await picker.getByRole("checkbox", { name: "Missing", exact: true }).uncheck()
      await picker.getByRole("checkbox", { name: "Extra field 9", exact: true }).check()
      await picker.getByRole("checkbox", { name: "Description", exact: true }).uncheck()
      await expect(populated.getByText("Extra field 9: Extra value", { exact: true })).toBeVisible()
      await expect(populated.getByText("Imported note: Legacy value", { exact: true })).toBeHidden()
      await expect(populated.getByText("Visible description", { exact: true })).toBeHidden()
      await page.reload()
      await expect(board).toHaveClass(/density-compact/)
      await expect(populated.getByText("Extra field 9: Extra value", { exact: true })).toBeVisible()
      await expect(populated.getByText("Visible description", { exact: true })).toBeHidden()
      await page.locator("#toggle-fields-btn").click()
      await picker.getByRole("button", { name: "Reset Defaults" }).click()
      await expect(board).toHaveClass(/density-comfortable/)
      await expect(populated.getByText("Visible description", { exact: true })).toBeVisible()
      await expect(populated.getByText("Extra field 9: Extra value", { exact: true })).toBeHidden()
    } finally {
      await Promise.all(taskIds.map(id => request.delete(`/api/tasks/${id}`, { headers: scoped })))
      const current = await request.get(`/api/boards/${boardId}`, { headers: scoped })
      const { board: { revision } } = await current.json()
      const retired = await request.patch(`/api/boards/${boardId}`, { headers: scoped, data: { action: "retire", revision } })
      expect(retired.status()).toBe(200)
    }
  })

  test("mobile keeps task sub-view pills reachable by touch", async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 932 })
    await page.goto("/tasks?view=kanban#kanban")
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
    await expect(types).toHaveCount(6)
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

  test("quick actions stay reachable below card details at narrow and desktop widths", async ({ page, request, baseURL }) => {
    const title = "Kanban fixture with a long household task title that wraps onto multiple lines"
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
      // Offscreen cards reserve space before their controls are laid out.
      await card.scrollIntoViewIfNeeded()
      await expect(card).toBeInViewport()
      await expect(card).toHaveCSS("opacity", "1")
      await expect(card.locator(".kanban-title-text")).toHaveText(title)
      // With a fine pointer, quick actions keep their room and appear on hover or keyboard focus.
      await card.hover()
      await expect(actions).toHaveCSS("opacity", "1")
      await expect(actions).toHaveCSS("pointer-events", "auto")
      await expect(actions).toHaveCSS("transition-duration", "0s")
      await expect.poll(hasRoom).toBe(true)

      await page.setViewportSize({ width: 1440, height: 900 })
      await page.mouse.move(0, 0)
      await expect(actions).toHaveCSS("opacity", "0")
      await expect.poll(hasRoom).toBe(true)
      await card.locator(".card-open-btn").focus()
      await expect(actions).toHaveCSS("opacity", "1")
      await expect(actions).toHaveCSS("pointer-events", "auto")
      await page.keyboard.press("Tab")
      const more = card.getByRole("button", { name: `Task actions for ${title}` })
      await expect(more).toBeFocused()
      await page.keyboard.press("Tab")
      const promote = card.locator(".kanban-promote-star")
      await expect(promote).toHaveAccessibleName(`Promote to top: ${title}`)
      await expect(promote).toBeFocused()
      await expect(actions).toHaveCSS("opacity", "1")
      await expect(actions).toHaveCSS("pointer-events", "auto")
      await expect.poll(hasRoom).toBe(true)
      await promote.blur()
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
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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

      await moveCardToLane(page, card, pending)
      await expect(pending.locator(card)).toBeVisible()
      expect((await (await request.get(taskUrl)).json()).status).toBe("pending")
    } finally {
      await request.delete(taskUrl, { headers })
      await request.delete(`/api/areas/${areaId}`, { headers })
    }
  })

  test("filters by the selected area and retries capture without losing focus or text", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
