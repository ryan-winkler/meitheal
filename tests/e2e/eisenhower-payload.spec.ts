import { randomUUID } from "node:crypto"
import { expect, test, type APIRequestContext } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro server")
const origin = process.env.E2E_BASE_URL ? new URL(process.env.E2E_BASE_URL).origin : undefined
test.use({ serviceWorkers: "block", ...(origin ? { extraHTTPHeaders: { origin } } : {}) })

async function removeFixtureTask(request: APIRequestContext, path: string, headers: Record<string, string>) {
  const response = await request.delete(path, { headers, data: {} })
  expect([204, 404], [204, 404].includes(response.status()) ? undefined : await response.text()).toContain(response.status())
}

const scoring = { rice: { reach: 9, confidence: 0.8 }, retained: { note: "Keep unrelated scoring" } }

for (const failure of ["unavailable", "network", "invalid-json", "array", "scalar", "missing", "wrong-task"] as const) {
  test(`triage preserves scoring and retry inputs when metadata is ${failure}`, async ({ page, request }) => {
    const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
    const created = await request.post("/api/tasks", { headers, data: {
      title: `Eisenhower metadata ${randomUUID()}`, status: "pending", urgency: 0, importance: 0,
      framework_payload: JSON.stringify(scoring),
    } })
    expect(created.status(), await created.text()).toBe(201)
    const task = await created.json()
    const path = `/api/tasks/${task.id}`
    const writes: Record<string, unknown>[] = []
    let failedReads = 0
    let rejectRead = true
    try {
      await page.route(`**${path}`, async route => {
        if (route.request().method() === "PUT") writes.push(route.request().postDataJSON())
        if (route.request().method() !== "GET" || !rejectRead) return route.continue()
        failedReads++
        if (failure === "unavailable") return route.fulfill({ status: 503, json: { error: "Temporary metadata failure" } })
        if (failure === "network") return route.abort("failed")
        if (failure === "invalid-json") return route.fulfill({ contentType: "application/json", body: "{unfinished" })
        if (failure === "missing") return route.fulfill({ json: { id: task.id } })
        return route.fulfill({ json: {
          id: failure === "wrong-task" ? "another-task" : task.id,
          framework_payload: failure === "array" ? [] : failure === "scalar" ? "42" : JSON.stringify(scoring),
        } })
      })
      await page.goto("/eisenhower")
      await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
      await expect(page.locator("#st-task-title")).toHaveText(task.title)
      await page.waitForLoadState("networkidle")
      await page.locator("#st-num-urgency").fill("4")
      await page.locator("#st-num-importance").fill("5")
      await page.locator("#st-details summary").click()
      await page.locator("#st-detail-delay").selectOption("critical")
      await page.getByText("Engaging", { exact: true }).click()
      await page.locator("#st-save-btn").click()
      await expect.poll(() => failedReads).toBeGreaterThan(0)
      await expect(page.locator("#toast-container .toast.error")).toBeVisible()
      const unchanged = await (await request.get(path)).json()
      expect(JSON.parse(unchanged.framework_payload)).toEqual(scoring)
      expect(writes).toEqual([])
      await expect(page.locator("#scoring-triage-modal")).toBeVisible()
      await expect(page.locator("#st-num-urgency")).toHaveValue("4")
      await expect(page.locator("#st-num-importance")).toHaveValue("5")
      await expect(page.locator("#st-detail-delay")).toHaveValue("critical")
      await expect(page.locator('input[name="st-interest"][value="engaging"]')).toBeChecked()
      rejectRead = false
      await page.locator("#st-save-btn").click()
      await expect(page.locator("#scoring-triage-modal")).toBeHidden()
      const saved = await (await request.get(path)).json()
      const list = await (await request.get("/api/tasks")).json()
      expect(list.tasks.find((row: { id: string }) => row.id === task.id)).toMatchObject({ urgency: 4, importance: 5 })
      expect(JSON.parse(saved.framework_payload)).toEqual({ ...scoring, delay_impact: "critical", interest_tag: "engaging" })
      expect(writes).toHaveLength(1)
    } finally { await removeFixtureTask(request, path, headers) }
  })
}

