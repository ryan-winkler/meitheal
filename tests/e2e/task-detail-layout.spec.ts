import AxeBuilder from "@axe-core/playwright"
import { test, expect, type APIRequestContext, type Locator } from "@playwright/test"

import { normalizeTaskDetailOrder, taskDetailDefaultOrder } from "../../apps/web/src/lib/task-detail-layout"

const layoutKey = "meitheal:task-detail-layout:v1"

async function taskHeaders(request: APIRequestContext) {
  const access = await request.get("/api/boards")
  expect(access.status()).toBe(200)
  const session = access.headers()["x-meitheal-board-session"]
  expect(session).toBeTruthy()
  return { "x-meitheal-board-session": session!, "x-meitheal-board-id": "household" }
}

async function createTicket(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post("/api/tasks", {
    headers: await taskHeaders(request),
    data: { title, description: "Description for the task detail layout fixture." },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).id
}

function ids(list: Locator) {
  return list.locator(":scope > [data-layout-item]").evaluateAll(items =>
    items.map(item => (item as HTMLElement).dataset.layoutItem),
  )
}

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
test.use({ serviceWorkers: "block" })

test("ticket and Settings share a real section and field order, and reset restores defaults", async ({ page, request }) => {
  const properties = taskDetailDefaultOrder.get("properties")!
  const previous = properties.filter(id => id !== "home-assistant-area").reverse()
  expect(normalizeTaskDetailOrder(previous, properties)).toEqual([...previous, "home-assistant-area"])
  const id = await createTicket(request, "Arrange a task")
  await page.addInitScript(key => {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify({
        sections: ["description", "retired-section", "description", 42],
        properties: ["status", "missing-field"],
      }))
    }
  }, layoutKey)
  await page.goto(`/tickets/${id}`)
  const sections = page.locator("#td-sections")
  const description = sections.locator("#td-section-description")
  await expect(page.locator("#td-title")).toHaveValue("Arrange a task")
  const initial = await ids(sections)
  expect(initial.slice(0, 3)).toEqual(["description", "properties", "scheduling"])
  await description.locator("summary").press("Enter")
  await expect(description.locator("#td-desc-preview")).toBeHidden()
  await expect(sections.locator("#td-status")).toBeVisible()

  const toggle = page.getByRole("button", { name: "Task detail layout", exact: true })
  const editor = page.locator("#td-layout-panel")
  const editorRows = editor.locator('ol[data-layout-order="sections"] > [data-layout-item]')
  await expect(editorRows).toHaveCount(0)
  await toggle.click()
  expect(await ids(editor.locator('ol[data-layout-order="sections"]'))).toEqual(initial)
  const moveDescription = editor.getByRole("button", { name: /Move down · Description/ })
  await moveDescription.press("Enter")
  await expect(moveDescription).toBeFocused()
  await expect(editor.getByRole("status")).toHaveText("Description moved to position 2 of 10.")
  expect((await ids(sections)).slice(0, 3)).toEqual(["properties", "description", "scheduling"])
  await expect(description.locator("#td-desc-preview")).toBeHidden()

  // Settings edits the server-wide default. The ticket's edits stay a personal override in this browser.
  await page.goto("/settings#tasks-boards-settings")
  const settings = page.locator("#settings-task-detail-layout")
  const settingsList = settings.locator('ol[data-layout-order="sections"]')
  await expect(settingsList).toBeVisible()
  await expect.poll(() => ids(settingsList)).toEqual(initial)
  await expect(settings.locator("[data-layout-personal-notice]")).toBeVisible()
  await settings.locator('summary').filter({ hasText: "Fields · Properties" }).click()
  const moveType = settings.getByRole("button", { name: /Move up · Type/ })
  await moveType.press("Enter")
  await expect(moveType).toBeFocused()
  await settings.getByRole("button", { name: "Save server default" }).click()
  await expect(settings.locator("[data-layout-dirty-bar]")).toBeHidden()
  await page.goto(`/tickets/${id}`)
  await expect(page.locator("#td-title")).toHaveValue("Arrange a task")
  expect((await ids(sections)).slice(0, 3)).toEqual(["properties", "description", "scheduling"])

  // Reset on the ticket clears the personal override and shows the saved server default.
  await toggle.click()
  await editor.getByRole("button", { name: "Reset to server default" }).click()
  await expect(editor.getByRole("status")).toHaveText("Default layout restored.")
  expect(await ids(sections)).toEqual(initial)
  expect((await ids(sections.locator('[data-layout-order="properties"]'))).slice(0, 3))
    .toEqual(["type", "status", "priority"])
  await expect(description.locator("#td-desc-preview")).toBeVisible()

  // Restore the built-in server default for later cases without another Settings load,
  // which keeps this file inside the loopback API rate window.
  expect((await request.put("/api/settings", { data: { key: "task_detail_layout_default", value: null } })).ok()).toBe(true)
  await page.goto(`/tickets/${id}`)
  await expect(page.locator("#td-title")).toHaveValue("Arrange a task")
  expect((await ids(sections.locator('[data-layout-order="properties"]'))).slice(0, 2))
    .toEqual(["status", "type"])
})

