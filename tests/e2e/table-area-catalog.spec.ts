import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a disposable built app")
test.use({ serviceWorkers: "block" })

test("Table keeps Area group names and bulk choices in sync with accepted rows", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" }
  const term = `Area catalog ${randomUUID()}`
  const known = "Utility room"
  const renamed = "Electrical cupboard"
  const taskIds: string[] = []
  const areaIds: string[] = []

  async function createArea(name: string) {
    const response = await request.post("/api/areas", { headers, data: { name, icon: "⚡", color: "#4671CC" } })
    expect(response.status(), await response.text()).toBe(201)
    const { id } = await response.json() as { id: string }
    areaIds.push(id)
    return id
  }

  try {
    const areaId = await createArea(known)
    const retiredId = await createArea("Retired room")
    for (const [area_id, suffix] of [[areaId, "named"], [retiredId, "retired"], ["default", "default"]]) {
      // The scores are finite individually, but their sum overflows when both rows match.
      const framework_payload = suffix === "default" ? {} : { rice: { reach: 1e308, impact: 1, confidence: 1, effort: 1 } }
      const response = await request.post("/api/tasks", {
        headers, data: { title: `${term} ${suffix}`, area_id, framework_payload: JSON.stringify(framework_payload) },
      })
      expect(response.status(), await response.text()).toBe(201)
      taskIds.push((await response.json()).id)
    }
    expect((await request.delete(`/api/areas/${retiredId}`, { headers })).ok()).toBe(true)

    await page.route("**/api/areas", route => route.fulfill({ status: 503, json: {} }))
    await page.route("**/api/boards/household?view=groups**", route => route.fulfill({ status: 503, json: {} }))
    const query = new URLSearchParams({ view: "table", area: "", search: term, groupBy: "area" })
    await page.route("**/tasks?**", async route => {
      const response = await route.fetch()
      const body = (await response.text()).replace('data-area-catalog-ready="true"', 'data-area-catalog-ready="false"')
        .replace(new RegExp(`<button\\b(?=[^>]*data-area-id="${areaId}")[^>]*>[\\s\\S]*?<\\/button>`, "g"), "")
      await route.fulfill({ response, body })
    }, { times: 1 })
    await page.goto(`/tasks?${query}#table`)

    const rows = page.locator("#task-table .table-row")
    const header = (id: string) => page.locator(`#task-table .group-header-row[data-group-by="area"][data-group-key="${id}"]`)
    const named = header(areaId)
    const bulk = page.locator("#bulk-area")
    const option = bulk.locator(`option[value="${areaId}"]`)
    const retry = page.getByRole("button", { name: "Retry", exact: true })
    const selector = page.locator("#area-selector-dropdown")
    const selectorOption = selector.locator(`[data-area-id="${areaId}"]`)
    const selectorLabel = page.locator("[data-area-label]")
    await expect(named.getByRole("button", { name: "Toggle group Unavailable Area" })).toBeVisible()
    await expect(page.locator("[data-table-refresh-message]")).toHaveText("Area names could not load.")
    await expect(option).toHaveCount(0)
    await expect(selectorOption).toHaveCount(0)
    await retry.click()
    await expect(named.getByRole("button", { name: `Toggle group ${known}` })).toBeVisible()
    await expect(named.getByRole("checkbox", { name: `Select visible tasks in ${known} on this page` })).toBeVisible()
    await expect(named.locator(".group-icon")).toHaveText("⚡")
    await expect(named.locator(".group-dot")).toHaveCSS("background-color", "rgb(70, 113, 204)")
    await expect(header(retiredId).getByRole("button", { name: "Toggle group Unavailable Area" })).toBeVisible()
    await expect(header("default").getByRole("button", { name: "Toggle group Default", exact: true })).toBeVisible()
    await expect(option).toHaveText(`⚡ ${known}`)
    await expect(selectorOption).toHaveAttribute("data-area-name", known)
    await expect(selectorOption.locator(".area-selector__option-icon svg")).toHaveCount(1)
    await expect(selectorLabel).toHaveText("All Areas")
    await expect(selector.locator('[data-area-id=""]')).toHaveAttribute("aria-selected", "true")
    await expect(bulk.locator("option[value='']")).toHaveCount(1)
    await expect(bulk.locator(`option[value="${retiredId}"]`)).toHaveCount(0)

    // Seed the native selection without triggering the bulk write handler.
    await bulk.evaluate((select: HTMLSelectElement, id) => {
      select.value = id
      select.addEventListener("change", () => { select.dataset.changedDuringRefresh = "true" }, { once: true })
    }, areaId)
    const writes: string[] = []
    page.on("request", req => {
      if (["PATCH", "PUT"].includes(req.method()) && new URL(req.url()).pathname.startsWith("/api/tasks/")) writes.push(req.url())
    })

    const input = page.getByRole("textbox", { name: "Filter by text" })
    let captureSlow!: () => void
    let releaseSlow!: () => void
    let slowFinished!: () => void
    const captured = new Promise<void>(resolve => { captureSlow = resolve })
    const release = new Promise<void>(resolve => { releaseSlow = resolve })
    const finished = new Promise<void>(resolve => { slowFinished = resolve })
    let failNext = true
    let invalidStatsNext = false
    await page.route("**/tasks?**", async route => {
      const params = new URL(route.request().url()).searchParams
      if (!params.has("tableRefresh")) return route.continue()
      if (params.get("search") === `${term} retired`) {
        const response = await route.fetch()
        const body = await response.text()
        captureSlow()
        await release
        try { await route.fulfill({ response, body }) } catch { /* Superseded request may already be canceled. */ }
        finally { slowFinished() }
      } else if (failNext) {
        failNext = false
        const response = await route.fetch()
        const body = (await response.text()).replace('data-area-catalog-ready="true"', 'data-area-catalog-ready="false"')
        await route.fulfill({ response, body })
      } else if (invalidStatsNext) {
        invalidStatsNext = false
        const response = await route.fetch()
        const invalidStats = JSON.stringify({
          total: { count: 1, riceSum: 0, riceCount: 0 },
          groups: [null],
          subgroups: [],
          epicLabels: [],
        })
        const body = (await response.text()).replace(/data-table-stats="[^"]*"/, `data-table-stats='${invalidStats}'`).replaceAll(renamed, "Rejected catalog")
        await route.fulfill({ response, body })
      } else await route.continue()
    })

    const onlyNamed = `${term} n`
    try {
      await input.fill(`${term} retired`)
      await captured
      expect((await request.put(`/api/areas/${areaId}`, { headers, data: { name: renamed } })).ok()).toBe(true)
      await input.fill(onlyNamed)
      await expect(retry).toBeVisible()
      await expect(rows).toHaveCount(3)
      await expect(page).toHaveURL(url => url.searchParams.get("search") === term)
      await expect(named.locator(".group-label")).toHaveText(known)
      await expect(option).toHaveText(`⚡ ${known}`)
      await expect(selectorOption).toHaveAttribute("data-area-name", known)
      await expect(bulk).toHaveValue(areaId)
      await retry.click()
      await expect(named.locator(".group-label")).toHaveText(renamed)
      await expect(option).toHaveText(`⚡ ${renamed}`)
      await expect(selectorOption).toHaveAttribute("data-area-name", renamed)
      await expect(bulk).toHaveValue(areaId)
    } finally {
      releaseSlow()
    }
    await finished
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText(`${term} named`)
    await expect(page).toHaveURL(url => url.searchParams.get("search") === onlyNamed)
    await expect(named.locator(".group-label")).toHaveText(renamed)
    await expect(option).toHaveText(`⚡ ${renamed}`)
    await expect(selectorOption).toHaveAttribute("data-area-name", renamed)
    await expect(selectorLabel).toHaveText("All Areas")
    await expect(selector.locator('[data-area-id=""]')).toHaveAttribute("aria-selected", "true")
    await expect(bulk).toHaveValue(areaId)
    await expect(page.locator(".grand-total-row .summary-rice")).toHaveText("Avg RICE: 1e+308")

    invalidStatsNext = true
    await input.fill(`${term} default`)
    await expect(retry).toBeVisible()
    await expect(rows.first()).toContainText(`${term} named`)
    await expect(option).toHaveText(`⚡ ${renamed}`)
    await expect(selectorOption).toHaveAttribute("data-area-name", renamed)
    await expect(page).toHaveURL(url => url.searchParams.get("search") === onlyNamed)
    await input.fill(onlyNamed)
    await expect(retry).toBeHidden()

    await page.locator("#table-group-by-dropdown > summary").click()
    await page.locator('button[data-select="table-group-by"][data-value="status"]').click()
    await expect(page).toHaveURL(url => url.searchParams.get("groupBy") === "status")
    await page.locator("#table-sub-group-by-dropdown > summary").click()
    await page.locator('button[data-select="table-sub-group-by"][data-value="area"]').click()
    await expect(named.getByRole("button", { name: `Toggle sub-group ${renamed}` })).toBeVisible()
    await expect(named.locator(".group-icon")).toHaveText("⚡")
    await expect(named.locator(".group-dot")).toHaveCSS("background-color", "rgb(70, 113, 204)")
    await expect(named.locator(".group-count")).toHaveText("1")

    expect((await request.delete(`/api/areas/${areaId}`, { headers })).ok()).toBe(true)
    await input.fill(term)
    await expect(named.getByRole("button", { name: "Toggle sub-group Unavailable Area" })).toBeVisible()
    await expect(option).toHaveCount(0)
    await expect(selectorOption).toHaveCount(0)
    await expect(selectorLabel).toHaveText("All Areas")
    await expect(bulk).toHaveValue("")
    await expect(page.locator(".grand-total-row .summary-rice")).toHaveText("Avg RICE: —")
    await expect(bulk).not.toHaveAttribute("data-changed-during-refresh")
    expect(writes).toEqual([])
  } finally {
    for (const id of taskIds) await request.delete(`/api/tasks/${id}`, { headers })
    for (const id of areaIds) await request.delete(`/api/areas/${id}`, { headers })
  }
})


