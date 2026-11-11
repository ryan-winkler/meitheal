import { randomUUID } from "node:crypto"

import { expect, test } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Saved Table filters", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("Search retains compound, label, kind and column filters in the Table link", async ({ request, baseURL }) => {
    const name = `Table preset ${randomUUID()}`
    const headers = { origin: new URL(baseURL!).origin }
    const rules = {
      id: "root",
      logic: "AND",
      conditions: [{ id: "title", field: "title", operator: "contains", value: "100% complete" }],
    }
    const create = await request.post("/api/saved-filters", {
      headers,
      data: {
        name,
        query_json: {
          area: "",
          types: ["quick_capture"],
          labels: ["fruit, veg"],
          advancedFilter: rules,
          columns: ["title", "status"],
        },
      },
    })
    expect(create.status(), await create.text()).toBe(201)
    const { id } = await create.json()

    try {
      const result = await request.get("/api/search", { params: { q: name, scope: "views" } })
      expect(result.status(), await result.text()).toBe(200)
      const { sections } = await result.json()
      const item = sections.find((section: { id: string }) => section.id === "saved_filters")
        ?.items.find((candidate: { id: string }) => candidate.id === id)
      expect(item).toBeDefined()
      const url = new URL(item.href, baseURL)
      expect(url.pathname).toBe("/table")
      expect(url.searchParams.get("area")).toBe("")
      expect(url.searchParams.get("types")).toBe("quick_capture")
      expect(url.searchParams.getAll("label")).toEqual(["fruit, veg"])
      expect(JSON.parse(url.searchParams.get("advancedFilter") ?? "null")).toEqual(rules)
      expect(JSON.parse(url.searchParams.get("columns") ?? "null")).toEqual(["title", "status"])
    } finally {
      await request.delete("/api/saved-filters", { headers: { ...headers, "content-type": "application/json" }, params: { id } })
    }
  })

  test("keyboard Escape closes Presets without clearing the Table filters", async ({ page }) => {
    await page.goto("/table?status=active")
    const presetToggle = page.getByRole("button", { name: "Saved filter presets" })
    const panel = page.getByRole("region", { name: "Saved Filter Presets" })
    await expect(presetToggle).toBeVisible()
    await presetToggle.press("Enter")
    await expect(panel).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(panel).toBeHidden()
    await expect(presetToggle).toBeFocused()
    await expect(page).toHaveURL(url =>
      url.pathname === "/tasks" && url.searchParams.get("status") === "active" && url.hash === "#table",
    )
    const toolbar = page.getByRole("toolbar", { name: "Filter tasks" })
    await toolbar.getByRole("button", { name: "Clear all active filters" }).press("Enter")
    await expect(toolbar.getByRole("textbox", { name: "Filter by text" })).toBeFocused()
    await expect(page).toHaveURL(url => !url.searchParams.has("status"))
  })

  test("Table and Search apply the same rows and body columns", async ({ page, request, baseURL }) => {
    const key = randomUUID()
    const headers = { origin: new URL(baseURL!).origin }
    const createTask = async (status: string) => {
      const response = await request.post("/api/tasks", {
        headers, data: { title: `Round trip ${key} ${status}`, status },
      })
      expect(response.status(), await response.text()).toBe(201)
      const { id } = await response.json()
      return id as string
    }
    const active = await createTask("active")
    const complete = await createTask("complete")
    const name = `Saved view ${key}`
    const create = await request.post("/api/saved-filters", {
      headers,
      data: {
        name,
        icon: "<img src=x>",
        query_json: { area: "", search: key, status: "active", columns: ["title", "status"] },
      },
    })
    expect(create.status(), await create.text()).toBe(201)
    const { id } = await create.json()

    try {
      const activeRow = page.locator(`#task-table tr[data-id="${active}"]`)
      const completeRow = page.locator(`#task-table tr[data-id="${complete}"]`)
      const presetToggle = page.getByRole("button", { name: "Saved filter presets" })
      const panel = page.getByRole("region", { name: "Saved Filter Presets" })

      await page.goto("/table?status=complete")
      await expect(completeRow).toBeVisible()
      // First worker control invalidates any preset list loaded before it.
      await page.waitForFunction(() =>
        !("serviceWorker" in navigator) || navigator.serviceWorker.controller?.state === "activated",
      )
      await presetToggle.press("Enter")
      const apply = panel.getByRole("button", { name: new RegExp(name) }).filter({ hasText: "<img src=x>" })
      await expect(apply.locator("img")).toHaveCount(0)
      await apply.press("Enter")
      await expect(presetToggle).toBeFocused()
      await expect(activeRow).toBeVisible()
      await expect(completeRow).toBeHidden()
      await expect(activeRow.locator(".col-title")).toBeVisible()
      await expect(activeRow.locator(".col-status")).toBeVisible()
      await expect(activeRow.locator(".col-due-date")).toBeHidden()
      const fromTable = new URL(page.url()).searchParams

      await page.goto("/table?status=complete")
      await page.getByRole("button", { name: "Search Meitheal…" }).press("Enter")
      await page.locator('[data-scope="views"]').click()
      await page.locator("#search-hub-input").fill(name)
      await page.locator(".search-hub-item").filter({ hasText: name }).press("Enter")
      await expect(activeRow).toBeVisible()
      await expect(completeRow).toBeHidden()
      await expect(activeRow.locator(".col-due-date")).toBeHidden()
      expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual(Object.fromEntries(fromTable))
    } finally {
      await request.delete("/api/saved-filters", { headers: { ...headers, "content-type": "application/json" }, params: { id } })
      await request.delete(`/api/tasks/${active}`, { headers })
      await request.delete(`/api/tasks/${complete}`, { headers })
    }
  })

  test("the compact Presets panel keeps actions reachable and keyboard Cancel does not save", async ({ page, request, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 680 })
    const name = `Preset${"界".repeat(92)}`
    const headers = { origin: new URL(baseURL!).origin }
    const response = await request.post("/api/saved-filters", {
      headers,
      data: { name, query_json: {}, icon: "<script>" + "W".repeat(100) },
    })
    expect(response.status()).toBe(201)
    const { id } = await response.json()
    let writes = 0
    page.on("request", request => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/saved-filters") writes++
    })
    try {
      await page.goto("/table?status=active")
      await page.getByRole("button", { name: "Saved filter presets" }).press("Enter")
      const panel = page.getByRole("region", { name: "Saved Filter Presets" })
      const apply = panel.getByRole("button", { name: `Apply ${name}`, exact: true })
      const remove = panel.getByRole("button", { name: `Delete ${name}`, exact: true })
      const save = panel.getByRole("button", { name: "Save Current Filters" })
      await expect(apply).toBeVisible()
      await expect(remove).toBeVisible()
      await expect(save).toBeVisible()
      await expect(panel.getByRole("button", { name: "Close panel" })).toBeVisible()
      const bounds = await panel.evaluate(el => {
        const { left, right, top, bottom } = el.getBoundingClientRect()
        const viewportWidth = innerWidth
        const scrollWidth = document.documentElement.scrollWidth
        const overflow = [...document.querySelectorAll<HTMLElement>("body *")].filter(node => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.right > viewportWidth && getComputedStyle(node).position !== "fixed"
        }).slice(0, 8).map(node => [node.tagName, node.id, String(node.className).slice(0, 100), node.getBoundingClientRect().right])
        return { left, right, top, bottom, viewportWidth, viewportHeight: innerHeight, scrollWidth,
          panelScroll: el.scrollWidth, panelWidth: el.clientWidth, overflow }
      })
      expect(bounds.left, JSON.stringify(bounds)).toBeGreaterThanOrEqual(0)
      expect(bounds.right, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewportWidth)
      expect(bounds.top, JSON.stringify(bounds)).toBeGreaterThanOrEqual(0)
      expect(bounds.bottom, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewportHeight)
      expect(bounds.panelScroll, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.panelWidth)
      expect(bounds.scrollWidth, JSON.stringify(bounds)).toBeLessThanOrEqual(bounds.viewportWidth)

      await save.press("Enter")
      const dialog = page.getByRole("dialog", { name: "Save Filter Preset" })
      const input = dialog.getByRole("textbox")
      await expect(input).toBeFocused()
      await input.fill("This must not be saved")
      await input.press("Tab")
      const cancel = dialog.getByRole("button", { name: "Cancel" })
      await expect(cancel).toBeFocused()
      await cancel.press("Enter")
      await expect(dialog).toBeHidden()
      await expect(save).toBeFocused()
      expect(writes).toBe(0)

      await remove.click()
      const confirmation = page.getByRole("alertdialog")
      await confirmation.getByRole("button", { name: "Delete", exact: true }).click()
      await expect(remove).toHaveCount(0)
      await expect(save).toBeFocused()
      expect((await request.get("/api/saved-filters").then(res => res.json())).filters).not.toContainEqual(
        expect.objectContaining({ id }),
      )
    } finally {
      await request.delete("/api/saved-filters", { headers: { ...headers, "content-type": "application/json" }, params: { id } })
    }
  })

  test("the packaged preset endpoint rejects aliases and retains canonical DELETE", async ({ request, baseURL }) => {
    const path = "/api/saved-filters"
    const expectedPolicy = "private, no-store"
    const headers = { origin: new URL(baseURL!).origin }
    for (const alias of ["/api//saved-filters", "/api/%2573aved-filters/", path + "/"]) {
      const result = await request.get(alias, { maxRedirects: 0 })
      expect(result.status(), alias).toBe(404)
      expect(result.headers()["cache-control"]).toBe(expectedPolicy)
      expect(result.headers()["location"]).toBeUndefined()
    }
    const rejected = await request.post(path, { headers: { origin: "https://untrusted.example" }, data: { name: "Rejected" } })
    expect(rejected.status()).toBe(403)
    expect(rejected.headers()["cache-control"]).toBe(expectedPolicy)
    const created = await request.post(path, { headers, data: { name: `Route ${randomUUID()}`, query_json: {} } })
    expect(created.status()).toBe(201)
    expect(created.headers()["cache-control"]).toBe(expectedPolicy)
    const { id } = await created.json()
    const deleted = await request.delete(path, { headers: { ...headers, "content-type": "application/json" }, params: { id } })
    expect(deleted.status(), await deleted.text()).toBe(200)
    expect(deleted.headers()["cache-control"]).toBe(expectedPolicy)
    expect(await deleted.json()).toEqual({ deleted: true })
  })

  test("restored sorting keeps subgroup totals below the rows after a Table view return", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
    const key = randomUUID()
    const ids: string[] = []
    try {
      for (const [title, priority, due] of [
        ["February", 1, "2030-02-03"], ["January", 1, "2030-01-20"], ["Undated", 2, null],
      ] as const) {
        const response = await request.post("/api/tasks", {
          headers, data: { title: `${key} ${title}`, status: "active", priority, due_date: due },
        })
        expect(response.status()).toBe(201)
        ids.push((await response.json()).id)
      }
      const params = new URLSearchParams({ search: key, groupBy: "status", subGroupBy: "priority", sort: "due_asc" })
      await page.goto("/table?" + params)
      const priorityOne = page.locator('#task-table .table-row[data-priority="1"]:visible')
      const due = page.locator('#task-table th[data-col="due_date"]')
      const visibleOrder = () => priorityOne.evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id))
      await expect(due).toHaveAttribute("aria-sort", "ascending")
      expect(await visibleOrder()).toEqual([ids[1], ids[0]])
      await expect(page.locator("#task-table .group-header-row:not(.sub-group-header-row) .group-count").filter({ hasText: "3" })).toBeVisible()
      await due.getByRole("button").press("Enter")
      await expect(due).toHaveAttribute("aria-sort", "descending")
      expect(await visibleOrder()).toEqual([ids[0], ids[1]])
      expect(await page.locator("#task-table tbody").evaluate(tbody => {
        const rows = Array.from(tbody.children)
        const subtotal = rows.findIndex(row => row.classList.contains("group-summary-row") && row.textContent?.includes("3 tasks"))
        const visible = rows.filter(row => row.classList.contains("table-row") && !row.classList.contains("filtered-out"))
        return subtotal >= 0 && visible.every(row => rows.indexOf(row) < subtotal) &&
          rows.at(-1)?.classList.contains("grand-total-row")
      })).toBe(true)

      const nav = page.getByRole("navigation", { name: "Task views" })
      await nav.getByRole("link", { name: "Kanban" }).click()
      await expect(nav.getByRole("link", { name: "Kanban" })).toHaveAttribute("aria-current", "page")
      await nav.getByRole("link", { name: "Table" }).click()
      await expect(due).toHaveAttribute("aria-sort", "descending")
      await page.getByRole("toolbar", { name: "Filter tasks" }).getByRole("textbox", { name: "Filter by text" }).fill(key + " January")
      await expect(priorityOne).toHaveCount(1)
      expect(await visibleOrder()).toEqual([ids[1]])
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
    }
  })

  test("explicit Area and literal labels take precedence over a remembered profile", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin, "content-type": "application/json" }
    const key = randomUUID()
    const ids: string[] = []
    const areas: string[] = []
    try {
      for (const name of ["First", "Second"]) {
        const created = await request.post("/api/areas", { headers, data: { name: key + " " + name } })
        expect(created.status()).toBe(201)
        areas.push((await created.json()).id)
      }
      const literalLabel = "fruit, veg"
      for (const [area, label, kind] of [
        [areas[0], literalLabel, "quick_capture"],
        [areas[0], "fruit", "quick_capture"],
        [areas[1], literalLabel, "quick_capture"],
        [areas[0], literalLabel, "standard_action"],
      ]) {
        const created = await request.post("/api/tasks", {
          headers,
          data: { title: `${key} ${ids.length}`, area_id: area, task_kind: kind, labels: JSON.stringify([label]) },
        })
        expect(created.status()).toBe(201)
        ids.push((await created.json()).id)
      }
      await page.addInitScript(({ areaId, key }) => {
        localStorage.setItem("meitheal-selected-area", JSON.stringify({ areaId, areaName: key + " Second", areaIcon: "📋" }))
      }, { areaId: areas[1], key })
      const params = new URLSearchParams({ search: key, area: areas[0]!, types: "quick_capture", label: literalLabel })
      const visible = page.locator("#task-table .table-row:visible")
      await page.goto("/table?" + params)
      await expect(visible).toHaveCount(1)
      await expect(visible.first()).toHaveAttribute("data-id", ids[0]!)
      await expect(page.locator("[data-area-label]")).toHaveText(key + " First")
      const toolbar = page.getByRole("toolbar", { name: "Filter tasks" })
      await expect(toolbar.getByRole("button", { name: "Quick capture" })).toHaveAttribute("aria-pressed", "true")
      await toolbar.getByRole("textbox", { name: "Filter by text" }).fill(key + " 0")
      await expect(page).toHaveURL(url => url.searchParams.get("search") === key + " 0")
      expect(new URL(page.url()).searchParams.getAll("label")).toEqual([literalLabel])
      await expect(visible.first()).toHaveAttribute("data-id", ids[0]!)

      await page.goto("/table?" + new URLSearchParams({ search: key, area: "" }))
      await expect(visible).toHaveCount(4)
      await expect(page.locator("[data-area-label]")).toHaveText("All Areas")
      await page.goto("/table?" + new URLSearchParams({ search: key }))
      await expect(visible).toHaveCount(1)
      await expect(visible.first()).toHaveAttribute("data-id", ids[2]!)
      await page.goto("/table?" + new URLSearchParams({ search: key, area: "missing-area" }))
      await expect(visible).toHaveCount(0)
      await expect(page.locator("[data-area-label]")).toHaveText("Unavailable Area")
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
      for (const id of areas) await request.delete(`/api/areas/${id}`, { headers })
    }
  })
})

