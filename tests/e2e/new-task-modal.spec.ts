import { test, expect } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("New Task Modal", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test.beforeEach(async ({ page }) => {
    await page.goto("/today")
  })

  test("New Task modal opens when + New Task button is clicked", async ({ page }) => {
    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).not.toHaveClass(/active/)

    // Click the "+ New Task" button in the header
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    await expect(overlay).toHaveClass(/active/)
  })

  test("New Task modal has correct accessibility attributes", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()
    const overlay = page.getByRole("dialog", { name: "New Task", exact: true })
    await expect(overlay).toBeVisible()
    await expect(overlay).toHaveAttribute("aria-modal", "true")
    await expect(overlay.getByRole("checkbox", { name: "Mark as Routine" })).toHaveCount(0)
    await expect(overlay.getByRole("button", { name: "Attach file" })).toHaveCount(0)
    await expect(overlay.getByRole("textbox", { name: "Title (required)", exact: true })).toBeVisible()
  })

  test("New Task modal has all required form fields", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    await expect(page.locator("#new-task-title-input")).toBeVisible()
    await expect(page.locator("#new-task-desc-input")).toBeVisible()
    await expect(page.getByRole("combobox", { name: "Priority", exact: true })).toBeVisible()
    await expect(page.locator("#new-task-status")).toHaveValue(/.+/)
    const status = page.getByRole("radiogroup", { name: "Task status" })
    await expect(status.getByRole("radio").first()).toBeVisible()
    await page.locator("#nt-options > summary").click()
    await expect(page.getByRole("combobox", { name: "Repeat", exact: true })).toBeVisible()
    await expect(page.locator("#submit-new-task-btn")).toBeVisible()
    await expect(page.locator("#cancel-new-task")).toBeVisible()
  })

  test("inactive status labels remain fully opaque in Dark and Light", async ({ page }) => {
    for (const theme of ["dark", "light"]) {
      await page.goto("/settings#personal-settings")
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/settings"
        && response.request().method() === "PUT" && response.request().postDataJSON()?.key === "theme")
      await page.locator("#theme-select").selectOption(theme)
      expect((await saved).ok()).toBe(true)
      await page.goto("/today")
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await page.getByRole("button", { name: "New Task", exact: true }).click()
      const statuses = page.getByRole("radiogroup", { name: "Task status", exact: true })
      const active = statuses.locator('[data-status="active"]')
      const pending = statuses.locator('[data-status="pending"]')
      await expect(active).toHaveAttribute("aria-checked", "false")
      await expect(active).toHaveCSS("opacity", "1")
      await active.press("Enter")
      await expect(active).toHaveAttribute("aria-checked", "true")
      await expect(pending).toHaveAttribute("aria-checked", "false")
      await expect(pending).toHaveCSS("opacity", "1")
      await page.locator("#cancel-new-task").press("Enter")
    }
  })

  test("New Task modal closes on close button click", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    await page.click("#close-new-task-modal")

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal closes on Cancel button click", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    await page.click("#cancel-new-task")

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task keeps Tab inside and returns focus after Escape", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "New Task", exact: true })
    await trigger.focus()
    await page.keyboard.press("Enter")
    const overlay = page.locator("#new-task-overlay")
    const first = overlay.locator("#close-new-task-modal")
    const last = overlay.locator("#submit-new-task-btn")
    await expect(overlay.locator("#new-task-title-input")).toBeFocused()
    await last.focus()
    await page.keyboard.press("Tab")
    await expect(first).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(last).toBeFocused()

    await page.keyboard.press("Escape")

    await expect(overlay).not.toHaveClass(/active/)
    await expect(trigger).toBeFocused()
  })

  test("New Task modal closes on backdrop click", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    const overlay = page.locator("#new-task-overlay")
    await expect(overlay).toHaveClass(/active/)

    // Click the overlay itself (outside the modal-content)
    await overlay.click({ position: { x: 10, y: 10 } })

    await expect(overlay).not.toHaveClass(/active/)
  })

  test("New Task modal title input autofocuses", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    const titleInput = page.locator("#new-task-title-input")
    await expect(titleInput).toBeFocused()
  })

  test("keeps draft IDs through retry and saves an editable multiline checklist", async ({ page, request }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()
    await page.locator('[data-kind="checklist"]').click()
    await page.locator("#new-task-title-input").fill("Checklist creation fixture")
    const draft = page.locator("#nt-checklist-builder-input")
    await draft.fill("First\nSecond\nFirst")
    await page.locator("#nt-add-sub-item-btn").click()
    await page.getByRole("button", { name: "Remove First", exact: true }).first().click()
    await draft.fill("Third")
    await draft.press("Shift+Enter")
    await draft.pressSequentially("Fourth")
    await expect(draft).toHaveValue("Third\nFourth")
    await draft.press("Enter")
    await draft.fill("Last")

    const payloads: string[] = []
    let createdId: string | undefined
    await page.route("**/api/tasks", async route => {
      if (route.request().method() !== "POST") return route.continue()
      payloads.push(route.request().postDataJSON().checklists)
      if (payloads.length === 1) return route.fulfill({ status: 503, body: "Fixture save failure" })
      const response = await route.fetch()
      if (response.status() === 201) createdId = (await response.json()).id
      return route.fulfill({ response })
    })

    const submit = page.locator("#submit-new-task-btn")
    const creationResponse = (status: number) => page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST" && response.status() === status,
    )
    await Promise.all([creationResponse(503), submit.click()])
    await expect(submit).toBeEnabled()
    await expect(draft).toHaveValue("Last")
    await Promise.all([creationResponse(201), submit.click()])
    expect(payloads).toHaveLength(2)
    const persistedChecklist = payloads[1]!
    expect(payloads[0]).toBe(persistedChecklist)

    const texts = ["Second", "First", "Third", "Fourth", "Last"]
    const checklist = JSON.parse(persistedChecklist)
    expect(checklist).toEqual(texts.map(text => ({ id: expect.any(String), text, done: false })))
    expect(new Set(checklist.map((item: { id: string }) => item.id)).size).toBe(texts.length)
    expect(createdId).toEqual(expect.any(String))
    const detailName = "Task detail: Checklist creation fixture"
    await expect(page.getByRole("dialog", { name: detailName })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe("/tickets/" + encodeURIComponent(createdId!))
    const id = encodeURIComponent(createdId!)
    const taskPath = "/api/tasks/" + id
    const getChecklist = async () => {
      const response = await request.get(taskPath)
      expect(response.status()).toBe(200)
      return (await response.json()).checklists
    }
    expect(await getChecklist()).toBe(persistedChecklist)

    const detailsPage = await page.context().newPage()
    await detailsPage.goto("/tasks?open=" + id)
    const detail = detailsPage.getByRole("dialog", { name: detailName })
    await expect(detail).toBeVisible()
    await expect(detail.locator("#td-checklists textarea")).toHaveCount(texts.length)
    const [saved] = await Promise.all([
      detailsPage.waitForResponse(response =>
        new URL(response.url()).pathname === taskPath && response.request().method() === "PUT",
      ),
      detail.getByRole("checkbox", { name: "Last", exact: true }).check(),
    ])
    expect(saved.status()).toBe(200)
    expect(saved.request().postDataJSON()).toMatchObject({ expected_checklists: persistedChecklist })
    expect(JSON.parse(await getChecklist())).toEqual(checklist.map((item: { text: string }) => ({
      ...item, done: item.text === "Last",
    })))
  })
})