test("Table preserves a selected Area through catalog rename and deletion", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" }
  const name = `Selected Area ${randomUUID()}`
  const created = await request.post("/api/areas", { headers, data: { name, icon: "⚡" } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  const task = await request.post("/api/tasks", { headers, data: { title: `${name} task`, area_id: id } })
  expect(task.status()).toBe(201)
  const taskId = (await task.json()).id
  try {
    await page.goto(`/tasks?${new URLSearchParams({ view: "table", area: id, search: name, groupBy: "area" })}#table`)
    const trigger = page.locator("#area-selector-trigger")
    const label = trigger.locator("[data-area-label]")
    const selected = page.locator(`#area-selector-dropdown [data-area-id="${id}"]`)
    const input = page.getByRole("textbox", { name: "Filter by text" })
    await expect(label).toHaveText(name)
    expect((await request.put(`/api/areas/${id}`, { headers, data: { name: `${name} renamed` } })).ok()).toBe(true)
    await input.fill(`${name} task`)
    await expect(label).toHaveText(`${name} renamed`)
    await expect(selected).toHaveAttribute("aria-selected", "true")
    await expect(trigger).toHaveAttribute("data-selected-area-id", id)
    const deleted = await request.delete(`/api/areas/${id}`, { headers })
    expect(deleted.status(), await deleted.text()).toBe(200)
    await input.fill(name)
    await expect(label).toHaveText("Area unavailable")
    await expect(selected).toHaveCount(0)
    await expect(trigger).toHaveAttribute("data-selected-area-id", id)
    await expect(page).toHaveURL(url => url.searchParams.get("area") === id)
    await trigger.click()
    await page.locator('#area-selector-dropdown [data-area-id=""]').click()
    await expect(label).toHaveText("All Areas")
    await expect(page).toHaveURL(url => url.searchParams.get("area") === "")
  } finally {
    await request.delete(`/api/tasks/${taskId}`, { headers })
    await request.delete(`/api/areas/${id}`, { headers })
  }
})