test("Focus fills the viewport and preserves current edits, history, and Escape order", async ({ page, request }) => {
  const id = await createTicket(request, "Focus layout fixture")
  const { ticket_key } = await (await request.get(`/api/tasks/${id}`)).json()
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(`/tickets/${id}`)
  const overlay = page.locator("#task-detail-overlay")
  const panel = page.locator("#task-detail-panel")
  const title = page.locator("#td-title")
  const draft = page.locator("#td-description")
  const enter = page.getByRole("button", { name: "Focus mode" })
  await expect(title).toHaveValue("Focus layout fixture")
  await expect(panel).toHaveAttribute("role", "region")
  await expect(enter).toBeVisible()
  const audit = await new AxeBuilder({ page }).include("#task-detail-panel").analyze()
  expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }))).toEqual([])
  const historyLength = await page.evaluate(() => history.length)
  await page.waitForFunction(() => !document.querySelector<HTMLSelectElement>("#td-status")?.disabled)
  const writes: string[] = []
  page.on("request", req => {
    if (req.url().endsWith(`/api/tasks/${id}`) && req.method() !== "GET") writes.push(req.method())
  })

  await title.fill("Uncommitted title in Focus")
  await enter.click()
  await expect(title).toBeFocused()
  await expect(title).toHaveValue("Uncommitted title in Focus")
  await expect(overlay).toHaveAttribute("data-focus-mode", "")
  await expect(panel).toHaveAttribute("aria-modal", "true")
  expect(await panel.boundingBox()).toMatchObject({ x: 0, y: 0, width: 1600, height: 900 })
  expect(writes).toEqual([])

  await page.getByRole("button", { name: "Edit description" }).click()
  await draft.fill("Uncommitted description in Focus")
  const writesBeforeExit = writes.length
  await draft.press("ArrowLeft")
  const caret = await draft.evaluate(node => (node as HTMLTextAreaElement).selectionStart)
  await page.setViewportSize({ width: 390, height: 760 })
  await expect(overlay).toHaveAttribute("data-focus-mode", "")
  expect(await panel.boundingBox()).toMatchObject({ x: 0, y: 0, width: 390, height: 760 })
  await draft.press("Escape")
  await expect(overlay).not.toHaveAttribute("data-focus-mode", "")
  await expect(panel).toHaveAttribute("role", "dialog")
  await expect(draft).toBeFocused()
  await expect(draft).toHaveValue("Uncommitted description in Focus")
  expect(await draft.evaluate(node => (node as HTMLTextAreaElement).selectionStart)).toBe(caret)
  expect(await page.evaluate(() => history.length)).toBe(historyLength)
  expect(new URL(page.url()).pathname).toBe(`/tickets/${ticket_key}`)
  expect(writes.length).toBe(writesBeforeExit)

  const layout = page.getByRole("button", { name: "Task detail layout", exact: true })
  await layout.click()
  await page.locator("#td-layout-panel").getByRole("button", { name: "Reset to server default" }).focus()
  await page.keyboard.press("Escape")
  await expect(layout).toHaveAttribute("aria-expanded", "false")
  await expect(layout).toBeFocused()
  await expect(overlay).toHaveClass(/active/)
  await page.keyboard.press("Escape")
  await expect(overlay).not.toHaveClass(/active/)
})

