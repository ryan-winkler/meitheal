import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")

test("Table filters, sorts, groups and counts before slicing and keeps selection page-scoped", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const name = `Table paging ${randomUUID()}`
  const area = await request.post("/api/areas", { headers, data: { name } })
  expect(area.status(), await area.text()).toBe(201)
  const { id: areaId } = await area.json() as { id: string }
  const tasks: string[] = []
  const tableRoute = `/tasks?area_id=${areaId}&view=table`
  const rareTitle = "Aardvark repair fixture"
  const searchText = "needle-search-in-the-old-task-description"

  async function createTask(title: string, description = "", priority = 3) {
    const response = await request.post("/api/tasks", {
      headers,
      data: { title, description, priority, status: "pending", area_id: areaId },
    })
    expect(response.status(), await response.text()).toBe(201)
    tasks.push((await response.json() as { id: string }).id)
  }

  try {
    await createTask(rareTitle, searchText, 1)
    for (let i = 0; i < 52; i++) await createTask(`Desk maintenance ${String(i).padStart(2, "0")}`)

    const response = await page.goto(tableRoute + "#table")
    expect(response?.ok()).toBeTruthy()
    expect(Buffer.byteLength(await response!.text())).toBeLessThan(1_000_000)
    const table = page.getByRole("table")
    const rows = table.locator(".table-row")
    const pager = page.getByRole("navigation", { name: "Task pages" })
    const rareRow = rows.filter({ hasText: rareTitle })

    await expect(rows).toHaveCount(50)
    await expect(rareRow).toHaveCount(0)
    await expect(pager).toContainText("1–50 of 53 matching tasks")
    await table.getByRole("checkbox", { name: "Select all visible tasks on this page" }).check()
    await expect(page.locator("#selected-count")).toHaveText("50 selected")
    await pager.getByRole("link", { name: "Next" }).press("Enter")
    await expect(page).toHaveURL(url => url.searchParams.get("tp") === "2" && url.searchParams.get("area_id") === areaId)
    await expect(pager.getByRole("link", { name: "Previous" })).toBeFocused()
    await expect(pager.getByRole("link", { name: "Previous" })).toHaveAccessibleDescription("51–53 of 53 matching tasks")
    await expect(rows).toHaveCount(3)
    await expect(rareRow).toBeVisible()
    await expect(table.locator(".row-check:checked")).toHaveCount(0)

    const refreshes: string[] = []
    page.on("request", request => {
      if (new URL(request.url()).searchParams.has("tableRefresh")) refreshes.push(request.url())
    })
    await page.getByRole("button", { name: "Customize visible columns" }).press("Enter")
    const columns = page.getByRole("region", { name: "Column Visibility" })
    await columns.getByRole("checkbox", { name: "Priority" }).uncheck()
    await expect(page).toHaveURL(url => url.searchParams.get("tp") === "2" && !!url.searchParams.get("columns"))
    await expect(table.getByRole("columnheader", { name: "Priority" })).toBeHidden()
    expect(refreshes).toEqual([])
    await expect(pager.getByRole("link", { name: "Previous" })).toHaveAttribute("href", /columns=/)
    await columns.getByRole("button", { name: "Reset to Defaults" }).click()
    await columns.getByRole("button", { name: "Close panel" }).click()

    const priority = table.getByRole("columnheader", { name: /Priority/ })
    await priority.getByRole("button").press("Enter")
    await expect(priority).toHaveAttribute("aria-sort", "ascending")
    await expect(page).toHaveURL(url => url.searchParams.get("sort") === "priority-asc" && !url.searchParams.has("tp"))
    await expect(rows.first()).toContainText(rareTitle)

    const title = table.getByRole("columnheader", { name: /Title/ })
    await title.getByRole("button").press("Enter")
    await expect(title).toHaveAttribute("aria-sort", "ascending")
    await expect(rows.first()).toContainText(rareTitle)

    await page.goto(tableRoute + "#table")
    const search = page.getByRole("textbox", { name: "Filter by text" })
    await search.fill(searchText)
    await expect(rows).toHaveCount(1)
    await expect(rareRow).toBeVisible()
    await expect(search).toBeFocused()
    await page.reload()
    await expect(rareRow).toBeVisible()
    await search.fill("nothing matches this fixture")
    await expect(rows).toHaveCount(0)
    await expect(table.locator(".no-results-row")).toBeVisible()
    await page.getByRole("button", { name: "Clear all active filters" }).press("Enter")
    await expect(search).toBeFocused()
    await expect(rows).toHaveCount(50)

    await page.goto(tableRoute + "&groupBy=status&tp=2#table")
    const group = table.getByRole("button", { name: /Toggle group/ })
    await expect(rows).toHaveCount(3)
    await expect(table.locator(".group-count")).toHaveText("53")
    await expect(table.locator(".grand-total-row")).toContainText("Total: 53 tasks")
    await table.getByRole("checkbox", { name: /Select visible tasks in .* on this page/ }).check()
    await expect(page.locator("#selected-count")).toHaveText("3 selected")
    await group.press("Enter")
    await expect(group).toHaveAttribute("aria-expanded", "false")
    await expect(table.locator(".row-check:checked")).toHaveCount(0)
  } finally {
    for (const id of tasks) await request.delete(`/api/tasks/${id}`, { headers })
    await request.delete(`/api/areas/${areaId}`, { headers })
  }
})

test("Table refresh keeps the last applied rows after failure and ignores superseded responses", async ({ browser, request, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL!, serviceWorkers: "block" })
  const page = await context.newPage()
  const key = randomUUID()
  const first = `Slow ${key}`
  const second = `Fast ${key}`
  const ids: string[] = []
  try {
    for (const title of [first, second]) {
      const response = await request.post("/api/tasks", { data: { title } })
      expect(response.status(), await response.text()).toBe(201)
      ids.push((await response.json()).id)
    }

    await page.goto("/tasks?view=table#table")
    const input = page.getByRole("textbox", { name: "Filter by text" })
    const rows = page.locator("#task-table .table-row")
    await expect(rows.filter({ hasText: second })).toBeVisible()
    let slowStarted!: () => void
    let releaseSlow!: () => void
    const started = new Promise<void>(resolve => { slowStarted = resolve })
    const release = new Promise<void>(resolve => { releaseSlow = resolve })
    const markers: string[] = []
    let rejectNext = true
    await page.route("**/tasks?**", async route => {
      const query = new URL(route.request().url()).searchParams
      const marker = query.get("tableRefresh")
      if (!marker) return route.continue()
      markers.push(marker)
      if (query.get("search") === first) {
        slowStarted()
        await release
        await route.continue().catch(() => {})
      } else if (rejectNext) {
        rejectNext = false
        await route.abort("failed")
      } else await route.continue()
    })

    await input.fill(first)
    await started
    await input.fill(second)
    const retry = page.getByRole("button", { name: "Retry" })
    await expect(retry).toBeVisible()
    await expect(page).toHaveURL(url => !url.searchParams.has("search"))
    await expect(rows.filter({ hasText: first })).toBeVisible()
    await retry.press("Enter")
    await expect(input).toBeFocused()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(second)
    releaseSlow()
    await expect(page).toHaveURL(url => url.searchParams.get("search") === second && !url.searchParams.has("tableRefresh"))
    await expect(rows.first()).toContainText(second)
    expect(new Set(markers).size).toBe(3)
  } finally {
    await context.close()
    for (const id of ids) await request.delete(`/api/tasks/${id}`)
  }
})
