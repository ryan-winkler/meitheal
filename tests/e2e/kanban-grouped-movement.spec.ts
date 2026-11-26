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
    await expect(active.locator(".swimlane-grip:visible")).toHaveCount(0)
    await expect(pending.locator(".swimlane-grip:visible")).toHaveCount(0)
    const moved = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "PUT")
    await drag(page, card.locator(".kanban-title-text"), active.locator(".kanban-column-header"))
    expect((await moved).status()).toBe(200)
    await expect(active.locator(high).locator(card)).toBeVisible()
    await expect(active.locator(".swimlane-grip:visible")).toHaveCount(2)
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

test("Type drops preserve the group on a lane, roll back on failure and convert on a group heading", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const response = await request.post("/api/tasks", { headers, data: { title: "Story for empty lane", task_type: "story" } })
  expect(response.status()).toBe(201)
  const { id } = await response.json() as { id: string }
  const path = `/api/tasks/${id}`
  try {
    await page.goto("/tasks?view=kanban&groupBy=type#kanban")
    const board = page.locator("#kanban-board")
    await expect(board).toHaveAttribute("data-sorting-ready", "true")
    const pending = board.locator('.kanban-column[data-status="pending"]')
    const active = board.locator('.kanban-column[data-status="active"]')
    const story = '.swimlane-group[data-swimlane-type="story"]'
    const card = page.locator(`.kanban-card[data-id="${id}"]`)
    await expect(active.locator(story)).toBeVisible()
    await expect(active.locator(".kanban-card")).toHaveCount(0)
    await drag(page, card.locator(".kanban-title-text"), pending.locator(".kanban-column-header"))
    await expect(pending.locator(story).locator(card)).toBeVisible()
    await expect(card).not.toHaveAttribute("aria-busy", "true")

    await page.route(`**${path}`, async route => {
      await expect(active.locator(story).locator(card)).toBeVisible()
      await route.fulfill({ status: 409, json: { error: "Fixture rejected the move" } })
    }, { times: 1 })
    const rejected = page.waitForResponse(result => new URL(result.url()).pathname === path && result.request().method() === "PUT")
    await drag(page, card.locator(".kanban-title-text"), active.locator(".kanban-column-header"))
    expect((await rejected).status()).toBe(409)
    await expect(pending.locator(story).locator(card)).toBeVisible()
    await expect(active.locator(story).locator(".swimlane-count")).toHaveText("0")
    expect(await (await request.get(path)).json()).toMatchObject({ status: "pending", task_type: "story" })

    const tasks = active.locator('.swimlane-group[data-swimlane-type="task"]')
    const converted = page.waitForResponse(result => new URL(result.url()).pathname === path && result.request().method() === "PUT")
    await drag(page, card.locator(".kanban-title-text"), tasks.locator(".swimlane-header"))
    const conversion = await converted
    expect(conversion.status()).toBe(200)
    expect(conversion.request().postDataJSON()).toMatchObject({ status: "active", task_type: "task" })
    await expect(tasks.locator(card)).toBeVisible()
    expect(await (await request.get(path)).json()).toMatchObject({ status: "active", task_type: "task" })
  } finally {
    await request.delete(path, { headers })
  }
})