test("pointer drag rolls back if browser storage refuses the write", async ({ page, request }) => {
  const id = await createTicket(request, "Drag and rollback")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(`/tickets/${id}`)
  await page.getByRole("button", { name: "Task detail layout", exact: true }).click()
  const editor = page.locator("#td-layout-panel [data-task-layout-editor]")
  await expect(editor).toHaveAttribute("data-drag-ready", "true")
  const list = editor.locator('ol[data-layout-order="sections"]')
  const source = list.locator(':scope > [data-layout-item="description"] [data-layout-handle]')
  const destination = list.locator(':scope > [data-layout-item="properties"]')
  // Collapse the field list so the whole Properties row, and its midpoint, stays on screen.
  const fields = destination.locator("details.td-layout-editor__fields")
  if (await fields.evaluate(element => (element as HTMLDetailsElement).open)) await fields.locator(":scope > summary").click()
  // A row moves past a section once the pointer crosses that section's midpoint.
  async function drag(target: Locator, edge: "top" | "bottom") {
    const from = (await source.boundingBox())!
    const to = (await target.boundingBox())!
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(from.x + from.width / 2, to.y + to.height * (edge === "top" ? 0.25 : 0.75), { steps: 14 })
    await page.mouse.up()
  }
  await drag(destination, "bottom")
  await expect(editor.getByRole("status")).toContainText("Description moved")
  const saved = await ids(list)
  expect(saved.indexOf("description")).toBeGreaterThan(0)

  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (name, value) {
      if (name === key) throw new DOMException("Disabled for fixture", "QuotaExceededError")
      return setItem.call(this, name, value)
    }
  }, layoutKey)
  await drag(destination, "top")
  await expect(editor.getByRole("status")).toHaveText("Couldn’t save the layout in this browser. Try again.")
  expect(await ids(list)).toEqual(saved)
  expect(await ids(page.locator("#td-sections"))).toEqual(saved)
})

test("activity retries and remains mounted across Focus and collapse", async ({ page, request }) => {
  const id = await createTicket(request, "Activity retry fixture")
  let attempts = 0
  await page.route(`**/api/tasks/${id}/activity`, route => {
    attempts++
    return route.fulfill(attempts === 1 ? { status: 403 } : {
      headers: { "cache-control": "no-store" },
      json: { activity: [{ field: "description", new_value: "Recovered activity", created_at: Date.now() }] },
    })
  })
  await page.goto(`/tickets/${id}`)
  await expect(page.locator("#td-title")).toHaveValue("Activity retry fixture")
  const activity = page.locator("#td-section-activity")
  await expect(activity).not.toHaveAttribute("open", "")
  expect(attempts).toBe(0)
  await activity.locator("summary").click()
  await expect(activity.getByRole("status")).toHaveText("Couldn’t load activity.")
  await activity.getByRole("button", { name: "Retry" }).click()
  await expect(activity.locator("#td-activity")).toContainText("Recovered activity")
  await page.getByRole("button", { name: "Focus mode" }).click()
  await activity.locator("summary").click()
  await activity.locator("summary").click()
  await expect(activity.locator("#td-activity")).toBeVisible()
  expect(attempts).toBe(2)
})

