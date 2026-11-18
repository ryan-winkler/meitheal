import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { expect, test, type APIRequestContext } from "@playwright/test"
import { launchPinBrowser, startCoreFixture } from "../scripts/task-pins-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")
test.use({ actionTimeout: 5_000, serviceWorkers: "block" })

async function create(request: APIRequestContext, url: string, data: object, origin?: string) {
  const response = await request.post(url, { headers: origin ? { origin } : {}, data })
  expect(response.status(), await response.text()).toBe(201)
  return (await response.json() as { id: string }).id
}

async function updateColumn(request: APIRequestContext, id: string, data: object) {
  const response = await request.put(`/api/lanes/${id}`, { data })
  expect(response.ok(), await response.text()).toBe(true)
}

test("Table assigns each task once and restores workflow subgroups under Area", async ({ page, request, baseURL }) => {
  const cleanup: string[] = []
  const fixture = async (path: string, data: object) => {
    const id = await create(request, path, data)
    cleanup.push(`${path}/${id}`)
    return id
  }
  try {
    const token = randomUUID().slice(0, 8)
    const term = `Workflow grouping ${token}`
    const firstKey = `staging_${token}`
    const secondKey = `ready_${token}`
    const sharedLabel = `Review ${token}`
    const renamedLabel = `Ready now ${token}`
    const firstName = `${sharedLabel} (${firstKey})`
    const secondName = `${sharedLabel} (${secondKey})`
    const first = await fixture("/api/lanes", { key: firstKey, label: sharedLabel, position: 40 })
    const second = await fixture("/api/lanes", { key: secondKey, label: sharedLabel, position: 41 })
    await updateColumn(request, first, { includes: JSON.stringify([firstKey, secondKey, "todo"]) })
    await updateColumn(request, second, { includes: JSON.stringify([secondKey, "pending"]) })

    const areaId = await fixture("/api/areas", { name: `Workshop ${token}` })
    const task = (status: string) => fixture("/api/tasks", { title: `${term} ${status}`, status, area_id: areaId })
    const todo = await task("pending")
    const staging = await task(firstKey)
    const ready = await task(secondKey)
    const unmatched = await task(`unmatched_${token}`)

    const search = new URLSearchParams({ view: "table", area: "", search: term })
    await page.goto(`/tasks?${search}#table`)
    const table = page.locator("#task-table")
    const rows = table.locator(".table-row")
    const row = (id: string) => rows.and(table.locator(`[data-id="${id}"]`))
    const groups = table.locator('.group-header-row:not(.sub-group-header-row)[data-group-by="workflow"]')
    const subgroups = table.locator('.sub-group-header-row[data-group-by="workflow"]')

    const selectGroup = async (value: string, control = "table-group-by") => {
      await page.locator(`#${control}-dropdown summary`).click()
      await page.locator(`[data-select="${control}"][data-value="${value}"]`).press("Enter")
    }
    const subgroup = page.locator("#table-sub-group-by-dropdown")
    await expect(subgroup).toBeHidden()
    await selectGroup("workflow")
    await expect(groups.locator(".group-label")).toHaveText(["Todo", firstName, secondName, "No workflow column"])
    await expect(groups.locator(".group-count")).toHaveText(["1", "1", "1", "1"])
    await expect(rows).toHaveCount(4)
    await expect(row(todo)).toHaveAttribute("data-group-value", "lane-pending")
    await expect(row(staging)).toHaveAttribute("data-group-value", first)
    await expect(row(ready)).toHaveAttribute("data-group-value", second)
    await subgroup.locator("summary").press("Enter")
    await expect(subgroup.locator('[data-value="workflow"]')).toBeHidden()
    const groupedUrlBeforeDismiss = page.url()
    await subgroup.locator('[data-value="status"]').press("Escape")
    await expect(subgroup).not.toHaveAttribute("open")
    await expect(subgroup.locator("summary")).toBeFocused()
    await expect(page).toHaveURL(groupedUrlBeforeDismiss)
    await expect(rows).toHaveCount(4)

    const unmatchedToggle = table.getByRole("button", { name: "Toggle group No workflow column" })
    await unmatchedToggle.press("Enter")
    await expect(row(unmatched)).toBeHidden()
    await unmatchedToggle.press("Enter")
    await expect(row(unmatched)).toBeVisible()

    const columns = page.locator("[data-table-workflow-filter]")
    await columns.locator("summary").click()
    const readyChoice = columns.getByRole("checkbox", { name: secondName })
    await readyChoice.check()
    await expect(row(todo)).toHaveAttribute("data-group-value", second)
    await expect(rows).toHaveCount(2)
    await readyChoice.press("Escape")

    await updateColumn(request, second, { label: renamedLabel, position: 39 })
    await columns.locator("summary").press("Enter")
    await columns.getByRole("checkbox", { name: firstName }).check()
    await expect(groups.locator(".group-label")).toHaveText([renamedLabel, sharedLabel])
    await columns.getByRole("checkbox", { name: sharedLabel, exact: true }).press("Escape")
    await selectGroup("area")
    await selectGroup("workflow", "table-sub-group-by")
    await expect(subgroups.locator(".group-label")).toHaveText([renamedLabel, sharedLabel])

    const presetName = `Workflow columns by Area ${token}`
    const presetToggle = page.getByRole("button", { name: "Saved filter presets" })
    const presets = page.getByRole("region", { name: "Saved Filter Presets" })
    await expect(table).not.toHaveAttribute("aria-busy", "true")
    await presetToggle.press("Enter")
    const saveCurrent = presets.getByRole("button", { name: "Save Current Filters" })
    await expect(saveCurrent).toBeEnabled()
    await saveCurrent.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Save Filter Preset" })
    await dialog.getByRole("textbox").fill(presetName)
    const savedResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/saved-filters" && response.request().method() === "POST",
    )
    await dialog.getByRole("button", { name: "OK" }).press("Enter")
    const saved = await savedResponse
    expect(saved.status(), await saved.text()).toBe(201)
    const presetId: string = (await saved.json()).id
    cleanup.push("/api/saved-filters?" + new URLSearchParams({ id: presetId }))
    expect(saved.request().postDataJSON().query_json).toMatchObject({
      groupBy: "area",
      subGroupBy: "workflow",
      laneIds: expect.arrayContaining([first, second]),
    })

    await presets.getByRole("button", { name: "Close panel" }).press("Enter")
    await selectGroup("workflow")
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "workflow" && !url.searchParams.has("subGroupBy"))
    await presetToggle.press("Enter")
    await presets.getByRole("button", { name: `Apply ${presetName}` }).press("Enter")
    await expect(subgroups.locator(".group-label")).toHaveText([renamedLabel, sharedLabel])
    await expect(subgroups.locator(".group-count")).toHaveText(["2", "1"])
    await expect(rows).toHaveCount(3)
    await expect(row(todo)).toHaveAttribute("data-sub-group-value", second)
    await expect(row(ready)).toHaveAttribute("data-group-value", areaId)
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "area" && url.searchParams.get("subGroupBy") === "workflow")

    const results = await request.get("/api/search", { params: { q: presetName, scope: "views" } })
    expect(results.ok(), await results.text()).toBe(true)
    const { sections } = await results.json()
    const item = sections.find((section: { id: string }) => section.id === "saved_filters")
      ?.items.find((candidate: { id: string }) => candidate.id === presetId)
    expect(item?.href).toBeDefined()
    await page.goto(item.href)
    await expect(subgroups.locator(".group-label")).toHaveText([renamedLabel, sharedLabel])
    const groupedUrl = page.url()
    await page.getByRole("navigation", { name: "Task views" }).getByRole("link", { name: "Kanban" }).click()
    await expect(page).toHaveURL(url => url.hash === "#kanban" && url.searchParams.get("groupBy") === "area" && !url.searchParams.has("subGroupBy"))
    await page.goBack()
    await expect(page).toHaveURL(groupedUrl)
    await expect(subgroups.locator(".group-label")).toHaveText([renamedLabel, sharedLabel])
  } finally {
    const headers = { origin: baseURL!, "content-type": "application/json" }
    const failed: string[] = []
    for (const path of cleanup.reverse()) {
      const response = await request.delete(path, { headers })
      if (!response.ok()) failed.push(`${path}: ${response.status()} ${await response.text()}`)
    }
    expect(failed).toEqual([])
  }
})