test.describe("Recovered ticket form", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

  test("labeled grouped controls keep goals available without assignees and fit desktop and mobile", async ({ page }) => {
    await page.route("**/api/users", route => route.fulfill({ json: { users: [] } }))
    await page.route("**/api/goals", route => route.fulfill({ json: { goals: [{ id: "form-goal", title: "Prepare household supplies" }] } }))
    await page.goto("/today")
    await page.getByRole("button", { name: "New Task", exact: true }).click()
    await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" })
    const modal = page.getByRole("dialog", { name: "New Task", exact: true })
    await modal.getByRole("button", { name: "Checklist", exact: true }).click()
    await expect(modal.getByRole("button", { name: "Checklist", exact: true })).toHaveAttribute("aria-pressed", "true")
    const title = modal.getByRole("textbox", { name: "Title (required)", exact: true })
    const description = modal.getByRole("textbox", { name: "Description", exact: true })
    await expect(title).toHaveAttribute("maxlength", "500")
    await expect(description).toHaveAttribute("maxlength", "10000")
    await title.fill("Prepare household supplies")
    await description.fill("Bring supplies for the weekend.")
    await modal.getByRole("textbox", { name: "New items", exact: true }).fill("Pack " + "longword".repeat(30) + "\nFill flask")
    await modal.getByRole("button", { name: "Add Item", exact: true }).click()
    await expect(modal.locator("#nt-checklist-items-container").getByRole("listitem")).toHaveCount(2)
    await expect(modal.locator("#nt-checklist-count")).toHaveText("2 items")
    await modal.getByRole("combobox", { name: "Priority", exact: true }).selectOption("2")
    const expectedDue = await page.evaluate(() => {
      const date = new Date()
      date.setDate(date.getDate() + 1)
      date.setHours(0, 0, 0, 0)
      return date.toISOString()
    })
    await modal.getByRole("group", { name: "Due Date", exact: true }).getByRole("button", { name: "Due Date", exact: true }).press("Enter")
    await modal.locator(".nt-due-date-panel").getByRole("button", { name: /^Tomorrow/ }).press("Enter")
    await modal.locator("#nt-options > summary").click()
    const goal = modal.getByRole("combobox", { name: "Goal", exact: true })
    await expect(goal).toBeVisible()
    await goal.selectOption("form-goal")
    await expect(modal.getByRole("combobox", { name: "Assignee", exact: true })).toBeHidden()
    await modal.getByRole("combobox", { name: "Repeat", exact: true }).selectOption("FREQ=WEEKLY")
    await expect(modal.locator("#nt-is-routine, #nt-ai-handoff, [data-field-type=attachment]")).toHaveCount(0)
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 740 })
      expect(await modal.locator(".nt-modal").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      expect(await modal.locator(".nt-form").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      const header = await modal.locator(".nt-header").boundingBox()
      const footer = await modal.locator(".nt-footer").boundingBox()
      expect(header!.y).toBeGreaterThanOrEqual(0)
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(740)
      if (process.env.MEITHEAL_FORM_SCREENSHOT_DIR) {
        await modal.locator(".nt-form").evaluate(element => { element.scrollTop = 0 })
        await page.screenshot({ path: `${process.env.MEITHEAL_FORM_SCREENSHOT_DIR}/new-ticket-${width}.png` })
      }
    }
    let sent: Record<string, unknown> | undefined
    await page.route("**/api/tasks", async route => {
      if (route.request().method() !== "POST") return route.continue()
      sent = route.request().postDataJSON()
      await route.fulfill({ status: 503, body: "Unavailable" })
    })
    await modal.getByRole("button", { name: "Create Checklist", exact: true }).press("Enter")
    await expect(modal.getByRole("alert")).toContainText("Your entries are still here")
    await expect(title).toHaveValue("Prepare household supplies")
    expect(sent).toMatchObject({ goal_id: "form-goal", priority: 2, recurrence_rule: "FREQ=WEEKLY", due_date: expectedDue })
    expect(sent).not.toHaveProperty("is_routine")
  })

  test("event dates are labeled and an invalid end preserves the form without sending a task", async ({ page }) => {
    await page.goto("/today")
    await page.getByRole("button", { name: "New Task", exact: true }).click()
    const modal = page.getByRole("dialog", { name: "New Task", exact: true })
    await modal.getByRole("button", { name: "Event", exact: true }).click()
    await modal.getByRole("textbox", { name: "Title (required)", exact: true }).fill("Household visit")
    await modal.getByLabel("Starts", { exact: true }).fill("2026-12-12T14:00")
    await modal.getByLabel("Ends", { exact: true }).fill("2026-12-12T13:00")
    let creates = 0
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/tasks" && request.method() === "POST") creates++ })
    await modal.getByRole("button", { name: "Create Event", exact: true }).click()
    await expect(modal.locator("#nt-date-error")).toHaveText("End must be after start.")
    await expect(modal.getByLabel("Ends", { exact: true })).toBeFocused()
    expect(creates).toBe(0)
  })
})