test("Description locks during Save, retains a failed draft, and resets for a blank ticket", async ({ page, request }) => {
  const id = await createTicket(request, "Description save fixture")
  const blank = await request.post("/api/tasks", { headers: await taskHeaders(request), data: { title: "Blank description fixture" } })
  expect(blank.status()).toBe(201)
  const blankId = (await blank.json()).id
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let reads = 0
  let attempts = 0
  await page.route(`**/api/tasks/${id}`, async route => {
    if (route.request().method() === "GET") reads++
    if (route.request().method() !== "PUT") return route.continue()
    attempts++
    if (attempts === 1) {
      await pending
      return route.fulfill({ status: 400, json: { error: "Fixture save failed" } })
    }
    return route.continue()
  })
  await page.goto(`/tickets/${id}`)
  await page.getByRole("button", { name: "Edit description" }).click()
  const editor = page.locator("#td-description")
  const save = page.locator("#td-desc-save-btn")
  const cancel = page.locator("#td-desc-cancel-btn")
  await editor.fill("Draft to keep after failure")
  await save.click()
  try {
    await expect(save).toBeDisabled()
    await expect(cancel).toBeDisabled()
    await expect(editor).toHaveAttribute("readonly", "")
    await editor.press("Control+s")
    expect(attempts).toBe(1)
    const readsBeforeRefresh = reads
    await page.evaluate(id => { void window.openTaskDetail?.(id) }, id)
    expect(reads).toBe(readsBeforeRefresh)
  } finally {
    finish()
  }
  await expect.poll(() => reads).toBeGreaterThan(1)
  await expect(save).toBeVisible()
  await expect(save).toBeEnabled()
  await expect(editor).toHaveValue("Draft to keep after failure")
  await save.click()
  await expect(page.locator("#td-desc-preview")).toHaveText("Draft to keep after failure")
  expect(attempts).toBe(2)

  await page.getByRole("button", { name: "Focus mode" }).click()
  const overlay = page.locator("#task-detail-overlay")
  const properties = page.locator("#td-section-properties")
  await properties.locator("summary").click()
  const alias = (await page.locator("#td-id").textContent())!.trim()
  const aliasPath = `**/api/tasks/${alias}`
  await page.route(aliasPath, route => route.fulfill({ status: 400, json: { error: "Fixture read failed" } }), { times: 1 })
  await page.evaluate(alias => window.openTaskDetail?.(alias), alias)
  await expect(page.locator("#td-load-error")).toBeVisible()
  await expect(page.getByRole("button", { name: "Exit Focus" })).toBeVisible()
  await page.evaluate(alias => window.openTaskDetail?.(alias), alias)
  await expect(page.locator("#td-title")).toHaveValue("Description save fixture")
  await expect(overlay).toHaveAttribute("data-focus-mode", "")
  await expect(properties).not.toHaveAttribute("open", "")

  await page.evaluate(id => window.openTaskDetail?.(id), blankId)
  await expect(page.locator("#td-title")).toHaveValue("Blank description fixture")
  await expect(overlay).not.toHaveAttribute("data-focus-mode", "")
  await expect(properties).toHaveAttribute("open", "")
  await expect(editor).toHaveValue("")
  await expect(save).toBeEnabled()
  await cancel.click()
  await expect(page.locator("#td-desc-preview")).toHaveText("No description provided.")
})

test("a change in another tab waits while focus is inside a ticket field", async ({ page, context, request }) => {
  const id = await createTicket(request, "Layout synchronization fixture")
  await page.goto(`/tickets/${id}`)
  await page.getByRole("button", { name: "Edit description" }).click()
  const description = page.locator("#td-description")
  const sections = page.locator("#td-sections")
  await description.fill("Keep this draft and its selection")
  // Another tab's personal layout edit reaches this ticket; Settings edits only the server draft.
  const other = await context.newPage()
  await other.goto(`/tickets/${id}`)
  await other.getByRole("button", { name: "Task detail layout", exact: true }).click()
  const otherEditor = other.locator("#td-layout-panel")
  await otherEditor.getByRole("button", { name: /Move down · Description/ }).click()
  await expect(otherEditor.locator("[data-layout-status]")).toContainText("Description moved")
  expect((await ids(sections))[0]).toBe("description")
  await expect(description).toBeFocused()
  await expect(description).toHaveValue("Keep this draft and its selection")
  await page.getByRole("button", { name: "Task detail layout", exact: true }).focus()
  await expect.poll(async () => (await ids(sections)).slice(0, 2)).toEqual(["properties", "description"])
  await expect(description).toHaveValue("Keep this draft and its selection")
})

