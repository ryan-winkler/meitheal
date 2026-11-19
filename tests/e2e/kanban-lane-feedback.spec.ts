import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

test("lane hover keeps its dimensions and a rejected move clears its pending cue", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const created = await request.post("/api/tasks", {
    headers, data: { title: "Lane feedback fixture", status: "pending" },
  })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const path = "/api/tasks/" + id
  const release = deferred<void>()
  try {
    await page.route(url => url.pathname === path, async route => {
      if (route.request().method() !== "PUT") return route.continue()
      await release.promise
      await route.fulfill({ status: 409, json: { blocked_by: [{ id: "fixture" }] } })
    })
    await page.goto("/boards/household?view=kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const lane = page.locator('.kanban-column[data-status="active"]')
    const source = page.locator('.kanban-column[data-status="pending"] .kanban-card[data-id="' + id + '"]')
    const target = lane.locator(".kanban-column-header")
    const listSize = () => lane.locator(".kanban-cards").evaluate(el => ({ height: el.scrollHeight, top: el.scrollTop }))
    const resting = await listSize()
    const title = target.locator(".kanban-column-title")
    const count = target.locator(".kanban-count")
    await title.dispatchEvent("dragover", { bubbles: true, cancelable: true })
    await expect(lane).toHaveClass(/drag-over/)
    expect(await listSize()).toEqual(resting)
    const next = await count.elementHandle()
    await title.dispatchEvent("dragleave", { bubbles: true, relatedTarget: next })
    await expect(lane).toHaveClass(/drag-over/)
    expect(await listSize()).toEqual(resting)
    const response = page.waitForResponse(receipt => new URL(receipt.url()).pathname === path && receipt.request().method() === "PUT")
    await source.dragTo(target, { sourcePosition: { x: 100, y: 35 } })
    const cue = lane.locator("[data-kanban-move-status]")
    await expect(cue).toHaveText("Moving task…")
    await expect(cue).toBeInViewport()
    await expect(source).toHaveAttribute("aria-busy", "true")
    await expect(lane.locator('.kanban-card[data-id="' + id + '"]')).toHaveCount(0)
    expect(await listSize()).toEqual(resting)

    release.resolve()
    expect((await response).status()).toBe(409)
    await expect(cue).toBeEmpty()
    await expect(lane).not.toHaveClass(/drag-over/)
    await expect(source).toBeVisible()
    await expect(page.getByText("Finish the blocking tasks before moving this one into progress.")).toBeVisible()
  } finally {
    release.resolve()
    await request.delete(path, { headers, data: {} })
  }
})