test.describe("Due date capture compatibility", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

  test("context dates remain exact until the keyboard picker changes or clears them", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 })
    await page.goto("/today")
    await expect(page.locator("#new-task-overlay")).toHaveAttribute("data-new-task-controller", "ready")
    const due = "2026-12-12T14:25:31.123+05:30"
    await page.evaluate(due => { window.__prefillTaskDate = due; window.openNewTaskModal?.() }, due)
    const modal = page.getByRole("dialog", { name: "New Task", exact: true })
    const stored = modal.locator("#nt-contextual-due")
    await expect(stored).toHaveValue(due)
    expect(await page.evaluate(() => window.__prefillTaskDate)).toBeUndefined()
    await modal.getByRole("textbox", { name: "Title (required)", exact: true }).fill("Preserve\ncontext capture")
    expect(await modal.locator("#new-task-title-input").evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true)
    let creates = 0
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/tasks" && request.method() === "POST") creates++ })
    const trigger = modal.getByRole("group", { name: "Due Date", exact: true }).getByRole("button", { name: /^Due Date:/ })
    await expect(trigger.locator("button")).toHaveCount(0)
    await trigger.press("Enter")
    const picker = modal.locator(".nt-due-date-panel")
    await expect(picker).toBeVisible()
    const pickerStyle = await picker.evaluate(el => {
      const cs = getComputedStyle(el)
      return {
        backgroundColor: cs.backgroundColor,
        borderTopWidth: cs.borderTopWidth,
        borderRadius: cs.borderRadius,
        boxShadow: cs.boxShadow,
      }
    })
    expect(pickerStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
    expect(pickerStyle.backgroundColor).not.toBe("transparent")
    expect(pickerStyle.borderTopWidth).not.toBe("0px")
    expect(pickerStyle.boxShadow).not.toBe("none")
    const bounds = await picker.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(740)
    await page.keyboard.press("Escape")
    await expect(picker).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(stored).toHaveValue(due)
    await modal.getByRole("button", { name: "Remove scheduled date", exact: true }).press("Enter")
    await expect(stored).toHaveValue("")
    await expect(modal).toBeVisible()
    expect(creates).toBe(0)
    await modal.getByRole("button", { name: "Cancel", exact: true }).press("Enter")
    await page.getByRole("button", { name: "New Task", exact: true }).press("Enter")
    await expect(stored).toHaveValue("")
  })
})