test.describe("touch layout", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test("dragging a grip reorders on touch", async ({ page, request, context }) => {
    const id = await createTicket(request, "Touch drag fixture")
    await page.goto(`/tickets/${id}`)
    await page.getByRole("button", { name: "Focus mode" }).tap()
    await page.getByRole("button", { name: "Task detail layout", exact: true }).tap()
    const editor = page.locator("#td-layout-panel [data-task-layout-editor]")
    await expect(editor).toHaveAttribute("data-drag-ready", "true")
    const list = editor.locator('ol[data-layout-order="sections"]')
    // Collapse the field list so the Properties row's midpoint stays on screen.
    const fields = list.locator(':scope > [data-layout-item="properties"] details.td-layout-editor__fields')
    if (await fields.evaluate(element => (element as HTMLDetailsElement).open)) await fields.locator(":scope > summary").tap()
    const grip = await list.locator(':scope > [data-layout-item="description"] [data-layout-handle]').boundingBox()
    const next = await list.locator(':scope > [data-layout-item="properties"]').boundingBox()
    expect(grip).not.toBeNull()
    expect(next).not.toBeNull()
    const client = await context.newCDPSession(page)
    const x = grip!.x + grip!.width / 2
    const y = grip!.y + grip!.height / 2
    const end = next!.y + next!.height * 0.75
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    for (let step = 1; step <= 12; step++) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (end - y) * step / 12 }] })
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    await expect(editor.getByRole("status")).toContainText("Description moved")
    expect((await ids(page.locator("#td-sections"))).slice(0, 2)).toEqual(["properties", "description"])
  })
})

test("switch and Close wait for the Description draft and retain it after failure", async ({ page, request }) => {
  const id = await createTicket(request, "Draft before switch")
  const other = await createTicket(request, "Destination after save")
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  let writes = 0
  await page.route(`**/api/tasks/${id}`, async route => {
    if (route.request().method() !== "PUT") return route.continue()
    writes++
    if (writes === 1) {
      await pending
      return route.fulfill({ status: 400, json: { error: "Fixture failed draft write" } })
    }
    return route.continue()
  })
  await page.goto(`/tickets/${id}`)
  await page.getByRole("button", { name: "Edit description" }).click()
  const editor = page.locator("#td-description")
  await editor.fill("Retain this draft when switching")
  await expect(page.locator("#td-desc-save-btn")).toBeEnabled()
  await page.evaluate(id => { void window.openTaskDetail?.(id) }, other)
  try {
    await expect.poll(() => writes).toBe(1)
    await expect(page.locator("#td-title")).toHaveValue("Draft before switch")
  } finally {
    finish()
  }
  await expect(page.locator("#td-desc-save-btn")).toBeEnabled()
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue("Retain this draft when switching")
  await page.evaluate(id => { void window.openTaskDetail?.(id) }, other)
  await expect(page.locator("#td-title")).toHaveValue("Destination after save")
  const saved = await request.get(`/api/tasks/${id}`)
  expect(saved.status(), await saved.text()).toBe(200)
  expect((await saved.json()).description).toBe("Retain this draft when switching")
  await page.getByRole("button", { name: "Edit description" }).click()
  await editor.fill("Save this draft when closing")
  await page.getByRole("button", { name: "Close detail" }).click()
  await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
  expect((await (await request.get(`/api/tasks/${other}`)).json()).description)
    .toBe("Save this draft when closing")
})