test("RICE triage keeps declared low confidence and publishes zero to the scored Board group", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
  const rice = { reach: 4, impact: 2, effort: 1, confidence: 1, confidence_unit: "percent" }
  const created = await request.post("/api/tasks", { headers, data: {
    title: "RICE low confidence fixture", framework_payload: { rice, retained: scoring.retained },
  } })
  expect(created.status()).toBe(201)
  const task = await created.json()
  const path = `/api/tasks/${task.id}`
  let releaseRefresh!: () => void
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  const reloads: string[] = []
  try {
    await page.goto("/eisenhower")
    const refreshPath = (url: URL) => url.pathname === "/eisenhower"
    await page.route(refreshPath, async route => {
      if (route.request().headers()["x-meitheal-refresh"] !== "1") return route.continue()
      await heldRefresh
      await route.continue().catch(() => {})
    })
    page.on("request", outgoing => {
      const url = new URL(outgoing.url())
      if (outgoing.isNavigationRequest() && url.pathname === "/eisenhower") reloads.push(url.pathname)
    })
    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    await page.locator("#st-framework-select").selectOption("rice")
    await page.locator("#st-unscored-only").uncheck()
    await expect(page.locator("#st-task-title")).toHaveText(task.title)
    await expect(page.locator("#st-range-confidence")).toHaveValue("1")
    await page.locator("#st-num-confidence").fill("0")
    await expect(page.locator("#st-preview-badge")).toHaveText("RICE 0")
    const refresh = page.waitForRequest(outgoing => refreshPath(new URL(outgoing.url())) && outgoing.headers()["x-meitheal-refresh"] === "1", { timeout: 5000 })
    void refresh.catch(() => {})
    await page.locator("#st-save-btn").click()
    const outgoing = await refresh
    expect(outgoing.isNavigationRequest()).toBe(false)
    const interrupted = page.waitForEvent("requestfailed", { predicate: failed => failed === outgoing, timeout: 5000 })
    void interrupted.catch(() => {})
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()
    const saved = await (await request.get(path)).json()
    expect(JSON.parse(saved.framework_payload)).toEqual({ rice: { ...rice, confidence: 0 }, retained: scoring.retained })
    await page.getByRole("link", { name: "Tasks", exact: true }).filter({ visible: true }).first().click()
    await expect(page).toHaveURL(url => url.pathname === "/tasks")
    expect((await interrupted).failure()?.errorText).toMatch(/ABORT/)
    releaseRefresh()
    expect(reloads).toEqual([])
    await page.goto("/tasks?area=&groupBy=rice#kanban")
    await expect(page.locator(`[data-swimlane-type="low"] .kanban-card[data-id="${task.id}"]`)).toBeVisible()
  } finally {
    releaseRefresh()
    await removeFixtureTask(request, path, headers)
  }
})