test("Table workflow columns and Unassigned combine and survive a shared preset link", async ({ page, request, baseURL }) => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  const name = `Workflow columns ${randomUUID()}`
  const headers = { origin: new URL(baseURL!).origin }
  const ids: string[] = []
  let presetId: string | undefined
  const finishRefresh = deferred<void>()
  try {
    for (const [status, suffix] of [["pending", "A"], ["active", "B"], ["active", "C"], ["complete", "D"]]) {
      const created = await request.post("/api/tasks", { headers, data: { title: `${name} ${suffix}`, status } })
      expect(created.status(), await created.text()).toBe(201)
      const { id } = await created.json()
      ids.push(id)
      const assigned = await request.put(`/api/tasks/${id}`, {
        headers, data: { assigned_to: suffix === "C" ? "fixture-member" : null },
      })
      expect(assigned.status(), await assigned.text()).toBe(200)
    }

    await page.setViewportSize({ width: 320, height: 900 })
    const params = new URLSearchParams({ area: "", search: name, sort: "title-asc" })
    await page.goto(`/table?${params}`)
    await page.waitForFunction(() =>
      !("serviceWorker" in navigator) || navigator.serviceWorker.controller?.state === "activated",
    )
    const rows = page.locator("#task-table .table-row")
    const expectRows = async (expected: string[]) => {
      await expect.poll(() => rows.evaluateAll(items => items.map(item => (item as HTMLElement).dataset.id))).toEqual(expected)
    }
    await expectRows(ids)
    const toolbar = page.getByRole("toolbar", { name: "Filter tasks" })
    const columns = toolbar.locator("summary").filter({ hasText: "Workflow columns" })
    await columns.press("Enter")
    const todo = toolbar.getByRole("checkbox", { name: "Todo", exact: true })
    const refreshStarted = deferred<void>()
    await page.route(url => url.pathname === "/tasks" && url.searchParams.has("tableRefresh"), async route => {
      refreshStarted.resolve()
      await finishRefresh.promise
      await route.continue()
    }, { times: 1 })
    await todo.press("Space")
    await refreshStarted.promise
    const presetToggle = page.getByRole("button", { name: "Saved filter presets" })
    const panel = page.getByRole("region", { name: "Saved Filter Presets" })
    const save = panel.getByRole("button", { name: "Save Current Filters" })
    await presetToggle.press("Enter")
    await expect(save).toBeEnabled()
    await save.press("Enter")
    await expect(panel).toContainText("Apply the Table filters before saving a preset.")
    await expect(page.getByRole("dialog", { name: "Save Filter Preset" })).toHaveCount(0)
    finishRefresh.resolve()
    await expectRows([ids[0]!])
    await panel.getByRole("button", { name: "Close panel" }).click()
    const active = toolbar.getByRole("checkbox", { name: "In Progress", exact: true })
    await active.press("Space")
    await expectRows(ids.slice(0, 3))
    await expect(active).toBeFocused()
    await active.press("Escape")
    await expect(columns).toBeFocused()
    await expect(active).toBeHidden()
    await expectRows(ids.slice(0, 3))
    await toolbar.getByRole("checkbox", { name: "Unassigned" }).press("Space")
    await expectRows(ids.slice(0, 2))
    expect(await toolbar.evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(321)
    const bookmark = new URL(page.url())
    expect(bookmark.searchParams.getAll("lane")).toEqual(["lane-pending", "lane-active"])
    expect(bookmark.searchParams.get("user")).toBe("__unassigned__")
    await page.reload()
    await expectRows(ids.slice(0, 2))
    await expect(toolbar.getByRole("checkbox", { name: "Unassigned" })).toBeChecked()

    await presetToggle.press("Enter")
    await expect(save).toBeEnabled()
    await save.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Save Filter Preset" })
    await dialog.getByRole("textbox").fill(name)
    const savedResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/saved-filters" && response.request().method() === "POST",
    )
    await dialog.getByRole("button", { name: "OK" }).press("Enter")
    const saved = await savedResponse
    expect(saved.status(), await saved.text()).toBe(201)
    const savedFilters = await request.get("/api/saved-filters").then(response => response.json())
    presetId = savedFilters.filters.find((preset: { id: string; name: string }) => preset.name === name)?.id
    expect(presetId).toBeDefined()
    const result = await request.get("/api/search", { params: { q: name, scope: "views" } })
    expect(result.status(), await result.text()).toBe(200)
    const { sections } = await result.json()
    const item = sections.find((section: { id: string }) => section.id === "saved_filters")
      ?.items.find((candidate: { id: string }) => candidate.id === presetId)
    expect(item?.href).toBeDefined()
    await page.goto(item.href)
    await expectRows(ids.slice(0, 2))

    bookmark.searchParams.delete("lane")
    bookmark.searchParams.append("lane", "removed-".padEnd(470, "x"))
    await page.goto(bookmark.href)
    await expectRows([])
    await columns.press("Enter")
    await expect(toolbar.getByRole("checkbox", { name: /^Unavailable workflow column/ })).toBeChecked()
    expect(await toolbar.evaluate(el => el.getBoundingClientRect().right)).toBeLessThanOrEqual(321)
    await toolbar.getByRole("button", { name: "Clear all active filters" }).press("Enter")
    await expect(page).toHaveURL(url => !url.searchParams.has("lane") && !url.searchParams.has("user"))
    await expect(toolbar.getByRole("textbox", { name: "Filter by text" })).toBeFocused()

    bookmark.searchParams.delete("lane")
    const requested = ["removed\u0000column", ...Array.from({ length: 49 }, (_, index) => `removed-${index}`)]
    for (const id of [...requested, "lane-pending"]) bookmark.searchParams.append("lane", id)
    await page.goto(bookmark.href)
    await columns.press("Enter")
    const missing = toolbar.getByRole("checkbox", { name: /^Unavailable workflow column/ })
    await expect(missing).toHaveCount(50)
    await expect(missing.first()).toBeChecked()
    await expect(todo).toBeDisabled()
    await expect(toolbar.getByText("You can select up to 50 workflow columns.")).toBeVisible()
    await toolbar.getByRole("checkbox", { name: "Unassigned" }).press("Space")
    await expect(page).toHaveURL(url => !url.searchParams.has("user") &&
      JSON.stringify(url.searchParams.getAll("lane")) === JSON.stringify(requested))
    await missing.last().press("Space")
    await expect(todo).toBeEnabled()
    await expect(toolbar.getByText("You can select up to 50 workflow columns.")).toBeHidden()
  } finally {
    finishRefresh.resolve()
    if (presetId) await request.delete("/api/saved-filters", { headers, params: { id: presetId } })
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})

