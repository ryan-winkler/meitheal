import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test, type Browser } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Timeline shows unavailable projects without revealing their IDs or labels", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-timeline-project-scope-"))
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
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    async function create(path: string, data: object): Promise<string> {
      const response = await context.request.post(app + path, { headers: { origin }, data })
      expect(response.status(), await response.text()).toBe(201)
      return (await response.json() as { id: string }).id
    }

    const retiredTitle = "Retired project title"
    const retiredProject = await create("/api/projects", { title: retiredTitle })
    const missingProject = randomUUID()
    const start = Date.now()
    const dates = {
      start_date: new Date(start).toISOString().slice(0, 10),
      due_date: new Date(start + 86_400_000).toISOString().slice(0, 10),
    }
    const prefix = "Timeline catalog scope"
    const retiredTask = await create("/api/tasks", { ...dates, title: `${prefix} retired`, project_id: retiredProject })
    const danglingTask = await create("/api/tasks", { ...dates, title: `${prefix} missing` })
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      // The public project lifecycle clears associations. Seed legacy references directly.
      expect(db.prepare("UPDATE projects SET retired_at = ? WHERE id = ?").run(start, retiredProject).changes).toBe(1)
      expect(db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(missingProject, danglingTask).changes).toBe(1)
    } finally {
      db.close()
    }

    const page = await context.newPage()
    const query = new URLSearchParams({ view: "timeline", search: prefix, area: "", groupBy: "project" })
    await page.goto(`${app}/tasks?${query}#timeline`)
    const data = (await page.locator("#timeline-data").textContent())!
    const labels = (await page.locator("#timeline-projects").textContent())!
    for (const value of [retiredProject, retiredTitle, missingProject]) {
      expect(data).not.toContain(value)
      expect(labels).not.toContain(value)
    }
    const tasks = JSON.parse(data) as { id: string; project_group: string }[]
    for (const id of [retiredTask, danglingTask]) {
      const task = tasks.find(task => task.id === id)
      expect(task?.project_group).toBe("unavailable-project")
      expect(task).not.toHaveProperty("project_id")
      await expect(page.locator(`.gantt-bar[data-task-id="${id}"]`)).toBeVisible()
    }
    const paneToggle = page.getByRole("button", { name: "Task pane" })
    await expect(paneToggle).toBeEnabled()
    if (await paneToggle.getAttribute("aria-expanded") === "false") await paneToggle.press("Enter")
    await expect(page.getByRole("heading", { name: "Group: Unknown Project", exact: true })).toBeVisible()
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


test("Timeline remounts project rows in visual keyboard order and keeps long-Area identity visible", async ({ page, request, baseURL }) => {
  test.setTimeout(90_000)
  const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json", "sec-fetch-site": "same-origin" }
  const prefix = `Timeline ordered ${randomUUID()}`
  const cleanup: string[] = []
  const cleanupFailures: string[] = []
  async function create(path: string, data: object): Promise<string> {
    const response = await request.post(path, { headers, data })
    expect(response.status(), await response.text()).toBe(201)
    const id = (await response.json() as { id: string }).id
    cleanup.push(`${path}/${id}`)
    return id
  }
  try {
    const area = await create("/api/areas", { name: "A long household Area name that must not conceal the distinguishing project identity token" })
    const start_date = new Date().toISOString().slice(0, 10)
    const due_date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const ids: string[] = []
    for (let index = 0; index < 45; index++) {
      const project = await create("/api/projects", { title: index < 2 ? "A shared project" : `Ordered project ${String(index).padStart(2, "0")}`, area_id: area })
      ids.push(project)
      await create("/api/tasks", { title: `${prefix} ${index}`, project_id: project, start_date, due_date })
    }
    await page.goto(`/tasks?view=timeline&search=${encodeURIComponent(prefix)}&area=&groupBy=project#timeline`)
    const pane = page.getByRole("button", { name: "Task pane" })
    if (await pane.getAttribute("aria-expanded") === "false") await pane.click()
    const headings = page.locator('.gantt-sidebar-row[role="heading"]')
    await expect(headings.first()).toBeVisible()
    const shared = headings.filter({ hasText: "A shared project" })
    await expect(shared).toHaveCount(2)
    const qualifiers = shared.locator(".gantt-sidebar-group-qualifier")
    expect(await qualifiers.allTextContents()).toEqual(expect.arrayContaining(ids.slice(0, 2).map(id => expect.stringContaining(`#${id.slice(-8)} · `))))
    for (const element of await qualifiers.all()) {
      expect(await element.evaluate(node => {
        const range = document.createRange()
        range.setStart(node.firstChild!, 0)
        range.setEnd(node.firstChild!, 9)
        return range.getBoundingClientRect().right <= node.getBoundingClientRect().right + 1
      })).toBe(true)
    }
    const firstToggle = headings.first().locator("button")
    await firstToggle.focus()
    const firstNode = await firstToggle.elementHandle()
    await page.locator(".gantt-scroll-wrapper").evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll")) })
    await expect.poll(() => page.locator('.gantt-sidebar-row[data-row-index="88"]').count()).toBe(1)
    await expect(firstToggle).toBeFocused()
    const remounted = await page.locator(".gantt-scroll-wrapper").evaluate(node => {
      node.scrollTop = Math.max(0, node.scrollTop - node.clientHeight / 2)
      const height = document.querySelector<HTMLElement>(".gantt-sidebar-row")!.getBoundingClientRect().height
      node.dispatchEvent(new Event("scroll"))
      return Math.max(0, Math.floor(node.scrollTop / height) - 8)
    })
    await expect.poll(() => page.locator(`.gantt-sidebar-row[data-row-index="${remounted}"]`).count()).toBe(1)
    const order = await page.locator(".gantt-sidebar-row").evaluateAll(nodes => nodes.map(node => Number((node as HTMLElement).dataset.rowIndex)))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(await firstNode!.evaluate(node => node.isConnected)).toBe(true)
    await page.locator(".gantt-scroll-wrapper").evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event("scroll")) })
    await expect.poll(() => page.locator('.gantt-sidebar-row[data-row-index="1"]').count()).toBe(1)
    await expect(headings.nth(1)).toBeVisible()
    await firstToggle.press("Tab")
    await expect(page.locator('.gantt-sidebar-row[data-row-index="1"]')).toBeFocused()
    const secondToggle = headings.nth(1).locator("button")
    const stops = await page.locator('.gantt-sidebar-row[data-row-index="1"]').locator('button, input, select, textarea, a[href], [tabindex="0"]').count() + 2
    for (let index = 0; index < stops && !await secondToggle.evaluate(node => node === document.activeElement); index++) {
      await page.keyboard.press("Tab")
      const row = await page.evaluate(() => document.activeElement?.closest<HTMLElement>(".gantt-sidebar-row")?.dataset.rowIndex)
      expect(row).toBeDefined()
      expect(Number(row)).toBeLessThanOrEqual(2)
    }
    await expect(secondToggle).toBeFocused()
  } finally {
    for (const path of cleanup.reverse()) {
      const response = await request.delete(path, { headers })
      if (!response.ok()) cleanupFailures.push(`${path}: ${response.status()} ${await response.text()}`)
    }
  }
  expect(cleanupFailures).toEqual([])
})
