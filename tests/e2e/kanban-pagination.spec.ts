import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Tasks view loading and Kanban pages", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("renders only the selected view and preserves legacy hashes and navigation filters", async ({ page, request }) => {
    const views = ["kanban", "table", "calendar", "timeline"]
    for (const view of views) {
      const response = await request.get(`/tasks?view=${view}`)
      expect(response.status()).toBe(200)
      const html = await response.text()
      for (const candidate of views) {
        expect(html.includes(`id="tasks-view-${candidate}"`)).toBe(candidate === view)
      }
    }

    const inactiveRequests: string[] = []
    const recordRequest = (request: import("@playwright/test").Request) => {
      const url = new URL(request.url())
      if (url.pathname === "/tasks" && ["table", "calendar", "timeline"].includes(url.searchParams.get("view") ?? "")) {
        inactiveRequests.push(url.pathname + url.search)
      }
    }
    page.on("request", recordRequest)
    await page.goto("/tasks#kanban")
    await page.waitForLoadState("networkidle")
    await expect(page.locator("#tasks-view-kanban")).toBeVisible()
    expect(inactiveRequests).toEqual([])
    page.off("request", recordRequest)

    await page.goto("/tasks?status=active#calendar")
    await expect(page).toHaveURL(/view=calendar#calendar$/)
    await expect(page.locator("#tasks-view-calendar")).toBeVisible()
    await expect(page.locator("#tasks-view-kanban")).toHaveCount(0)
    await page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Table" }).click()
    await expect(page).toHaveURL(/status=active&view=table#table$/)
    await expect(page.locator("#tasks-view-table")).toBeVisible()
    await expect(page.locator("#tasks-view-calendar")).toHaveCount(0)
    await page.goBack()
    await expect(page.locator("#tasks-view-calendar")).toBeVisible()
  })

  test("paginates lanes, filters beyond the first page and reorders relative to off-page cards", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
    const prefix = `Paged repair ${randomUUID().slice(0, 8)}`
    const createdArea = await request.post("/api/areas", { headers, data: { name: prefix } })
    expect(createdArea.status()).toBe(201)
    const { id: area } = await createdArea.json()
    const ids: string[] = []
    const title = (i: number) => `${prefix} ${i === 0 ? "older radiator inspection" : `fixture ${i}`}`

    try {
      for (let i = 0; i < 28; i++) {
        const response = await request.post("/api/tasks", {
          headers,
          data: { area_id: area, title: title(i), status: "pending", due_date: i === 0 ? "2000-01-01" : null },
        })
        expect(response.status()).toBe(201)
        ids.push((await response.json()).id)
      }
      const completed = await request.post("/api/tasks", {
        headers,
        data: { area_id: area, title: `${prefix} completed`, status: "complete", due_date: "2000-01-01" },
      })
      expect(completed.status()).toBe(201)
      const completedId = (await completed.json()).id
      ids.push(completedId)

      await page.goto(`/tasks?area=${area}#kanban`)
      const lane = page.locator('.kanban-column[data-status="pending"]')
      const cards = lane.locator(".kanban-card")
      const range = lane.locator("[data-kanban-range]")
      const oldest = page.getByRole("button", { name: new RegExp(`^Task: ${title(0)},`) })
      await expect(cards).toHaveCount(25)
      await expect(lane.locator(".kanban-count")).toHaveText("28")
      await expect(range).toHaveText("1–25 of 28")
      await expect(oldest).toHaveCount(0)
      await expect.poll(() => cards.evaluateAll(elements => elements.every(card =>
        card.querySelector(".kanban-card-actions")!.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom,
      ))).toBe(true)

      await page.goto("/")
      const overdueLink = page.locator("#stat-overdue")
      await expect(overdueLink.locator(".stat-value")).toHaveText("1")
      await overdueLink.click()
      await expect(page).toHaveURL(/status=overdue(?:&|#|$)/)
      await expect(oldest).toBeVisible()
      await expect(lane.locator(".kanban-count")).toHaveText("1")
      await expect(lane).toHaveAttribute("data-total", "28")
      await expect(page.locator(`.kanban-card[data-id="${completedId}"]`)).toHaveCount(0)

      await page.goto(`/tasks?area=${area}#kanban`)
      await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
      await lane.getByRole("link", { name: "Next" }).press("Enter")
      await expect(range).toHaveText("26–28 of 28")
      await expect(range).toBeFocused()
      await expect(cards).toHaveCount(3)
      await expect(oldest).toBeVisible()
      await expect(page).toHaveURL(/kp\.pending=2/)
      await page.reload()
      await expect(range).toHaveText("26–28 of 28")

      await lane.getByRole("link", { name: "Previous" }).click()
      await expect(range).toHaveText("1–25 of 28")
      const searchRequest = (url: URL) => url.pathname === "/tasks" && url.searchParams.has("search")
      await page.route(searchRequest, route => route.fulfill({ status: 503, body: "fixture rejected" }))
      const search = page.getByRole("textbox", { name: "Filter by text" })
      await search.fill("older radiator inspection")
      const retry = page.getByRole("button", { name: "Retry board" })
      await expect(retry).toBeVisible()
      await expect(cards).toHaveCount(25)
      await page.unroute(searchRequest)
      await retry.click()
      await expect(cards).toHaveCount(1)
      await expect(oldest).toBeVisible()
      await expect(lane.locator(".kanban-count")).toHaveText("1")
      await expect(page).toHaveURL(/search=older\+radiator\+inspection/)
      await page.reload()
      await expect(search).toHaveValue("older radiator inspection")
      await expect(cards).toHaveCount(1)

      const reordered = await request.post("/api/tasks/reorder", { headers,
        data: { task_id: ids[0], anchor_id: ids[27], lane: "pending", before: true } })
      expect(reordered.status(), await reordered.text()).toBe(200)
      await page.goto(`/tasks?area=${area}#kanban`)
      await expect(cards.first()).toHaveAttribute("data-id", ids[0]!)
      await expect(cards.nth(1)).toHaveAttribute("data-id", ids[27]!)
      await lane.getByRole("link", { name: "Next" }).click()
      await expect(cards.last()).toHaveAttribute("data-id", ids[1]!)
      await expect(lane.locator(".kanban-count")).toHaveText("28")
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
      await request.delete(`/api/areas/${area}`, { headers })
    }
  })

  test("reordering a card leaves overlapping lanes in another area ordered", async ({ page, request, baseURL }) => {
    test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
    const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
    const suffix = randomUUID().slice(0, 8)
    const areas: string[] = []
    const lanes: string[] = []
    const tasks: string[] = []

    async function createArea(name: string): Promise<string> {
      const response = await request.post("/api/areas", { headers, data: { name } })
      expect(response.status(), await response.text()).toBe(201)
      const { id } = await response.json()
      areas.push(id)
      return id
    }

    async function createLane(label: string, includes: string[]): Promise<string> {
      const response = await request.post("/api/lanes", { headers, data: { label } })
      expect(response.status(), await response.text()).toBe(201)
      const { id, key } = await response.json()
      lanes.push(id)
      const updated = await request.put(`/api/lanes/${id}`, {
        headers, data: { includes: JSON.stringify(includes) },
      })
      expect(updated.status(), await updated.text()).toBe(200)
      return key
    }

    async function createTask(areaId: string, title: string, status: string): Promise<string> {
      const response = await request.post("/api/tasks", {
        headers, data: { area_id: areaId, title, status },
      })
      expect(response.status(), await response.text()).toBe(201)
      const { id } = await response.json()
      tasks.push(id)
      return id
    }

    try {
      const selected = await createArea(`Selected overlap ${suffix}`)
      const hidden = await createArea(`Hidden overlap ${suffix}`)
      const sourceLane = await createLane(`Source overlap ${suffix}`, ["pending", "active"])
      const otherLane = await createLane(`Other overlap ${suffix}`, ["active", "complete"])
      const moved = await createTask(selected, "Moved task", "pending")
      const anchor = await createTask(selected, "Anchor task", "active")
      const hiddenComplete = await createTask(hidden, "Hidden complete", "complete")
      const hiddenActive = await createTask(hidden, "Hidden active", "active")
      const seeded = await request.post("/api/tasks/reorder", {
        headers, data: { ordered_ids: [moved, hiddenComplete, hiddenActive, anchor] },
      })
      expect(seeded.status(), await seeded.text()).toBe(200)

      const laneCards = (key: string) => page.locator(`.kanban-column[data-status="${key}"] .kanban-card`)
      const hiddenCards = laneCards(otherLane)
      await page.goto(`/tasks?area=${hidden}#kanban`)
      await expect(hiddenCards).toHaveCount(2)
      await expect(hiddenCards.nth(0)).toHaveAttribute("data-id", hiddenComplete)
      await expect(hiddenCards.nth(1)).toHaveAttribute("data-id", hiddenActive)

      await page.goto(`/tasks?area=${selected}#kanban`)
      const reordered = await request.post("/api/tasks/reorder", {
        headers, data: { task_id: moved, anchor_id: anchor, lane: sourceLane, before: false },
      })
      expect(reordered.status(), await reordered.text()).toBe(200)
      await page.reload()
      const selectedCards = laneCards(sourceLane)
      await expect(selectedCards).toHaveCount(2)
      await expect(selectedCards.nth(0)).toHaveAttribute("data-id", anchor)
      await expect(selectedCards.nth(1)).toHaveAttribute("data-id", moved)

      const invalid = await request.post("/api/tasks/reorder", {
        headers, data: { task_id: moved, anchor_id: hiddenComplete, lane: sourceLane, before: false },
      })
      expect(invalid.status()).toBe(409)

      await page.goto(`/tasks?area=${hidden}#kanban`)
      await expect(hiddenCards).toHaveCount(2)
      await expect(hiddenCards.nth(0)).toHaveAttribute("data-id", hiddenComplete)
      await expect(hiddenCards.nth(1)).toHaveAttribute("data-id", hiddenActive)
    } finally {
      for (const id of tasks) await request.delete(`/api/tasks/${id}`, { headers })
      for (const id of lanes) await request.delete(`/api/lanes/${id}`, { headers })
      for (const id of areas) await request.delete(`/api/areas/${id}`, { headers })
    }
  })
})
