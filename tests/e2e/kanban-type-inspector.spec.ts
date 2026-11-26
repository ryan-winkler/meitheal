import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1800, height: 1000 } })

test("a Type drop updates open Details and preserves an unsaved description", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const response = await request.post("/api/tasks", { headers, data: {
    title: "Open Details Type move",
    description: "Original description",
    task_type: "story",
  } })
  expect(response.status()).toBe(201)
  const { id } = await response.json() as { id: string }
  const path = `/api/tasks/${id}`

  try {
    await page.goto("/tasks?view=kanban&groupBy=type#kanban")
    const board = page.locator("#kanban-board")
    await expect(board).toHaveAttribute("data-sorting-ready", "true")
    const card = page.locator(`.kanban-card[data-id="${id}"]`)
    await card.locator(".card-open-btn").press("Enter")
    await expect(page.locator("body")).toHaveClass(/has-docked-inspector/)
    const inspector = page.locator("#task-detail-overlay")
    const type = inspector.locator("#td-task-type")
    await expect(type).toHaveValue("story")
    const ticketUrl = page.url()
    await inspector.locator("#td-desc-edit-btn-hover").click()
    await inspector.getByRole("tab", { name: "Markdown", exact: true }).click()
    const description = inspector.locator("#td-description")
    await description.fill("Keep the unsaved description through the Type change")

    const title = card.locator(".kanban-title-text")
    const epic = board.locator('.kanban-column[data-status="pending"] .swimlane-group[data-swimlane-type="epic"]')
    const target = epic.locator(".swimlane-header")
    await title.scrollIntoViewIfNeeded()
    await target.scrollIntoViewIfNeeded()
    await expect(title).toBeInViewport()
    await expect(target).toBeInViewport()
    const start = (await title.boundingBox())!
    const end = (await target.boundingBox())!
    const committed = page.waitForResponse(result => new URL(result.url()).pathname === path &&
      result.request().method() === "PUT" && result.request().postDataJSON().task_type === "epic")
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    try {
      await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 })
    } finally {
      await page.mouse.up()
    }

    expect((await committed).status()).toBe(200)
    await expect(type).toHaveValue("epic")
    await expect(inspector.locator("#td-type-icon")).toHaveAttribute("title", "Epic")
    await expect(inspector).toHaveClass(/active/)
    await expect(page).toHaveURL(ticketUrl)
    await expect(description).toHaveValue("Keep the unsaved description through the Type change")
    await expect(epic.locator(card)).toBeVisible()

    await inspector.locator("#td-desc-save-btn").click()
    await expect.poll(async () => (await (await request.get(path)).json()).description)
      .toBe("Keep the unsaved description through the Type change")
    expect(await (await request.get(path)).json()).toMatchObject({ task_type: "epic", status: "pending" })
  } finally {
    await request.delete(path, { headers })
  }
})

test("Inspector updates Strategic Lens and refreshes Timeline only after a Type save succeeds", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const response = await request.post("/api/tasks", { headers, data: {
    title: "Confirmed Type on Timeline",
    task_type: "story",
    due_date: new Date().toISOString().slice(0, 10),
  } })
  expect(response.status()).toBe(201)
  const { id } = await response.json() as { id: string }
  const path = `/api/tasks/${id}`
  const release = deferred<void>()
  try {
    await page.route("**/api/rules", route => route.fulfill({ json: { ok: true, data: [
      { ruleType: "strategic-lens", taskTypes: ["story"], lensIds: ["rice"] },
      { ruleType: "strategic-lens", taskTypes: ["epic"], lensIds: ["ddd"] },
    ] } }))
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "PUT") return route.fallback()
      await release.promise
      await route.fulfill({ status: 400, json: { error: "Type is not available in this fixture" } })
    })
    await page.goto("/boards/household?view=timeline#timeline")
    await page.locator(`.gantt-milestone[data-task-id="${id}"]`).press("Enter")
    await page.getByRole("button", { name: "View Details →" }).click()
    const type = page.locator("#td-task-type")
    const framework = page.locator("#se-framework")
    await expect(type).toHaveValue("story")
    await expect(type).toBeEnabled()
    await expect(framework).toHaveValue("rice")

    const requestStarted = page.waitForRequest(request => new URL(request.url()).pathname === path
      && request.method() === "PUT", { timeout: 5000 })
    await type.selectOption("epic")
    await requestStarted
    await expect(framework).toHaveValue("rice")
    release.resolve()
    await expect(type).toHaveValue("story")
    await expect(framework).toHaveValue("rice")
    await page.unroute(`**${path}`)

    const refreshed = page.waitForResponse(result => new URL(result.url()).pathname === "/api/tasks"
      && result.request().method() === "GET", { timeout: 5000 })
    await type.selectOption("epic")
    const tasks = await (await refreshed).json()
    expect(tasks.tasks ?? tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id, task_type: "epic" })]))
    await expect(framework).toHaveValue("ddd")
    await expect(page.locator("#td-type-icon")).toHaveAttribute("title", "Epic")
  } finally {
    release.resolve()
    await request.delete(path, { headers })
  }
})
