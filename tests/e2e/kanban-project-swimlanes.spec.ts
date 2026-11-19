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

test("Household Kanban keeps Project identity, qualifiers and the current column page", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin, "content-type": "application/json" })
  const token = randomUUID().slice(0, 8)
  const prefix = `Project grouping ${token}`
  const title = `A long household project title that needs its Area kept visible ${token}`
  const kitchen = `Kitchen with an unusually long Area name for the household workshop ${token}`
  const garden = `Garden ${token}`
  const cleanup: string[] = []
  async function create(path: string, data: object): Promise<string> {
    const response = await request.post(path, { headers, data })
    expect(response.status(), await response.text()).toBe(201)
    const id = (await response.json() as { id: string }).id
    cleanup.push(`${path}/${id}`)
    return id
  }

  try {
    const kitchenId = await create("/api/areas", { name: kitchen })
    const gardenId = await create("/api/areas", { name: garden })
    const goal = await create("/api/goals", { title: `${prefix} goal`, area_id: gardenId })
    const direct = await create("/api/projects", { title, area_id: kitchenId })
    const inherited = await create("/api/projects", { title, goal_id: goal })
    const reserved = await create("/api/projects", { title: "No Project", area_id: kitchenId })
    const task = (suffix: string, project_id: string | null, status = "pending", priority = 5) =>
      create("/api/tasks", { title: `${prefix} ${suffix}`, project_id, status, priority })
    const directTask = await task("direct", direct)
    const inheritedTask = await task("inherited", inherited)
    const reservedTask = await task("reserved", reserved)
    const unassignedTask = await task("unassigned", null)
    const activeTask = await task("active", direct, "active")
    for (let index = 0; index < 25; index++) await task(`filler ${index}`, direct, "pending", 2)

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto(`/tasks?search=${encodeURIComponent(prefix)}&kp.pending=2#kanban`)
    const pending = page.locator('.kanban-column[data-status="pending"]')
    const active = page.locator('.kanban-column[data-status="active"]')
    const cards = pending.locator(".kanban-card")
    const range = pending.locator("[data-kanban-range]")
    const group = (column: typeof pending, id: string) => column.locator(`.dynamic-group[data-swimlane-type="project-${id}"]`)
    const label = (id: string) => group(pending, id).locator(".swimlane-label")
    const qualifier = (id: string) => group(pending, id).locator(".swimlane-qualifier")
    const header = (id: string) => group(pending, id).locator("button.swimlane-header")
    const card = (id: string) => pending.locator(`.kanban-card[data-id="${id}"]`)
    await expect(cards).toHaveCount(4)
    await expect(range).toHaveText("26–29 of 29")
    await expect(pending.locator(".kanban-count")).toHaveText("29")
    const total = await pending.getAttribute("data-total")
    const picker = page.locator("#kanban-group-by-dropdown")
    await picker.locator("summary").click()
    await picker.getByRole("button", { name: "By Project", exact: true }).click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "project" && url.searchParams.get("kp.pending") === "2")
    await expect(pending.locator(".dynamic-group")).toHaveCount(4)
    await expect(cards).toHaveCount(4)
    await expect(range).toHaveText("26–29 of 29")
    await expect(pending.locator(".kanban-count")).toHaveText("29")
    await expect(pending).toHaveAttribute("data-total", total!)
    await expect(label(direct)).toContainText(title)
    await expect(label(inherited)).toContainText(title)
    await expect(qualifier(direct)).toHaveText(`#${direct.slice(-8)} · ${kitchen}`)
    await expect(qualifier(inherited)).toHaveText(`#${inherited.slice(-8)} · ${garden}`)
    await expect(qualifier(direct)).toBeInViewport()
    await expect(qualifier(inherited)).toBeInViewport()
    expect(await qualifier(direct).evaluate(element => {
      const range = document.createRange()
      range.setStart(element.firstChild!, 0)
      range.setEnd(element.firstChild!, 9)
      return range.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1
    })).toBe(true)
    await expect(label(reserved)).toContainText("No Project")
    await expect(qualifier(reserved)).toHaveText(`#${reserved.slice(-8)} · ${kitchen}`)
    await expect(label("")).toHaveText("No Project")
    for (const [id, project] of [[directTask, direct], [inheritedTask, inherited], [reservedTask, reserved], [unassignedTask, ""]]) {
      await expect(group(pending, project!).locator(`.kanban-card[data-id="${id}"]`)).toHaveCount(1)
      await expect(group(pending, project!).locator(".swimlane-count")).toHaveText("1")
    }
    await expect(header(direct)).toHaveAccessibleName(new RegExp(kitchen))
    const controlled = await header(direct).getAttribute("aria-controls")
    expect(controlled).toBeTruthy()
    await expect(group(pending, direct).locator(".swimlane-cards")).toHaveAttribute("id", controlled!)
    await header(direct).press("Enter")
    await expect(header(direct)).toHaveAttribute("aria-expanded", "false")
    await expect(card(directTask)).toBeHidden()
    await expect(group(active, direct).locator("button.swimlane-header")).toHaveAttribute("aria-expanded", "true")
    await expect(active.locator(`.kanban-card[data-id="${activeTask}"]`)).toBeVisible()

    const renamedTitle = `Renamed project ${token}`
    const updated = await request.put(`/api/projects/${direct}`, { headers, data: { title: renamedTitle } })
    expect(updated.ok(), await updated.text()).toBe(true)
    const oldHeader = await header(direct).elementHandle()
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expect.poll(() => oldHeader!.evaluate(element => element.isConnected)).toBe(false)
    await expect(label(direct)).toHaveText(renamedTitle)
    await expect(header(direct)).toBeFocused()
    await expect(header(direct)).toHaveAttribute("aria-expanded", "false")
    await expect(card(directTask)).toBeHidden()
    await expect(card(inheritedTask)).toBeVisible()
    await header(direct).press("Space")
    await expect(card(directTask)).toBeVisible()
    const cardLink = card(directTask).locator(".card-open-btn")
    await cardLink.focus()
    const oldLink = await cardLink.elementHandle()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("meitheal:deferral-reconciled", {
      detail: { dataOnly: true },
    })))
    await expect.poll(() => oldLink!.evaluate(element => element.isConnected)).toBe(false)
    await expect(cardLink).toBeFocused()
    await expect(card(directTask)).toBeVisible()
    await page.reload()
    await expect(page).toHaveURL(url => url.searchParams.get("kp.pending") === "2")
    await expect(label(direct)).toHaveText(renamedTitle)
    await expect(label(inherited)).toContainText(title)
    await expect(cards).toHaveCount(4)
    await expect(pending).toHaveAttribute("data-total", total!)
    await header(direct).press("Enter")
    await expect(header(direct)).toHaveAttribute("aria-expanded", "false")
    expect((await request.delete(`/api/projects/${direct}`, { headers, data: {} })).ok()).toBe(true)
    cleanup.splice(cleanup.indexOf(`/api/projects/${direct}`), 1)
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    const refresh = page.getByRole("button", { name: "Refresh Board" })
    await expect(refresh).toBeFocused()
    await expect(page.locator("#kanban-board")).toHaveCount(0)
    await refresh.click()
    await expect(header(direct)).toHaveCount(0)
    const unavailable = pending.locator(".dynamic-group").filter({
      has: page.getByRole("button", { name: /^Unknown Project/ }),
    })
    await expect(unavailable.locator(`.kanban-card[data-id="${directTask}"]`)).toBeVisible()
    await expect(pending).not.toContainText(renamedTitle)
    await expect(range).toHaveText("26–29 of 29")
  } finally {
    const failures: string[] = []
    for (const path of cleanup.reverse()) {
      const response = await request.delete(path, { headers, data: {} })
      if (!response.ok()) failures.push(`${path}: ${response.status()} ${await response.text()}`)
    }
    expect(failures).toEqual([])
  }
})