test("scoring refreshes the current Eisenhower matrix without replacing its document", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
  const created = await request.post("/api/tasks", { headers, data: {
    title: `Classify on the existing matrix ${randomUUID()}`, status: "pending", urgency: 0, importance: 0,
  } })
  expect(created.status()).toBe(201)
  const task = await created.json()
  const path = `/api/tasks/${task.id}`
  const matrix = "/eisenhower?board_id=household&area=#eisenhower-matrix"
  let releaseRefresh!: () => void
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  let releaseWrite!: () => void
  const heldWrite = new Promise<void>(resolve => { releaseWrite = resolve })
  try {
    await page.goto(matrix)
    const refreshPath = (url: URL) => url.pathname === "/eisenhower"
    await page.route(refreshPath, async route => {
      if (route.request().headers()["x-meitheal-refresh"] !== "1") return route.continue()
      await heldRefresh
      await route.continue().catch(() => {})
    })
    const row = `.tli[data-id="${task.id}"]`
    await expect(page.locator(`[data-drop-zone="not-now"] ${row}`)).toBeVisible()
    const section = await page.locator("#eisenhower-matrix").elementHandle()
    const capture = page.locator('[data-quadrant-capture="schedule"]')
    await capture.fill("Keep this quick capture draft")
    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    await expect(page.locator("#st-task-title")).toHaveText(task.title)
    await page.locator("#st-num-urgency").fill("4")
    await page.locator("#st-num-importance").fill("5")
    const refresh = page.waitForRequest(outgoing => refreshPath(new URL(outgoing.url())) && outgoing.headers()["x-meitheal-refresh"] === "1", { timeout: 5000 })
    void refresh.catch(() => {})
    await page.locator("#st-save-btn").click()
    await refresh
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()

    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    await page.locator("#st-unscored-only").uncheck()
    await expect(page.locator("#st-task-title")).toHaveText(task.title)
    releaseRefresh()
    await expect(page.locator(`[data-drop-zone="do-first"] ${row}`)).toBeVisible()
    await expect(page.locator("#scoring-triage-modal")).toBeVisible()

    let reportWrite!: (status: number) => void
    const write = new Promise<number>(resolve => { reportWrite = resolve })
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "PUT") return route.continue()
      const saved = await route.fetch()
      reportWrite(saved.status())
      await heldWrite
      await route.fulfill({ response: saved }).catch(() => {})
    })
    await page.locator("#st-num-urgency").fill("1")
    await page.locator("#st-num-importance").fill("4")
    await page.locator("#st-save-btn").click()
    expect(await write).toBe(200)
    await page.keyboard.press("Escape")
    await expect(page.locator("#scoring-triage-modal")).toBeVisible()
    releaseWrite()
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()
    await expect(page.locator(`[data-drop-zone="schedule"] ${row}`)).toBeVisible()
    await expect(page).toHaveURL(url => url.pathname + url.search + url.hash === matrix)
    expect(await section?.evaluate(element => element.isConnected)).toBe(true)
    await expect(capture).toHaveValue("Keep this quick capture draft")
    await page.locator(`[data-drop-zone="schedule"] ${row}`).click()
    await expect(page.locator("#td-loaded-content")).toBeVisible()
  } finally {
    releaseRefresh()
    releaseWrite()
    await removeFixtureTask(request, path, headers)
  }
})

