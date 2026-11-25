import { expect, test, type Locator, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block", reducedMotion: "reduce", viewport: { width: 1440, height: 1100 } })

async function drag(page: Page, source: Locator, destination: Locator, nearTop = false) {
  await source.scrollIntoViewIfNeeded()
  await destination.scrollIntoViewIfNeeded()
  await expect(source).toBeInViewport()
  await expect(destination).toBeInViewport()
  const start = (await source.boundingBox())!
  const target = (await destination.boundingBox())!
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  try {
    await page.mouse.move(target.x + target.width / 2, target.y + (nearTop ? 6 : target.height / 2), { steps: 20 })
  } finally {
    await page.mouse.up()
  }
}

test("card moves preserve the grouping even when the destination lane has no matching group", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const ids = []
  for (const [title, status, priority] of [["High priority fixture", "pending", 1], ["Different group fixture", "active", 3]] as const) {
    const response = await request.post("/api/tasks", { headers, data: { title, status, priority } })
    expect(response.status()).toBe(201)
    ids.push((await response.json()).id as string)
  }
  const [id] = ids
  const path = `/api/tasks/${id}`
  const url = "/tasks?view=kanban&groupBy=priority#kanban"
  try {
    await page.goto(url)
    const board = page.locator("#kanban-board")
    await expect(board).toHaveAttribute("data-sorting-ready", "true")
    const active = board.locator('.kanban-column[data-status="active"]')
    const pending = board.locator('.kanban-column[data-status="pending"]')
    const card = page.locator(`.kanban-card[data-id="${id}"]`)
    const high = '.swimlane-group[data-swimlane-type="1"]'
    await expect(active.locator(high)).toHaveCount(0)
    const moved = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "PUT")
    await drag(page, card.locator(".kanban-title-text"), active.locator(".kanban-column-header"))
    expect((await moved).status()).toBe(200)
    await expect(active.locator(high).locator(card)).toBeVisible()
    expect(await (await request.get(path)).json()).toMatchObject({ status: "active", priority: 1 })

    await page.reload()
    await expect(active.locator(high).locator(card)).toBeVisible()
    await card.locator(".card-more-btn").press("Enter")
    await page.getByRole("group", { name: "Task actions", exact: true })
      .getByRole("button", { name: "Todo", exact: true }).press("Enter")
    await expect(pending.locator(high).locator(card)).toBeVisible()
    await expect.poll(async () => (await (await request.get(path)).json()).status).toBe("pending")
    expect(await (await request.get(path)).json()).toMatchObject({ priority: 1 })
  } finally {
    await Promise.all(ids.map(taskId => request.delete(`/api/tasks/${taskId}`, { headers })))
  }
})

test("groups reorder by grip, menu and keyboard and keep their order after reload", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const ids = []
  for (const priority of [1, 2, 3]) {
    const response = await request.post("/api/tasks", { headers, data: { title: `Priority group ${priority}`, status: "pending", priority } })
    expect(response.status()).toBe(201)
    ids.push((await response.json()).id as string)
  }
  try {
    await page.goto("/tasks?view=kanban&groupBy=priority#kanban")
    const board = page.locator("#kanban-board")
    await expect(board).toHaveAttribute("data-sorting-ready", "true")
    const lane = board.locator('.kanban-column[data-status="pending"]')
    const groups = lane.locator(".swimlane-group.dynamic-group")
    const group = (priority: number) => lane.locator(`.swimlane-group[data-swimlane-type="${priority}"]`)
    const grip = (priority: number) => group(priority).locator(".swimlane-grip")
    const order = () => groups.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.swimlaneType))
    await expect.poll(order).toEqual(["1", "2", "3"])
    await grip(2).press("Alt+ArrowUp")
    await expect.poll(order).toEqual(["2", "1", "3"])
    await expect(grip(2)).toBeFocused()

    await grip(2).click()
    await group(2).getByRole("button", { name: "Move down", exact: true }).click()
    await expect.poll(order).toEqual(["1", "2", "3"])
    await drag(page, grip(3), group(1).locator(".swimlane-header"), true)
    await expect.poll(order).toEqual(["3", "1", "2"])
    await page.reload()
    await expect.poll(order).toEqual(["3", "1", "2"])
    await expect(group(1).locator(`.kanban-card[data-id="${ids[0]}"]`)).toBeVisible()
  } finally {
    await Promise.all(ids.map(id => request.delete(`/api/tasks/${id}`, { headers })))
  }
})