test("Ingress Kanban hides unavailable Project references and recovers its catalog", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-kanban-project-scope-"))
  let child: ChildProcess | undefined
  let browser: Browser | undefined
  let db: DatabaseSync | undefined
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
    const headers = await currentBoardWriteHeaders(context.request, "household", { origin, "content-type": "application/json" }, app)
    async function create(path: string, data: object): Promise<string> {
      const response = await context.request.post(app + path, { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      return (await response.json() as { id: string }).id
    }
    const prefix = "Kanban project catalog scope"
    const retiredTitle = "Hidden retired project"
    const retired = await create("/api/projects", { title: retiredTitle })
    const recognized = await create("/api/projects", { title: "Known project" })
    const goalArea = await create("/api/areas", { name: "Inherited project Area" })
    const directArea = await create("/api/areas", { name: "Retired direct project Area" })
    const goal = await create("/api/goals", { title: "Project grouping inheritance goal", area_id: goalArea })
    const sharedTitle = "Scoped duplicate project"
    const invalidDirectProject = await create("/api/projects", { title: sharedTitle, area_id: directArea, goal_id: goal })
    const inheritedProject = await create("/api/projects", { title: sharedTitle, goal_id: goal })
    const dangling = randomUUID()
    const retiredTask = await create("/api/tasks", { title: `${prefix} retired`, project_id: retired })
    const danglingTask = await create("/api/tasks", { title: `${prefix} dangling` })
    const knownTask = await create("/api/tasks", { title: `${prefix} known`, project_id: recognized })
    const unassignedTask = await create("/api/tasks", { title: `${prefix} unassigned` })
    const invalidDirectTask = await create("/api/tasks", { title: `${prefix} invalid direct`, project_id: invalidDirectProject })
    const inheritedTask = await create("/api/tasks", { title: `${prefix} inherited`, project_id: inheritedProject })
    // The live fixture can still be writing when failure injection changes its schema.
    db = new DatabaseSync(join(work, "pins.db"), { timeout: 5_000 })
    expect(db.prepare("UPDATE projects SET retired_at = ? WHERE id = ?").run(Date.now(), retired).changes).toBe(1)
    expect(db.prepare("UPDATE areas SET retired_at = ? WHERE id = ?").run(Date.now(), directArea).changes).toBe(1)
    expect(db.prepare("UPDATE tasks SET project_id = ? WHERE id = ?").run(dangling, danglingTask).changes).toBe(1)
    const page = await context.newPage()
    const query = new URLSearchParams({ search: prefix, area: "", groupBy: "project" })
    const response = await page.goto(`${app}/tasks?${query}#kanban`)
    expect(response?.status()).toBe(200)
    const markup = (await response?.text())!
    for (const hidden of [retired, dangling, retiredTitle]) expect(markup).not.toContain(hidden)
    const lane = page.locator('.kanban-column[data-status="pending"]')
    const cards = lane.locator(".kanban-card")
    const unknown = lane.locator('.dynamic-group[data-swimlane-type="unavailable-project"]')
    const known = lane.locator(`.dynamic-group[data-swimlane-type="project-${recognized}"]`)
    await expect(cards).toHaveCount(6)
    await expect(unknown.locator(".swimlane-label")).toHaveText("Unknown Project")
    for (const id of [retiredTask, danglingTask]) await expect(unknown.locator(`.kanban-card[data-id="${id}"]`)).toBeVisible()
    await expect(known.locator(`.kanban-card[data-id="${knownTask}"]`)).toBeVisible()
    await expect(lane.locator('.dynamic-group[data-swimlane-type="project-"]')
      .locator(`.kanban-card[data-id="${unassignedTask}"]`)).toBeVisible()
    const directGroup = lane.locator(`.dynamic-group[data-swimlane-type="project-${invalidDirectProject}"]`)
    const inheritedGroup = lane.locator(`.dynamic-group[data-swimlane-type="project-${inheritedProject}"]`)
    await expect(directGroup.locator(`.kanban-card[data-id="${invalidDirectTask}"]`)).toBeVisible()
    await expect(inheritedGroup.locator(`.kanban-card[data-id="${inheritedTask}"]`)).toBeVisible()
    await expect(directGroup.locator(".swimlane-label")).toHaveText(sharedTitle)
    await expect(inheritedGroup.locator(".swimlane-label")).toHaveText(sharedTitle)
    // A present but unavailable direct Area must suppress Goal inheritance.
    await expect(directGroup.locator(".swimlane-qualifier")).toHaveText(`#${invalidDirectProject.slice(-8)}`)
    await expect(directGroup).not.toContainText("Inherited project Area")
    await expect(inheritedGroup.locator(".swimlane-qualifier")).toHaveText(`#${inheritedProject.slice(-8)} · Inherited project Area`)
    const total = await lane.getAttribute("data-total")

    // Break just the catalog's ordering query. Card visibility still uses IDs and scope.
    db.exec("ALTER TABLE projects RENAME COLUMN position TO unavailable_project_position")
    await page.reload()
    await expect(cards).toHaveCount(6)
    await expect(lane).toHaveAttribute("data-total", total!)
    await expect(unknown.locator(".swimlane-count")).toHaveText("5")
    await expect(unknown.locator(`.kanban-card[data-id="${knownTask}"]`)).toBeVisible()
    await expect(page.getByRole("status").filter({ hasText: "Project names could not load." })).toBeVisible()
    await expect(page.locator("[data-project-catalog-unavailable]")).toHaveCount(1)
    await expect(page.locator("#kanban-board [data-project-catalog-unavailable]")).toHaveCount(0)
    db.exec("ALTER TABLE projects RENAME COLUMN unavailable_project_position TO position")
    await page.reload()
    await expect(known.locator(".swimlane-label")).toHaveText("Known project")
    await expect(known.locator(`.kanban-card[data-id="${knownTask}"]`)).toBeVisible()
    await expect(unknown.locator(".swimlane-count")).toHaveText("2")
    await expect(cards).toHaveCount(6)
    await expect(lane).toHaveAttribute("data-total", total!)
    await context.addCookies([{ name: "meitheal-locale", value: "ga", url: origin }])
    await page.reload()
    await expect(unknown.locator(".swimlane-label")).toHaveText("Tionscadal Anaithnid")
    await expect(lane.locator('.dynamic-group[data-swimlane-type="project-"] .swimlane-label')).toHaveText("Gan Tionscadal")
  } finally {
    db?.close()
    await browser?.close()
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