for (const [surface, selector] of [
  ["heading", ".swimlane-header"],
  ["empty list", ".swimlane-cards"],
  ["Add Epic row", ".swimlane-add-btn"],
] as const) {
  for (const status of ["pending", "active"] as const) {
    test(`Story changes to Epic on the ${surface} in the ${status} lane`, async ({ page, request, baseURL }) => {
      const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
      const created = await request.post("/api/tasks", { headers, data: {
        title: `Convert Story using ${surface} in ${status}`, status: "pending", task_type: "story",
      } })
      expect(created.status()).toBe(201)
      const { id } = await created.json() as { id: string }
      const path = `/api/tasks/${id}`
      try {
        await page.goto("/tasks?view=kanban&groupBy=type#kanban")
        const board = page.locator("#kanban-board")
        await expect(board).toHaveAttribute("data-sorting-ready", "true")
        const cardSelector = `.kanban-card[data-id="${id}"]`
        const card = board.locator(cardSelector)
        const epic = board.locator(`.kanban-column[data-status="${status}"] .swimlane-group[data-swimlane-type="epic"]`)
        await expect(epic.locator(".kanban-card")).toHaveCount(0)
        await expect(card).toHaveAttribute("data-version", /^\d+$/)
        const previousVersion = Number(await card.getAttribute("data-version"))
        await page.evaluate(() => {
          document.addEventListener("pointerup", event => {
            const target = document.elementFromPoint(event.clientX, event.clientY)
            const type = target?.closest<HTMLElement>(".swimlane-group")?.dataset.swimlaneType
            const lane = target?.closest<HTMLElement>(".kanban-column")?.dataset.status
            document.documentElement.dataset.typeDropContact = `${lane}/${type}`
          }, { capture: true, once: true })
          window.addEventListener("meitheal:task-type-changed", event => {
            document.documentElement.dataset.typeChangeEvent = JSON.stringify((event as CustomEvent).detail)
          }, { once: true })
        })
        const [response] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "PUT", { timeout: 5000 }),
          drag(page, card.locator(".kanban-title-text"), epic.locator(selector)),
        ])
        await expect(page.locator("html")).toHaveAttribute("data-type-drop-contact", `${status}/epic`)
        expect(response.status()).toBe(200)
        expect(response.request().postDataJSON()).toEqual(status === "active"
          ? { status, task_type: "epic", updated_at: previousVersion } : { task_type: "epic", updated_at: previousVersion })
        const feedback = status === "active" ? "Changed type to Epic and moved to In Progress" : "Changed type to Epic"
        await expect(page.getByRole("status").filter({ hasText: feedback })).toBeVisible()
        const saved = await (await request.get(path)).json()
        expect(saved).toMatchObject({ status, task_type: "epic" })
        const event = await page.locator("html").getAttribute("data-type-change-event")
        expect(JSON.parse(event ?? "null")).toEqual({ taskId: id, taskType: "epic", version: saved.task_version, previousVersion, status })

        await page.reload()
        await expect(epic.locator(cardSelector)).toBeVisible()
      } finally {
        await request.delete(path, { headers })
      }
    })
  }
}

for (const rejection of ["hierarchy", "version"] as const) {
  test(`a ${rejection} conflict restores the original Type without a change event`, async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
    const ids: string[] = []
    const create = async (data: { title: string; task_type: string; parent_id?: string }) => {
      const response = await request.post("/api/tasks", { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      const { id } = await response.json() as { id: string }
      ids.unshift(id)
      return id
    }
    try {
      const parent = rejection === "hierarchy" ? await create({ title: "Parent Story", task_type: "story" }) : undefined
      const originalType = parent ? "task" : "story"
      const id = await create({ title: "Type conversion conflict", task_type: originalType, parent_id: parent })
      const path = `/api/tasks/${id}`
      await page.goto("/tasks?view=kanban&groupBy=type#kanban")
      const board = page.locator("#kanban-board")
      await expect(board).toHaveAttribute("data-sorting-ready", "true")
      const lane = board.locator('.kanban-column[data-status="pending"]')
      const cardSelector = `.kanban-card[data-id="${id}"]`
      const card = lane.locator(cardSelector)
      const epic = lane.locator('.swimlane-group[data-swimlane-type="epic"]')
      await page.evaluate(() => {
        window.addEventListener("meitheal:task-type-changed", () => {
          document.documentElement.dataset.typeChangeEvent = "true"
        }, { once: true })
      })
      if (rejection === "version") {
        await page.route(`**${path}`, async route => {
          const edit = await request.patch(path, { headers, data: { title: "Title saved concurrently" } })
          expect(edit.status()).toBe(200)
          await route.continue()
        }, { times: 1 })
      }
      const [response] = await Promise.all([
        page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === "PUT"),
        drag(page, card.locator(".kanban-title-text"), epic.locator(".swimlane-header")),
      ])
      expect(response.status()).toBe(parent ? 400 : 409)
      const problem = parent ? "Cannot nest epic under a story" : "task was modified since your last read"
      await expect(page.getByRole("alert").filter({ hasText: problem })).toBeVisible()
      await expect(lane.locator(`.swimlane-group[data-swimlane-type="${originalType}"]`).locator(cardSelector)).toBeVisible()
      await expect(page.locator("html")).not.toHaveAttribute("data-type-change-event")
      const saved = await (await request.get(path)).json()
      expect(saved).toMatchObject(parent ? { task_type: originalType, parent_id: parent }
        : { task_type: originalType, title: "Title saved concurrently" })
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
    }
  })
}

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
    await expect(lane.locator(".swimlane-grip:visible")).toHaveCount(3)
    await grip(1).click()
    await expect(group(1).getByRole("button", { name: "Move up", exact: true })).toBeHidden()
    await expect(group(1).getByRole("button", { name: "Move down", exact: true })).toBeVisible()
    await grip(1).press("Escape")
    await grip(3).click()
    await expect(group(3).getByRole("button", { name: "Move up", exact: true })).toBeVisible()
    await expect(group(3).getByRole("button", { name: "Move down", exact: true })).toBeHidden()
    await grip(3).press("Escape")
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

