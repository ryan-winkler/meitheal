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
    await expect(overlay.getByRole("checkbox", { name: "Mark as Routine" })).toBeVisible()
  })

  test("New Task modal has all required form fields", async ({ page }) => {
    await page.getByRole("button", { name: "New Task", exact: true }).click()

    await expect(page.locator("#new-task-title-input")).toBeVisible()
    await expect(page.locator("#new-task-desc-input")).toBeVisible()
    await expect(page.locator("#nt-priority-dropdown").getByRole("button")).toBeVisible()
    await expect(page.locator("#new-task-status")).toHaveValue(/.+/)
    const status = page.getByRole("radiogroup", { name: "Task status" })
    await expect(status.getByRole("radio").first()).toBeVisible()
    await expect(page.locator("#nt-recurrence-dropdown").getByRole("button")).toBeVisible()
    await expect(page.locator("#submit-new-task-btn")).toBeVisible()
    await expect(page.locator("#cancel-new-task")).toBeVisible()
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
    const first = overlay.locator("[data-kind]").first()
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
    expect(new URL(page.url()).pathname).toBe(`/tickets/${createdId}`)
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