test("Save Current Filters keeps the applied view when another tab changes preferences", async ({ page, request, baseURL }) => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  const name = `Applied Table ${randomUUID()}`
  const headers = { origin: new URL(baseURL!).origin }
  let presetId: string | undefined
  const other = await page.context().newPage()
  try {
    await page.goto("/tasks?view=table")
    await page.waitForFunction(() =>
      !("serviceWorker" in navigator) || navigator.serviceWorker.controller?.state === "activated",
    )
    const shell = page.locator("#table-shell")
    await expect(shell).toHaveAttribute("data-table-ready", "true")
    await expect(page).toHaveURL(url => url.search === "?view=table")
    const initial = JSON.parse((await shell.getAttribute("data-table-filters"))!)
    await page.getByRole("button", { name: "Saved filter presets" }).press("Enter")
    const save = page.getByRole("button", { name: "Save Current Filters" })
    await expect(save).toBeEnabled()
    await save.press("Enter")
    const dialog = page.getByRole("dialog", { name: "Save Filter Preset" })
    await expect(dialog).toBeVisible()
    await other.goto("/tasks?view=table")
    await other.evaluate(() => {
      localStorage.setItem("meitheal-task-view-filters", JSON.stringify({ search: "Other tab only" }))
      localStorage.setItem("meitheal-selected-area", JSON.stringify({ areaId: "other-area", areaName: "Other Area" }))
      localStorage.setItem("meitheal-column-preferences", JSON.stringify({ status: false }))
    })
    await dialog.getByRole("textbox").fill(name)
    const savedResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/saved-filters" && response.request().method() === "POST",
    )
    await dialog.getByRole("button", { name: "OK" }).press("Enter")
    const saved = await savedResponse
    expect(saved.status(), await saved.text()).toBe(201)
    presetId = (await saved.json()).id
    expect(presetId).toBeDefined()
    expect(saved.request().postDataJSON().query_json).toMatchObject({ area: "", columns: initial.columns })
    expect(saved.request().postDataJSON().query_json.search ?? "").toBe("")
  } finally {
    await other.close()
    if (presetId) await request.delete("/api/saved-filters", { headers, params: { id: presetId } })
  }
})
