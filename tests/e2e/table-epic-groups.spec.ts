import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test } from "@playwright/test"

import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
test.use({ actionTimeout: 5_000, serviceWorkers: "block" })

test("Table restores Epic groups and subgroups and counts children whose parents are outside the page", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
  const token = randomUUID().slice(0, 8)
  const prefix = `Epic Table child ${token}`
  const cleanup: string[] = []
  async function create(title: string, fields: object = {}) {
    const response = await request.post("/api/tasks", { headers, data: { title, status: "pending", ...fields } })
    expect(response.status(), await response.text()).toBe(201)
    const task = await response.json() as { id: string; ticket_key: string }
    cleanup.push(`/api/tasks/${task.id}`)
    return task
  }
  try {
    const title = `Renovate & repair ${token}`
    const outer = await create(title, { task_type: "epic", status: "complete" })
    const inner = await create(title, { task_type: "epic", parent_id: outer.id, status: "active" })
    const story = await create(`Preparation ${token}`, { task_type: "story", parent_id: inner.id, status: "active" })
    const direct = await create(`${prefix} direct`, { parent_id: outer.id })
    const nested = await create(`${prefix} nested`, { parent_id: story.id })
    const plain = await create(`${prefix} without Epic`)
    const labels = { outer: `${title} (${outer.ticket_key})`, inner: `${title} (${inner.ticket_key})` }
    const query = new URLSearchParams({ view: "table", area: "", search: prefix, status: "pending" })
    await page.goto(`/tasks?${query}#table`)
    const table = page.locator("#task-table")
    const rows = table.locator(".table-row")
    const row = (id: string) => rows.and(table.locator(`[data-id="${id}"]`))
    const group = (id: string) => table.locator(`.group-header-row[data-group-by="epic"][data-group-key="epic:${id}"]`)
    const choose = async (value: string, control = "table-group-by") => {
      await page.locator(`#${control}-dropdown summary`).click()
      await page.locator(`[data-select="${control}"][data-value="${value}"]`).press("Enter")
    }
    await expect(rows).toHaveCount(3)
    await choose("epic")
    await expect(group(outer.id).locator(".group-label")).toHaveText(labels.outer)
    await expect(group(inner.id).locator(".group-label")).toHaveText(labels.inner)
    await expect(row(direct.id)).toHaveAttribute("data-group-value", `epic:${outer.id}`)
    await expect(row(nested.id)).toHaveAttribute("data-group-value", `epic:${inner.id}`)
    await expect(row(plain.id)).toHaveAttribute("data-group-value", "epic:none")
    await expect(row(outer.id)).toHaveCount(0)
    await expect(row(inner.id)).toHaveCount(0)
    const toggle = group(inner.id).locator(".group-toggle")
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(row(nested.id)).toBeHidden()
    await expect(row(direct.id)).toBeVisible()
    await toggle.press("Space")
    await expect(row(nested.id)).toBeVisible()

    await choose("priority")
    await choose("epic", "table-sub-group-by")
    await expect(group(inner.id)).toHaveClass(/sub-group-header-row/)
    await expect(row(nested.id)).toHaveAttribute("data-sub-group-value", `epic:${inner.id}`)
    await expect(group(inner.id).locator(".group-label")).toHaveText(labels.inner)
    const presetName = `Epic Table preset ${token}`
    const presets = page.getByRole("region", { name: "Saved Filter Presets" })
    await expect(table).not.toHaveAttribute("aria-busy", "true")
    await page.getByRole("button", { name: "Saved filter presets" }).press("Enter")
    const save = presets.getByRole("button", { name: "Save Current Filters" })
    await expect(save).toBeEnabled()
    await save.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Save Filter Preset" })
    await dialog.getByRole("textbox").fill(presetName)
    const savedResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/saved-filters" && response.request().method() === "POST",
    )
    await dialog.getByRole("button", { name: "OK" }).press("Enter")
    const saved = await savedResponse
    expect(saved.status(), await saved.text()).toBe(201)
    const presetId = (await saved.json() as { id: string }).id
    cleanup.push("/api/saved-filters?" + new URLSearchParams({ id: presetId }))
    expect(saved.request().postDataJSON().query_json).toMatchObject({ groupBy: "priority", subGroupBy: "epic" })
    await presets.getByRole("button", { name: "Close panel" }).press("Enter")
    await choose("none")
    await page.getByRole("button", { name: "Saved filter presets" }).press("Enter")
    await presets.getByRole("button", { name: `Apply ${presetName}`, exact: true }).press("Enter")
    await expect(row(nested.id)).toHaveAttribute("data-sub-group-value", `epic:${inner.id}`)
    const result = await request.get("/api/search", { params: { q: presetName, scope: "views" } })
    expect(result.ok(), await result.text()).toBe(true)
    const { sections } = await result.json()
    const link = sections.find((section: { id: string }) => section.id === "saved_filters")
      ?.items.find((item: { id: string }) => item.id === presetId)?.href
    expect(link).toBeTruthy()
    await page.goto(link)
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "priority" && url.searchParams.get("subGroupBy") === "epic")
    await expect(group(inner.id).locator(".group-label")).toHaveText(labels.inner)

    await row(nested.id).locator("[data-open-table-task]").press("Enter")
    const drawer = page.locator("#task-detail-overlay")
    await expect(drawer.locator("#td-title")).toHaveValue(`${prefix} nested`)
    await drawer.getByTitle("Remove parent").click()
    const unlink = page.getByRole("alertdialog", { name: "Unlink" })
    const write = page.waitForResponse(response =>
      new URL(response.url()).pathname.endsWith(`/api/tasks/${nested.id}`) && response.request().method() === "PUT",
    )
    await unlink.getByRole("button", { name: "Confirm" }).press("Enter")
    expect((await write).ok()).toBe(true)
    await expect(drawer.locator("#td-link-parent-display")).toHaveText("None")
    await drawer.getByRole("button", { name: "Close detail" }).press("Enter")
    await expect(row(nested.id)).toHaveAttribute("data-sub-group-value", "epic:none")

    const renamed = await request.put(`/api/tasks/${outer.id}`, { headers, data: { title: `Renamed outer ${token}` } })
    expect(renamed.ok(), await renamed.text()).toBe(true)
    const appliedUrl = page.url()
    let failNextRefresh = true
    await page.route("**/tasks?**", route => {
      if (new URL(route.request().url()).searchParams.has("tableRefresh") && failNextRefresh) {
        failNextRefresh = false
        return route.fulfill({ status: 503, body: "Fixture unavailable" })
      }
      return route.continue()
    })
    await table.getByRole("columnheader", { name: /Title/ }).getByRole("button").press("Enter")
    const retry = page.getByRole("button", { name: "Retry", exact: true })
    await expect(retry).toBeVisible()
    await expect(group(outer.id).locator(".group-label")).toHaveText(labels.outer)
    await expect(group(outer.id).locator(".group-count")).toHaveText("1")
    await expect(page).toHaveURL(appliedUrl)
    await retry.press("Enter")
    await expect(group(outer.id).locator(".group-label")).toHaveText(`Renamed outer ${token} (${outer.ticket_key})`)
    await expect(group(outer.id).locator(".group-count")).toHaveText("1")
    await expect(row(direct.id)).toHaveAttribute("data-sub-group-value", `epic:${outer.id}`)
    for (let index = 0; index < 51; index++) await create(`${prefix} page ${String(index).padStart(2, "0")}`, { parent_id: outer.id })
    query.set("groupBy", "epic")
    query.set("tp", "2")
    query.set("sort", "title-asc")
    await page.goto(`/tasks?${query}#table`)
    await expect(rows).toHaveCount(4)
    await expect(group(outer.id).locator(".group-count")).toHaveText("52")
    await expect(group("none").locator(".group-count")).toHaveText("2")
    await expect(table.locator(".grand-total-row")).toContainText("54 tasks")
    await expect(page.getByRole("navigation", { name: "Task pages" })).toContainText("51–54 of 54")
  } finally {
    const failures: string[] = []
    for (const path of cleanup.reverse()) {
      const response = await request.delete(path, { headers })
      if (!response.ok()) failures.push(`${path}: ${response.status()} ${await response.text()}`)
    }
    expect(failures).toEqual([])
  }
})

