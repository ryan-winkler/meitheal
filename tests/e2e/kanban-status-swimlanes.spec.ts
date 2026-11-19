import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test, type Browser } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
test.use({ serviceWorkers: "block" })

test("Household Kanban groups the current column page by status and keeps its counts and collapse state", async ({
  page, request, baseURL,
}) => {
  const origin = new URL(baseURL!).origin
  const headers = await currentBoardWriteHeaders(request, "household", { origin, "content-type": "application/json" })
  const label = `Mixed workflow ${randomUUID().slice(0, 8)}`
  const customStatus = "waiting_for_delivery"
  const cleanup: string[] = []

  async function create(path: string, data: Record<string, string | number>) {
    const response = await request.post(path, { headers, data })
    expect(response.status(), await response.text()).toBe(201)
    const result: { id: string; key?: string } = await response.json()
    cleanup.push(`${path}/${result.id}`)
    return result
  }

  try {
    const { id: area } = await create("/api/areas", { name: label })
    const { id: laneId, key } = await create("/api/lanes", { label })
    const updated = await request.put(`/api/lanes/${laneId}`, {
      headers, data: { includes: JSON.stringify(["pending", "active", customStatus]) },
    })
    expect(updated.status(), await updated.text()).toBe(200)

    const statuses = [
      { key: "pending", input: "pending", english: "Pending", irish: "Ar Feitheamh" },
      { key: "active", input: "in_progress", english: "Active", irish: "Gníomhach" },
      { key: customStatus, input: customStatus, english: customStatus, irish: customStatus },
    ]
    const tasks = []
    for (const status of statuses) {
      const { id } = await create("/api/tasks", {
        area_id: area, status: status.input, priority: 5, title: `${label} ${status.english}`,
      })
      tasks.push({ ...status, id })
    }
    // Priority sorts these cards ahead of the three target statuses.
    for (let index = 0; index < 25; index++) {
      await create("/api/tasks", {
        area_id: area, status: customStatus, priority: 2, title: `${label} filler ${index}`,
      })
    }

    await page.addInitScript(() => localStorage.setItem("meitheal-swimlane-pending", "collapsed"))
    // The toolbar emits its checked types in display order.
    await page.goto(`/tasks?area=${area}&types=shopping_item,standard_action#kanban`)
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const lane = page.locator(`.kanban-column[data-lane-id="${laneId}"]`)
    const cards = lane.locator(".kanban-card")
    const visibleGroups = lane.locator(".swimlane-group:not([hidden])")
    const range = lane.locator("[data-kanban-range]")
    const group = (status: string) => lane.locator(`.swimlane-group[data-swimlane-type="${status}"]:not([hidden])`)
    await expect(cards).toHaveCount(25)
    await expect(lane.locator(".kanban-count")).toHaveText("28")
    await expect(range).toHaveText("1–25 of 28")
    const total = await lane.getAttribute("data-total")

    const picker = page.locator("#kanban-group-by-dropdown")
    await picker.locator("summary").click()
    await picker.getByRole("button", { name: "By Status", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "status")
    await expect(visibleGroups).toHaveCount(1)
    await expect(group(customStatus).locator(".swimlane-count")).toHaveText("25")
    await expect(cards).toHaveCount(25)
    await expect(lane).toHaveAttribute("data-total", total!)
    await expect(lane.locator(".kanban-count")).toHaveText("28")
    await expect(range).toHaveText("1–25 of 28")
    await lane.getByRole("link", { name: "Next", exact: true }).click()

    const secondPage = (url: URL) => url.searchParams.get("groupBy") === "status" &&
      url.searchParams.get(`kp.${key}`) === "2"
    await expect(page).toHaveURL(secondPage)
    await expect(range).toHaveText("26–28 of 28")
    await expect(lane).toHaveAttribute("data-total", total!)
    await expect(lane.locator(".kanban-count")).toHaveText("28")
    await expect(cards).toHaveCount(3)
    await expect(visibleGroups.locator(".swimlane-label")).toHaveText(statuses.map(status => status.english))
    for (const task of tasks) {
      const grouped = group(task.key)
      await expect(grouped.locator(".swimlane-count")).toHaveText("1")
      await expect(grouped.locator(`.kanban-card[data-id="${task.id}"][data-status="${task.key}"]`)).toHaveCount(1)
    }

    await picker.locator("summary").click()
    await picker.getByRole("button", { name: "No grouping", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") !== "status" &&
      url.searchParams.get(`kp.${key}`) === "2")
    await expect(visibleGroups).toHaveCount(0)
    await expect(cards).toHaveCount(3)
    await picker.locator("summary").click()
    await picker.getByRole("button", { name: "By Status", exact: true }).click()
    await expect(page).toHaveURL(secondPage)
    await expect(range).toHaveText("26–28 of 28")
    await expect(visibleGroups.locator(".swimlane-label")).toHaveText(statuses.map(status => status.english))

    const pending = group("pending")
    const button = pending.locator("button.swimlane-header")
    const builtinPending = page.locator('.kanban-column[data-status="pending"]')
      .locator('.swimlane-group[data-swimlane-type="pending"] .swimlane-header')
    await expect(button).toHaveAccessibleName(/Pending/)
    await expect(button).toHaveAttribute("aria-expanded", "true")
    const pendingCards = pending.locator(".swimlane-cards")
    await expect(pendingCards).toHaveAttribute("id", /\S/)
    await expect(button).toHaveAttribute("aria-controls", (await pendingCards.getAttribute("id"))!)
    await button.press("Enter")
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await expect(pendingCards).toBeHidden()
    await expect(builtinPending).toHaveAttribute("aria-expanded", "true")
    await expect(group("active").locator(".swimlane-header")).toHaveAttribute("aria-expanded", "true")

    const preRefreshButton = await button.elementHandle()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expect.poll(() => preRefreshButton!.evaluate(element => element.isConnected)).toBe(false)
    await expect(button).toBeFocused()
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await expect(pendingCards).toBeHidden()

    await page.context().addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
    await page.reload()
    await expect(page).toHaveURL(secondPage)
    await expect(visibleGroups.locator(".swimlane-label")).toHaveText(statuses.map(status => status.irish))
    await expect(cards).toHaveCount(3)
    await expect(lane).toHaveAttribute("data-total", total!)
    await expect(lane.locator(".kanban-count")).toHaveText("28")
    await expect(range).toHaveText("26–28 as 28")
    await expect(button).toHaveAccessibleName(/Ar Feitheamh/)
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await expect(pendingCards).toBeHidden()
    await expect(builtinPending).toHaveAttribute("aria-expanded", "true")
    await button.press("Space")
    await expect(button).toHaveAttribute("aria-expanded", "true")
    await expect(pendingCards).toBeVisible()

    const taskId = tasks[0]!.id
    const card = lane.locator(`.kanban-card[data-id="${taskId}"]`)
    const cardLink = card.locator(".card-open-btn")
    const saved = await request.put(`/api/tasks/${taskId}`, { headers, data: { status: "active" } })
    expect(saved.ok(), await saved.text()).toBe(true)
    await cardLink.focus()
    // The detail drawer has already restored focus by the time this refresh applies.
    await page.evaluate(id => document.dispatchEvent(new CustomEvent("meitheal:task-status-saved", {
      detail: { id, status: "active" },
    })), taskId)
    await expect(card).toHaveAttribute("data-status", "active")
    await expect(cardLink).toBeFocused()
  } finally {
    for (const path of cleanup.reverse()) {
      const removed = await request.delete(path, { headers, data: {} })
      expect.soft(removed.ok(), `${path}: ${await removed.text()}`).toBe(true)
    }
  }
})

test("Ingress Kanban groups a stored legacy status with its canonical status", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-kanban-status-ingress-"))
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  try {
    child = startCoreFixture(work)
    child.stdout?.resume()
    child.stderr?.resume()
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const app = origin + fixture.configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "admin", url: origin }])
    const headers = await currentBoardWriteHeaders(context.request, "household", { origin, "content-type": "application/json" }, app)
    async function create(path: string, data: Record<string, string>) {
      const response = await context.request.post(app + path, { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      return (await response.json() as { id: string }).id
    }

    const laneId = await create("/api/lanes", { label: "Legacy mixed workflow" })
    const updated = await context.request.put(`${app}/api/lanes/${laneId}`, {
      headers, data: { includes: JSON.stringify(["active", "in_progress", "constructor"]) },
    })
    expect(updated.status(), await updated.text()).toBe(200)
    const canonical = await create("/api/tasks", { title: "Canonical status", status: "active" })
    const legacy = await create("/api/tasks", { title: "Legacy status", status: "active" })
    const custom = await create("/api/tasks", { title: "Custom status", status: "constructor" })
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      // Task creation normalizes aliases. Model an existing row from before normalization.
      const changed = db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run("in_progress", legacy)
      expect(changed.changes).toBe(1)
    } finally {
      db.close()
    }

    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const page = await context.newPage()
    await page.goto(`${app}/tasks?area=&groupBy=status#kanban`)
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const lane = page.locator(`.kanban-column[data-lane-id="${laneId}"]`)
    const groups = lane.locator(".swimlane-group:not([hidden])")
    await expect(lane).toHaveAttribute("data-total", "3")
    await expect(lane.locator(".kanban-count")).toHaveText("3")
    await expect(lane.locator(".kanban-card")).toHaveCount(3)
    await expect(groups.locator(".swimlane-label")).toHaveText(["Active", "constructor"])
    const active = lane.locator('.swimlane-group[data-swimlane-type="active"]')
    await expect(active.locator(".swimlane-count")).toHaveText("2")
    for (const id of [canonical, legacy]) {
      await expect(active.locator(`.kanban-card[data-id="${id}"]`)).toHaveCount(1)
    }
    const customGroup = lane.locator('.swimlane-group[data-swimlane-type="constructor"]')
    await expect(customGroup.locator(`.kanban-card[data-id="${custom}"]`)).toHaveCount(1)
  } finally {
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