test("a single Area group fits a narrow lane and follows live theme tokens", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const name = "Workshop tools and seasonal maintenance supplies for the garden"
  const areaResponse = await request.post("/api/areas", { headers, data: { name, icon: "📁" } })
  expect(areaResponse.status(), await areaResponse.text()).toBe(201)
  const { id: areaId } = await areaResponse.json() as { id: string }
  let taskId: string | undefined
  try {
    const response = await request.post("/api/tasks", { headers, data: { title: "Sort workshop shelves", area_id: areaId } })
    expect(response.status(), await response.text()).toBe(201)
    taskId = (await response.json()).id as string
    await page.setViewportSize({ width: 320, height: 900 })
    await page.emulateMedia({ colorScheme: "light" })
    await page.goto("/tasks?view=kanban&groupBy=area#kanban")
    const board = page.locator("#kanban-board")
    await expect(board).toHaveAttribute("data-sorting-ready", "true")
    const lane = board.locator('.kanban-column[data-status="pending"]')
    const group = lane.locator(".swimlane-group:visible")
    await expect(group).toHaveCount(1)
    await expect(group.locator(".swimlane-label")).toHaveText(name)
    await expect(group.locator(".swimlane-grip")).toBeHidden()
    const header = group.locator(".swimlane-header")
    await header.press("Enter")
    await expect(header).toHaveAttribute("aria-expanded", "false")
    await header.press("Enter")
    await expect(header).toHaveAttribute("aria-expanded", "true")
    const original = await group.elementHandle()

    const measure = () => group.evaluate(element => {
      const lane = element.closest(".kanban-column")!
      const header = element.querySelector<HTMLElement>(".swimlane-header")!
      const board = lane.closest<HTMLElement>("#kanban-board")!
      const inside = (child: Element, parent: Element) => {
        const content = child.getBoundingClientRect()
        const bounds = parent.getBoundingClientRect()
        return content.left >= bounds.left - 1 && content.right <= bounds.right + 1
      }
      const probe = element.ownerDocument.createElement("span")
      probe.hidden = true
      probe.style.backgroundColor = "var(--bg-secondary)"
      probe.style.borderBottomColor = "var(--border)"
      probe.style.borderBottomLeftRadius = "var(--radius-lg)"
      element.append(probe)
      const tokens = (target: Element) => {
        const style = getComputedStyle(target)
        return [style.backgroundColor, style.borderBottomColor, style.borderBottomLeftRadius]
      }
      const styles = { actual: tokens(element), expected: tokens(probe) }
      probe.remove()
      return {
        ...styles,
        fit: inside(element, lane) && inside(lane, board) && inside(header, element)
          && inside(header.querySelector(".swimlane-count")!, header) && header.scrollWidth <= header.clientWidth + 1,
      }
    })
    const html = page.locator("html")
    await expect(html).toHaveClass(/\blight\b/)
    const light = await measure()
    expect(light.actual).toEqual(light.expected)
    expect(light.fit).toBe(true)

    await page.emulateMedia({ colorScheme: "dark" })
    await expect(html).toHaveClass(/\bdark\b/)
    expect(await group.evaluate((element, original) => element === original, original)).toBe(true)
    await expect(async () => {
      const dark = await measure()
      expect(dark.actual).toEqual(dark.expected)
      expect(dark.actual[0]).not.toBe(light.actual[0])
      expect(dark.fit).toBe(true)
    }).toPass({ timeout: 5000 })
  } finally {
    if (taskId) await request.delete(`/api/tasks/${taskId}`, { headers })
    await request.delete(`/api/areas/${areaId}`, { headers })
  }
})