test("Ingress Table keeps unavailable, cyclic and named Board ancestry out of Epic groups", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-table-epic-scope-"))
  const fixture = startCoreFixture(work)
  fixture.stdout?.resume()
  fixture.stderr?.resume()
  let browser
  try {
    const [{ port, configuredPath }] = await once(fixture, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${port}`
    const app = origin + configuredPath
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const prefix = "Displayed Table scoped descendant"
    async function seed(title: string, fields: object = {}) {
      const response = await context.request.post(app + "/api/tasks", { headers: { origin }, data: { title, ...fields } })
      expect(response.status(), await response.text()).toBe(201)
      return await response.json() as { id: string; ticket_key: string }
    }
    const root = await seed("Outside filter Epic", { task_type: "epic", status: "complete" })
    const valid = await seed(`${prefix} valid`, { parent_id: root.id })
    const missing = await seed(`${prefix} missing`)
    const cyclic = await seed(`${prefix} cyclic`)
    const cycleParent = await seed("Non-Epic cycle parent")
    const restricted = await seed(`${prefix} restricted`)
    const privateId = randomUUID()
    const privateBoard = randomUUID()
    const privateLane = randomUUID()
    const privateTitle = "Private Table Epic title"
    const db = new DatabaseSync(join(work, "pins.db"))
    try {
      db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(randomUUID(), missing.id)
      db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(cycleParent.id, cyclic.id)
      db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(cyclic.id, cycleParent.id)
      db.prepare(`INSERT INTO task_boards (id, name, visibility, ticket_prefix, ticket_high_water, created_at, updated_at)
        VALUES (?, 'Restricted Table fixture', 'restricted', 'TBLPRIVX', 1, 1, 1)`).run(privateBoard)
      db.prepare(`INSERT INTO kanban_lanes (id, key, label, board_id, created_at, updated_at)
        VALUES (?, 'pending', 'Restricted lane', ?, 1, 1)`).run(privateLane, privateBoard)
      db.prepare(`INSERT INTO tasks (id, title, task_type, area_id, task_board_id, board_column_id,
        ticket_ref, idempotency_key, request_id, status, created_at, updated_at)
        VALUES (?, ?, 'epic', '__meitheal_no_area__', ?, ?, 'TBLPRIVX-1', ?, ?, 'pending', 1, 1)`)
        .run(privateId, privateTitle, privateBoard, privateLane, privateId, privateId)
      db.prepare("UPDATE tasks SET parent_id = ? WHERE id = ?").run(privateId, restricted.id)
    } finally { db.close() }
    const page = await context.newPage()
    const query = new URLSearchParams({ view: "table", search: prefix, area: "", groupBy: "epic" })
    const response = await page.goto(`${app}/tasks?${query}#table`)
    expect(response?.ok()).toBe(true)
    const rows = page.locator("#task-table .table-row")
    await expect(rows).toHaveCount(4)
    await expect(page.locator(`#task-table .table-row[data-id="${valid.id}"]`)).toHaveAttribute("data-group-value", `epic:${root.id}`)
    for (const task of [missing, cyclic, restricted]) {
      await expect(page.locator(`#task-table .table-row[data-id="${task.id}"]`)).toHaveAttribute("data-group-value", "epic:none")
    }
    const html = await response!.text()
    for (const value of [privateId, privateBoard, privateTitle, "TBLPRIVX-1"]) expect(html).not.toContain(value)
    await expect(page.locator('.group-header-row[data-group-key="epic:none"] .group-count')).toHaveText("3")
  } finally {
    await browser?.close()
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, "exit", { signal: AbortSignal.timeout(3_000) })
      fixture.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