test("a delayed scoring refresh preserves a newer matrix drag", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
  const tasks: { id: string; title: string }[] = []
  let releaseRefresh!: () => void
  const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve })
  try {
    for (const [label, priority] of [["Score this one", 0], ["Drag this one", 1]] as const) {
      const created = await request.post("/api/tasks", { headers, data: {
        title: `${label} ${randomUUID()}`, status: "pending", urgency: priority, importance: priority,
      } })
      expect(created.status()).toBe(201)
      tasks.push(await created.json())
    }
    const [scored, moved] = tasks
    await page.goto("/eisenhower?board_id=household&area=#eisenhower-matrix")
    const isRefresh = (outgoing: { url(): string; headers(): Record<string, string> }) =>
      new URL(outgoing.url()).pathname === "/eisenhower" && outgoing.headers()["x-meitheal-refresh"] === "1"
    let reportSnapshot!: (status: number) => void
    const snapshot = new Promise<number>(resolve => { reportSnapshot = resolve })
    let reads = 0
    await page.route(url => url.pathname === "/eisenhower", async route => {
      if (!isRefresh(route.request()) || ++reads > 1) return route.continue()
      const response = await route.fetch()
      reportSnapshot(response.status())
      await heldRefresh
      await route.fulfill({ response }).catch(() => {})
    })

    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    await expect(page.locator("#st-task-title")).toHaveText(scored!.title)
    await page.locator("#st-num-urgency").fill("4")
    await page.locator("#st-num-importance").fill("5")
    await page.locator("#st-save-btn").click()
    expect(await snapshot).toBe(200)
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()

    const row = `.tli[data-id="${moved!.id}"]`
    const from = page.locator(`[data-drop-zone="not-now"] ${row}`).getByRole("link", { name: moved!.title })
    const to = page.locator('[data-drop-zone="delegate"] .quadrant__empty')
    await from.scrollIntoViewIfNeeded()
    await to.scrollIntoViewIfNeeded()
    await expect(from).toBeInViewport()
    await expect(to).toBeInViewport()
    const source = (await from.boundingBox())!
    const target = (await to.boundingBox())!
    const startX = source.x + source.width / 2
    const startY = source.y + source.height / 2
    const endX = target.x + target.width / 2
    const endY = target.y + target.height / 2
    const dragSaved = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/tasks/${moved!.id}`)
    void dragSaved.catch(() => {})
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    try {
      await page.mouse.move(startX + 16, startY, { steps: 4 })
      await page.mouse.move(endX, endY, { steps: 16 })
      await page.mouse.move(endX + 2, endY)
      await expect(page.locator('[data-quadrant="delegate"]')).toHaveClass(/quadrant--drag-over/)
    } finally { await page.mouse.up() }
    expect((await dragSaved).status()).toBe(200)
    await expect(page.locator(`[data-drop-zone="delegate"] ${row}`)).toBeVisible()

    const watch = await page.evaluateHandle(selector => {
      let returned = false
      const observer = new MutationObserver(() => { returned ||= Boolean(document.querySelector(selector)) })
      observer.observe(document.getElementById("eisenhower-matrix")!, { childList: true, subtree: true })
      return () => { observer.disconnect(); return returned }
    }, `[data-drop-zone="not-now"] ${row}`)
    releaseRefresh()
    await expect(page.locator(`[data-drop-zone="do-first"] .tli[data-id="${scored!.id}"]`)).toBeVisible()
    expect(reads).toBe(2)
    expect(await watch.evaluate(stop => stop())).toBe(false)
    await expect(page.locator(`[data-drop-zone="delegate"] ${row}`)).toBeVisible()
  } finally {
    releaseRefresh()
    for (const task of tasks) await removeFixtureTask(request, `/api/tasks/${task.id}`, headers)
  }
})

test("closing Planning triage after one save refreshes the current RICE ranking", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
  const areas: string[] = []
  const tasks: { id: string; title: string }[] = []
  async function createTask(area: string, title: string, framework_payload?: object) {
    const response = await request.post("/api/tasks", { headers, data: {
      title, area_id: area, status: "pending", framework_payload,
    } })
    expect(response.status(), await response.text()).toBe(201)
    const task = await response.json() as { id: string; title: string }
    tasks.push(task)
    return task
  }
  try {
    for (const name of ["RICE Workshop", "RICE Control Room"]) {
      const created = await request.post("/api/areas", { headers, data: { name: `${name} ${randomUUID()}` } })
      expect(created.status(), await created.text()).toBe(201)
      areas.push((await created.json()).id)
    }
    const [area, otherArea] = areas as [string, string]
    await createTask(area, "RICE triage one")
    await createTask(area, "RICE triage two")
    const control = await createTask(otherArea, "Ranked task in another Area", {
      rice: { reach: 3, impact: 2, effort: 1, confidence: 100, confidence_unit: "percent" },
    })
    const triage = page.getByRole("button", { name: "RICE Triage", exact: true })
    const modal = page.locator("#scoring-triage-modal")
    const title = page.locator("#st-task-title")
    const ranked = page.locator('[data-rice-list="ranked"]')
    await page.goto(`/planning?board_id=household&area=${otherArea}#rice`)
    await expect(ranked.locator(`[data-rice-task="${control.id}"] [data-rice-score]`)).toHaveText("6")
    await page.goto(`/planning?board_id=household&area=${area}#rice`)
    await triage.click()
    await page.locator("#st-filter-area").selectOption(area)
    await expect(title).toHaveText(/RICE triage (?:one|two)/)
    const selectedTitle = await title.textContent()
    const selected = tasks.find(task => task.title === selectedTitle)
    expect(selected).toBeDefined()
    await page.locator("#st-close-btn").click()

    const planning = `/planning?board_id=household&area=${area}&score=${selected!.id}#rice`
    await page.goto(planning)
    const section = await page.locator("#planning-section-rice").elementHandle()
    const summary = page.locator("[data-rice-summary]")
    const editor = page.locator("[data-rice-editor]")
    const reach = editor.locator("#rice-num-reach")
    const saveScore = editor.getByRole("button", { name: "Save score" })
    await expect(summary).toHaveText("0 ranked · 2 need a score · Average —")
    await expect(saveScore).toBeEnabled()
    const originalVersion = await editor.getAttribute("data-rice-version")
    expect(originalVersion).not.toBeNull()
    await triage.click()
    await page.locator("#st-filter-area").selectOption(area)
    await expect(title).toHaveText(selected!.title)
    for (const [field, value] of Object.entries({ reach: "4", impact: "2", effort: "1", confidence: "100" })) {
      await page.locator(`#st-num-${field}`).fill(value)
    }
    await expect(page.locator("#st-preview-badge")).toHaveText("RICE 8")
    await page.locator("#st-save-btn").click()
    await expect(title).not.toHaveText(selected!.title)
    await expect(modal).toBeVisible()
    await page.locator("#st-close-btn").click()
    const score = ranked.locator(`[data-rice-task="${selected!.id}"] [data-rice-score]`)
    await expect(score).toHaveText("8")
    await expect(ranked.locator(`[data-rice-task="${control.id}"]`)).toHaveCount(0)
    await expect(summary).toHaveText("1 ranked · 1 need a score · Average 8")
    await expect(editor).not.toHaveAttribute("data-rice-version", originalVersion!)
    await expect(reach).toHaveValue("4")
    await expect(saveScore).toBeEnabled()
    await expect(triage).toBeFocused()
    await expect(page).toHaveURL(url => url.pathname + url.search + url.hash === planning)
    expect(await section?.evaluate(element => element.isConnected)).toBe(true)

    await reach.fill("7")
    await expect(editor.locator("output")).toHaveText("14")
    await triage.click()
    await page.locator("#st-filter-area").selectOption(area)
    await page.locator("#st-unscored-only").uncheck()
    const lastInQueue = await title.textContent() !== selected!.title
    if (lastInQueue) await page.locator("#st-skip-btn").click()
    await expect(title).toHaveText(selected!.title)
    await page.locator("#st-num-reach").fill("5")
    await page.locator("#st-save-btn").click()
    if (lastInQueue) {
      await expect(modal).toBeHidden()
    } else {
      await expect(title).not.toHaveText(selected!.title)
      await page.locator("#st-close-btn").click()
    }
    await expect(score).toHaveText("10")
    await expect(reach).toHaveValue("7")
    await expect(saveScore).toBeDisabled()
    await expect(editor.locator('[data-rice-message][role="status"]')).toContainText("Reload the score")
    await editor.getByRole("button", { name: "Reload score" }).click()
    await expect(reach).toHaveValue("5")
    await expect(saveScore).toBeEnabled()
  } finally {
    for (const task of tasks) await removeFixtureTask(request, `/api/tasks/${task.id}`, headers)
    for (const area of areas) await request.delete(`/api/areas/${area}`, { headers, data: {} })
  }
})

