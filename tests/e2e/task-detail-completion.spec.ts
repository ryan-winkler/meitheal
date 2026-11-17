import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")

test("Details completion clears Knight Rider active work on Dashboard and Board", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Finish the active card from Details"
  const created = await request.post("/api/tasks", { data: { title, status: "active", is_favorite: true } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const other = await request.post("/api/tasks", { data: { title: "Another Board card" } })
  expect(other.status()).toBe(201)
  const { id: otherId } = await other.json()
  const status = page.locator("#td-status")
  const done = page.locator("#td-toggle-done")
  const close = page.getByRole("button", { name: "Close detail" })
  const card = page.locator(`.kanban-card[data-id="${id}"]`)
  const link = card.locator(".card-open-btn")
  let refreshHeld = false
  let failRefresh = false
  let snapshotRefresh = false
  let boardReads = 0
  let releaseRefresh = () => {}
  let waitingRefresh: Promise<void> | undefined
  function holdNextRefresh(snapshot = false) {
    refreshHeld = false
    snapshotRefresh = snapshot
    waitingRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  }
  function releaseHeldRefresh() {
    waitingRefresh = undefined
    releaseRefresh()
  }
  await page.route(url => url.searchParams.has("boardRefresh"), async route => {
    boardReads++
    if (failRefresh) return route.fulfill({ status: 503 })
    const held = waitingRefresh
    if (held) {
      const response = snapshotRefresh ? await route.fetch() : undefined
      refreshHeld = true
      await held
      if (response) return route.fulfill({ response })
    }
    return route.continue()
  })
  let holdTitle = false
  let titleRequestHeld = false
  let releaseTitle = () => {}
  const waitingTitle = new Promise<void>(resolve => { releaseTitle = resolve })
  await page.route(`**/api/tasks/${otherId}`, async route => {
    if (holdTitle && route.request().method() === "PUT" && route.request().postDataJSON()?.title) {
      titleRequestHeld = true
      await waitingTitle
    }
    return route.continue()
  })
  try {
    await page.goto("/")
    const dashboard = page.locator(`#dashboard-recent .bento-card[data-id="${id}"]`)
    const openQueue = page.locator(`#my-open-list [data-id="${id}"]`)
    const favorite = page.locator(`#dashboard-favorites [data-id="${id}"]`)
    await expect(dashboard).toHaveAttribute("data-work-active", "")
    await expect(openQueue).toBeVisible()
    await expect(favorite).toBeVisible()
    const edit = dashboard.getByRole("button", { name: "Edit task" })
    await edit.click()
    await expect(status).toHaveValue("active")
    await done.click()
    await expect(status).toHaveValue("complete")
    await expect(dashboard).not.toHaveAttribute("data-work-active", "")
    await expect(dashboard.locator(".task-badge")).toHaveText("Done")
    await expect(openQueue).toBeHidden()
    await expect(favorite).toHaveCount(0)
    await expect(page.locator("#my-open-empty")).toHaveText("No open tasks for this selection.")
    await close.click()
    await expect(edit).toBeFocused()
    await edit.press("Enter")
    await expect(status).toHaveValue("complete")
    await status.selectOption("active")
    await expect(openQueue).toBeVisible()
    await expect(favorite).toBeVisible()
    await expect(openQueue).toHaveAttribute("data-work-active", "")
    await done.click()
    await expect(status).toHaveValue("complete")
    await expect(openQueue).toBeHidden()
    await close.click()

    await page.goto("/tasks#kanban")
    await expect(card).toHaveAttribute("data-status", "complete")
    await link.press("Enter")
    await expect(status).toHaveValue("complete")
    failRefresh = true
    await status.selectOption("active")
    await expect(status).toHaveValue("active")
    await expect(page.locator("[data-kanban-loading]")).toContainText("Status saved.")
    await expect(card).toHaveAttribute("data-status", "complete")
    await expect(card).not.toHaveAttribute("data-work-active", "")
    await close.click()
    await expect(link).toBeFocused()
    failRefresh = false
    await page.locator("[data-kanban-retry]").click()
    await expect(card).toHaveAttribute("data-status", "active")
    await expect(card).toHaveAttribute("data-work-active", "")

    await link.press("Enter")
    await expect(status).toHaveValue("active")
    holdNextRefresh()
    await done.click()
    await expect(status).toHaveValue("complete")
    await expect.poll(() => refreshHeld).toBe(true)
    await close.click()
    await expect(link).toBeFocused()
    const newerFocus = page.locator(`.kanban-card[data-id="${otherId}"] .card-open-btn`)
    await newerFocus.focus()
    releaseHeldRefresh()
    await expect(card).toHaveAttribute("data-status", "complete")
    await expect(card).not.toHaveAttribute("data-work-active", "")
    await expect(newerFocus).toBeFocused()

    await link.press("Enter")
    await expect(status).toHaveValue("complete")
    holdNextRefresh()
    await status.selectOption("active")
    await expect.poll(() => refreshHeld).toBe(true)
    await close.click()
    await page.locator('.kanban-column[data-status="pending"] > .kanban-add-btn').click()
    const draft = page.getByRole("textbox", { name: "New task title" })
    await draft.fill("An unsent inline draft")
    releaseHeldRefresh()
    await expect(page.locator("#kanban-board")).not.toHaveAttribute("aria-busy", "true")
    await expect(draft).toBeFocused()
    await expect(draft).toHaveValue("An unsent inline draft")
    await expect(card).toHaveAttribute("data-status", "complete")
    await draft.press("Escape")
    await expect(draft).toHaveCount(0)
    await expect(card).toHaveAttribute("data-status", "active")

    await link.press("Enter")
    await expect(status).toHaveValue("active")
    holdNextRefresh()
    await done.click()
    await expect.poll(() => refreshHeld).toBe(true)
    await close.click()
    const titleEdit = page.locator(`.kanban-card[data-id="${otherId}"] .kanban-title-text`)
    await titleEdit.dispatchEvent("dblclick")
    await titleEdit.fill("An unsent title edit")
    releaseHeldRefresh()
    await expect(page.locator("#kanban-board")).not.toHaveAttribute("aria-busy", "true")
    await expect(titleEdit).toBeFocused()
    await expect(titleEdit).toHaveText("An unsent title edit")
    await expect(card).toHaveAttribute("data-status", "active")
    holdTitle = true
    await titleEdit.press("Enter")
    await expect.poll(() => titleRequestHeld).toBe(true)
    await expect(card).toHaveAttribute("data-status", "active")
    await expect(page.locator(`.kanban-card[data-id="${otherId}"]`)).toHaveAttribute("data-title-saving", "")
    holdTitle = false
    releaseTitle()
    await expect(card).toHaveAttribute("data-status", "complete")
    await expect(titleEdit).toHaveText("An unsent title edit")

    await page.goto(`/tasks?status=active&open=${id}#kanban`)
    await expect(status).toHaveValue("complete")
    await expect(card).toHaveCount(0)
    await status.selectOption("active")
    await expect(card).toHaveAttribute("data-status", "active")
    await expect(card).toHaveAttribute("data-work-active", "")

    const priorReads = boardReads
    holdNextRefresh(true)
    await done.click()
    await expect(status).toHaveValue("complete")
    await expect.poll(() => refreshHeld).toBe(true)
    const reopened = page.waitForResponse(response => response.request().method() === "PUT" &&
      new URL(response.url()).pathname === `/api/tasks/${id}` && response.request().postDataJSON()?.status === "active")
    await status.selectOption("active")
    const response = await reopened
    expect(response.ok(), await response.text()).toBe(true)
    await expect(status).toHaveAttribute("data-saved-status", "active")
    releaseHeldRefresh()
    await expect.poll(() => boardReads).toBeGreaterThanOrEqual(priorReads + 2)
    await expect(page.locator("#kanban-board")).not.toHaveAttribute("aria-busy", "true")
    await expect(card).toHaveAttribute("data-status", "active")
    await expect(card).toHaveAttribute("data-work-active", "")
    await close.click()
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
    await expect(page).toHaveURL(url => url.searchParams.get("status") === "active" && url.hash === "#kanban")
  } finally {
    releaseTitle()
    releaseHeldRefresh()
    await request.delete(`/api/tasks/${otherId}`, { data: {} })
    await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})