test("two lane writes settle before the queued Board refresh replaces their cards", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const ids: string[] = []
  const gates = [deferred<void>(), deferred<void>()] as const
  try {
    for (const title of ["First lane write", "Second lane write"]) {
      const response = await request.post("/api/tasks", { headers, data: { title, status: "pending" } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    for (const [index, id] of ids.entries()) {
      await page.route(url => url.pathname === "/api/tasks/" + id, async route => {
        if (route.request().method() !== "PUT") return route.continue()
        await gates[index]!.promise
        await route.continue()
      })
    }
    await page.goto("/boards/household?view=kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const lane = page.locator('.kanban-column[data-status="active"]')
    const cue = lane.locator("[data-kanban-move-status]")
    const target = lane.locator(".kanban-column-header")
    const pending = (id: string) => page.locator('.kanban-column[data-status="pending"] .kanban-card[data-id="' + id + '"]')
    let reads = 0
    page.on("request", req => {
      if (new URL(req.url()).searchParams.has("boardRefresh")) reads++
    })

    for (const id of ids) {
      await pending(id).dragTo(target, { sourcePosition: { x: 100, y: 35 } })
      await expect(pending(id)).toHaveAttribute("aria-busy", "true")
    }
    const first = page.waitForResponse(res => new URL(res.url()).pathname === "/api/tasks/" + ids[0] && res.request().method() === "PUT")
    gates[0].resolve()
    expect((await first).status()).toBe(200)
    await expect(pending(ids[0]!)).not.toHaveAttribute("aria-busy")
    await expect(cue).toHaveText("Moving task…")
    expect(reads).toBe(0)
    gates[1].resolve()
    for (const id of ids) await expect(lane.locator('.kanban-card[data-id="' + id + '"]')).toBeVisible()
    await expect(cue).toBeEmpty()
    expect(reads).toBe(1)
  } finally {
    for (const gate of gates) gate.resolve()
    for (const id of ids) await request.delete("/api/tasks/" + id, { headers, data: {} })
  }
})

test("a saved move reconciles the latest filter after its original Board is replaced", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const title = "Detached lane move fixture"
  const created = await request.post("/api/tasks", { headers, data: { title, status: "pending" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const path = "/api/tasks/" + id
  const release = deferred<void>()
  try {
    await page.route(url => url.pathname === path, async route => {
      if (route.request().method() === "PUT") await release.promise
      return route.continue()
    })
    await page.goto("/boards/household?view=kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const lane = page.locator('.kanban-column[data-status="active"]')
    const card = page.locator('.kanban-card[data-id="' + id + '"]')
    const previous = await page.locator("#kanban-board").elementHandle()
    await card.dragTo(lane.locator(".kanban-column-header"), { sourcePosition: { x: 100, y: 35 } })
    await expect(card).toHaveAttribute("aria-busy", "true")
    const search = page.getByRole("textbox", { name: "Filter by text" })
    await search.fill(title)
    await page.waitForFunction(board => !board!.isConnected, previous)
    await expect(page).toHaveURL(url => url.searchParams.get("search") === title)
    await expect(card).toHaveCount(1)
    await expect(card).not.toHaveAttribute("aria-busy")

    release.resolve()
    await expect(lane.locator(card)).toBeVisible()
    await expect(page).toHaveURL(url => url.searchParams.get("search") === title)
    await expect(search).toBeFocused()
  } finally {
    release.resolve()
    await request.delete(path, { headers, data: {} })
  }
})

test("a saved move holds its WIP slot while the Board refresh is pending", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const ids: string[] = []
  const release = deferred<void>()
  try {
    for (const title of ["WIP reservation fixture A", "WIP reservation fixture B"]) {
      const response = await request.post("/api/tasks", { headers, data: { title, status: "pending" } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    await page.route(url => url.searchParams.has("boardRefresh"), async route => {
      await release.promise
      await route.continue()
    })
    await page.goto("/boards/household?view=kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const lane = page.locator('.kanban-column[data-status="active"]')
    await lane.evaluate(el => { el.setAttribute("data-wip-limit", String(Number(el.getAttribute("data-total")) + 1)) })
    const target = lane.locator(".kanban-column-header")
    const drag = (id: string) => page.locator('.kanban-card[data-id="' + id + '"]')
      .dragTo(target, { sourcePosition: { x: 100, y: 35 } })
    const read = page.waitForRequest(req => new URL(req.url()).searchParams.has("boardRefresh"))
    await drag(ids[0]!)
    await read
    await expect(page.locator('.kanban-card[data-id="' + ids[0] + '"]')).toHaveAttribute("draggable", "false")
    await drag(ids[1]!)
    await expect(page.getByText(/has reached its work-in-progress limit/)).toBeVisible()
    expect((await (await request.get("/api/tasks/" + ids[1])).json()).status).toBe("pending")
    const untouchedControl = page.locator('.kanban-card[data-id="' + ids[1] + '"] .card-open-btn')
    await untouchedControl.focus()
    release.resolve()
    await expect(lane.locator('.kanban-card[data-id="' + ids[0] + '"]')).toBeVisible()
    await expect(untouchedControl).toBeFocused()
  } finally {
    release.resolve()
    for (const id of ids) await request.delete("/api/tasks/" + id, { headers, data: {} })
  }
})

test("a lane menu move preserves focus and scroll on another destination card", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const ids: string[] = []
  const release = deferred<void>()
  try {
    for (const [title, status] of [
      ["Menu lane move", "pending"], ["Existing destination task", "active"], ["Other destination task", "active"],
    ]) {
      const response = await request.post("/api/tasks", { headers, data: { title, status } })
      expect(response.status()).toBe(201)
      ids.push((await response.json()).id)
    }
    await page.route(url => url.searchParams.has("boardRefresh"), async route => {
      await release.promise
      await route.continue()
    })
    await page.goto("/boards/household?view=kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await page.addStyleTag({ content: ".kanban-cards { max-height: 90px !important; }" })
    const source = page.locator('.kanban-card[data-id="' + ids[0] + '"]')
    const destination = page.locator('.kanban-column[data-status="active"]')
    const destinationList = destination.locator(".kanban-cards")
    const read = page.waitForRequest(req => new URL(req.url()).searchParams.has("boardRefresh"))
    await source.locator(".card-more-btn").press("Enter")
    await page.getByRole("group", { name: "Task actions", exact: true }).getByRole("button", { name: "In Progress" }).press("Enter")
    await read

    const otherCard = destination.locator('.kanban-card[data-id="' + ids[1] + '"] .card-open-btn')
    await otherCard.focus()
    const scrollBefore = await destinationList.evaluate(list => {
      list.scrollTop = 40
      return list.scrollTop
    })
    expect(scrollBefore).toBeGreaterThan(0)
    release.resolve()
    await expect(destination.locator(source)).toBeAttached()
    await expect(otherCard).toBeFocused()
    const scrollAfter = await destinationList.evaluate(list => list.scrollTop)
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(1)
  } finally {
    release.resolve()
    for (const id of ids) await request.delete("/api/tasks/" + id, { headers, data: {} })
  }
})