test("triage adds metadata when the task has no existing framework values", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
  const created = await request.post("/api/tasks", { headers, data: { title: `Empty framework ${randomUUID()}`, status: "pending", urgency: 0, importance: 0 } })
  expect(created.status()).toBe(201)
  const task = await created.json()
  const path = `/api/tasks/${task.id}`
  try {
    await page.goto("/eisenhower")
    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    await expect(page.locator("#st-task-title")).toHaveText(task.title)
    await page.waitForLoadState("networkidle")
    await page.locator("#st-num-urgency").fill("3")
    await page.locator("#st-details summary").click()
    await page.locator("#st-detail-delay").selectOption("costly")
    const responsePromise = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === "PUT")
    await page.locator("#st-save-btn").click()
    const response = await responsePromise
    expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()
    expect(JSON.parse((await (await request.get(path)).json()).framework_payload)).toEqual({ delay_impact: "costly" })
  } finally { await removeFixtureTask(request, path, headers) }
})

for (const action of ["promote", "archive", "delete"] as const) {
  test(`review ${action} never replaces scoring when its optional metadata read fails`, async ({ page, request }) => {
    const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
    const created = await request.post("/api/tasks", { headers, data: {
      title: `Review metadata ${randomUUID()}`, urgency: 1, importance: 1, framework_payload: JSON.stringify(scoring),
    } })
    expect(created.status()).toBe(201)
    const task = await created.json()
    const path = `/api/tasks/${task.id}`
    let metadataReads = 0
    let metadataWrites = 0
    let primaryWrites = 0
    try {
      await page.route(`**${path}`, async route => {
        const method = route.request().method()
        if (method === "GET") { metadataReads++; return route.fulfill({ status: 503, json: { error: "Temporary metadata failure" } }) }
        if (method === "PUT" && route.request().postDataJSON().framework_payload) metadataWrites++
        else if (method === "PUT" || method === "DELETE") primaryWrites++
        await route.continue()
      })
      await page.goto("/eisenhower")
      await page.locator('[data-action="start-review"]').click()
      await expect(page.locator("#review-task-name")).toContainText(task.title)
      await page.locator(`[data-action="review-${action}"]`).click()
      await expect(page.locator("#review-overlay")).toBeHidden()
      expect(primaryWrites).toBe(1)
      expect(metadataWrites).toBe(0)
      expect(metadataReads).toBe(action === "delete" ? 0 : 1)
      const response = await request.get(path)
      if (action === "delete") expect(response.status()).toBe(404)
      else {
        const saved = await response.json()
        expect(JSON.parse(saved.framework_payload)).toEqual(scoring)
        if (action === "archive") expect(saved.status).toBe("complete")
        else expect(saved).toMatchObject({ urgency: 5, importance: 1 })
      }
    } finally { await removeFixtureTask(request, path, headers) }
  })
}