test("Ingress Table preserves applied grouping and retries an unavailable workflow catalog", async () => {
  const work = await mkdtemp(join(tmpdir(), "meitheal-workflow-groups-ingress-"))
  const child = startCoreFixture(work)
  child.stdout?.resume()
  child.stderr?.resume()
  let browser
  let db: DatabaseSync | undefined
  try {
    const [fixture] = await once(child, "message", { signal: AbortSignal.timeout(10_000) })
    const origin = `https://127.0.0.1:${fixture.port}`
    const prefix: string = fixture.configuredPath
    const app = origin + prefix
    browser = await launchPinBrowser(work)
    const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" })
    await context.setExtraHTTPHeaders({})
    await context.addCookies([{ name: "feedback-fixture", value: "member", url: origin }])
    const title = "Household ingress workflow receipt"
    const id = await create(context.request, app + "/api/tasks", { title, status: "pending" }, origin)
    const page = await context.newPage()
    const query = new URLSearchParams({ view: "table", area: "", groupBy: "workflow" })
    const initial = `${app}/tasks?${query}#table`
    const row = page.locator(`#task-table .table-row[data-id="${id}"]`)
    await page.goto(initial)
    await expect(row).toHaveAttribute("data-group-value", "lane-pending")
    const appliedUrl = page.url()

    // The live fixture can still be writing when failure injection changes its schema.
    db = new DatabaseSync(join(work, "pins.db"), { timeout: 5_000 })
    db.exec("ALTER TABLE kanban_lanes RENAME TO unavailable_workflow_columns")
    const failed = page.waitForResponse(response => new URL(response.url()).searchParams.has("tableRefresh"))
    await page.getByRole("textbox", { name: "Filter by text" }).fill(title)
    const receipt = await failed
    expect(receipt.status()).toBe(503)
    expect(new URL(receipt.url()).pathname).toBe(prefix + "/tasks")
    const retry = page.getByRole("button", { name: "Retry", exact: true })
    await expect(retry).toBeVisible()
    await expect(page).toHaveURL(appliedUrl)
    await expect(row).toBeVisible()
    const status = page.locator("#table-refresh-status [data-table-refresh-message]")
    await expect(status).toHaveText("The task list couldn’t update.")
    await page.locator("#table-sub-group-by-dropdown summary").click()
    await page.locator('[data-select="table-sub-group-by"][data-value="status"]').click()
    await expect(status).toContainText("Retry to apply your grouping.")
    await expect(page).toHaveURL(appliedUrl)
    await expect(row).toBeVisible()

    const fresh = await context.newPage()
    await fresh.goto(initial)
    await expect(fresh.locator("#table-refresh-status")).toContainText("Workflow columns could not load.")
    const freshRetry = fresh.getByRole("button", { name: "Retry", exact: true })
    await expect(freshRetry).toBeVisible()
    await expect(fresh.locator("#task-table")).toBeHidden()

    db.exec("ALTER TABLE unavailable_workflow_columns RENAME TO kanban_lanes")
    await retry.click()
    await expect(page).toHaveURL(url => url.pathname === prefix + "/tasks" &&
      url.searchParams.get("search") === title && url.searchParams.get("subGroupBy") === "status")
    await expect(row).toHaveAttribute("data-group-value", "lane-pending")
    await freshRetry.click()
    await expect(fresh.locator("#task-table .group-label")).toHaveText("Todo")
    await expect(fresh.locator("[data-table-workflow-options]")).toHaveAttribute("data-table-workflow-options", "ready")
  } finally {
    db?.close()
    await browser?.close()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(3_000) })
      child.kill("SIGTERM")
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})