test("review reports a rejected primary action without trying metadata or advancing", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
  const created = await request.post("/api/tasks", { headers, data: {
    title: `Rejected review ${randomUUID()}`, urgency: 1, importance: 1, framework_payload: JSON.stringify(scoring),
  } })
  expect(created.status()).toBe(201)
  const task = await created.json()
  const path = `/api/tasks/${task.id}`
  let reads = 0
  let writes = 0
  try {
    await page.route(`**${path}`, async route => {
      if (route.request().method() === "GET") reads++
      if (route.request().method() === "PUT") { writes++; return route.fulfill({ status: 503, json: { error: "Rejected primary action" } }) }
      await route.continue()
    })
    await page.goto("/eisenhower")
    await page.locator('[data-action="start-review"]').click()
    await page.locator('[data-action="review-promote"]').click()
    await expect(page.locator("#toast-container .toast.error")).toBeVisible()
    await expect(page.locator("#review-overlay")).toBeVisible()
    expect(writes).toBe(1)
    expect(reads).toBe(0)
    expect(JSON.parse((await (await request.get(path)).json()).framework_payload)).toEqual(scoring)
  } finally { await removeFixtureTask(request, path, headers) }
})

test("closing triage while its metadata read is pending prevents a late save", async ({ page, request }) => {
  const headers = await currentBoardWriteHeaders(request, "household", origin ? { origin } : {})
  const created = await request.post("/api/tasks", { headers, data: {
    title: `Retired metadata ${randomUUID()}`, status: "pending", urgency: 0, importance: 0,
    framework_payload: JSON.stringify(scoring),
  } })
  expect(created.status()).toBe(201)
  const task = await created.json()
  const path = `/api/tasks/${task.id}`
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let pending = false
  let writes = 0
  try {
    await page.route(`**${path}`, async route => {
      if (route.request().method() === "PUT") writes++
      if (route.request().method() !== "GET") return route.continue()
      pending = true
      await hold
      await route.continue().catch(() => undefined)
    })
    await page.goto("/eisenhower")
    await page.getByRole("button", { name: "Scoring Triage", exact: true }).click()
    await expect(page.locator("#st-task-title")).toHaveText(task.title)
    await page.waitForLoadState("networkidle")
    await page.locator("#st-num-urgency").fill("4")
    await page.locator("#st-details summary").click()
    await page.locator("#st-detail-delay").selectOption("critical")
    await page.locator("#st-save-btn").click()
    await expect.poll(() => pending).toBe(true)
    const retired = page.waitForEvent("requestfailed", request => request.url().endsWith(path) && request.method() === "GET")
    await page.locator("#st-close-btn").click()
    await expect(page.locator("#scoring-triage-modal")).toBeHidden()
    release()
    await retired
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(writes).toBe(0)
    const saved = await (await request.get(path)).json()
    const list = await (await request.get("/api/tasks")).json()
    expect(list.tasks.find((row: { id: string }) => row.id === task.id)).toMatchObject({ urgency: 0, importance: 0 })
    expect(JSON.parse(saved.framework_payload)).toEqual(scoring)
  } finally {
    release()
    await removeFixtureTask(request, path, headers)
  }
})
