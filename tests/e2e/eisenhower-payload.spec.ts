import { randomUUID } from "node:crypto"
import { expect, test, type APIRequestContext } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Astro server")
const origin = process.env.E2E_BASE_URL ? new URL(process.env.E2E_BASE_URL).origin : undefined
test.use({ serviceWorkers: "block", ...(origin ? { extraHTTPHeaders: { origin } } : {}) })

async function removeFixtureTask(request: APIRequestContext, path: string) {
  const response = await request.delete(path, { headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) }, data: {} })
  expect([204, 404], [204, 404].includes(response.status()) ? undefined : await response.text()).toContain(response.status())
}

const scoring = { rice: { reach: 9, confidence: 0.8 }, retained: { note: "Keep unrelated scoring" } }

for (const failure of ["unavailable", "network", "invalid-json", "array", "scalar", "missing", "wrong-task"] as const) {
  test(`triage preserves scoring and retry inputs when metadata is ${failure}`, async ({ page, request }) => {
    const created = await request.post("/api/tasks", { data: {
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
      await page.locator('[data-action="start-triage"]').click()
      await expect(page.locator("#triage-task-name")).toHaveText(task.title)
      await page.waitForLoadState("networkidle")
      await page.locator("#triage-urgency").fill("4")
      await page.locator("#triage-importance").fill("5")
      await page.locator(".triage-card__details summary").click()
      await page.locator("#triage-delay-impact").selectOption("critical")
      await page.locator('input[name="triage-interest"][value="engaging"]').check()
      await page.locator('[data-action="triage-save"]').click()
      await expect.poll(() => failedReads).toBeGreaterThan(0)
      await expect.poll(async () => (await page.locator("#toast-container .toast.error").count()) > 0 || !(await page.locator("#triage-overlay").isVisible())).toBe(true)
      const unchanged = await (await request.get(path)).json()
      expect(JSON.parse(unchanged.framework_payload)).toEqual(scoring)
      expect(writes).toEqual([])
      await expect(page.locator("#triage-overlay")).toBeVisible()
      await expect(page.locator("#toast-container .toast.error")).toBeVisible()
      await expect(page.locator("#triage-urgency")).toHaveValue("4")
      await expect(page.locator("#triage-importance")).toHaveValue("5")
      await expect(page.locator("#triage-delay-impact")).toHaveValue("critical")
      await expect(page.locator('input[name="triage-interest"][value="engaging"]')).toBeChecked()
      rejectRead = false
      await page.locator('[data-action="triage-save"]').click()
      await expect(page.locator("#triage-overlay")).toBeHidden()
      const saved = await (await request.get(path)).json()
      const list = await (await request.get("/api/tasks")).json()
      expect(list.tasks.find((row: { id: string }) => row.id === task.id)).toMatchObject({ urgency: 4, importance: 5 })
      expect(JSON.parse(saved.framework_payload)).toEqual({ ...scoring, delay_impact: "critical", interest_tag: "engaging" })
      expect(writes).toHaveLength(1)
    } finally { await removeFixtureTask(request, path) }
  })
}

test("triage adds metadata when the task has no existing framework values", async ({ page, request }) => {
  const created = await request.post("/api/tasks", { data: { title: `Empty framework ${randomUUID()}`, status: "pending", urgency: 0, importance: 0 } })
  expect(created.status()).toBe(201)
  const task = await created.json()
  const path = `/api/tasks/${task.id}`
  try {
    await page.goto("/eisenhower")
    await page.locator('[data-action="start-triage"]').click()
    await expect(page.locator("#triage-task-name")).toHaveText(task.title)
    await page.waitForLoadState("networkidle")
    await page.locator("#triage-urgency").fill("3")
    await page.locator(".triage-card__details summary").click()
    await page.locator("#triage-delay-impact").selectOption("costly")
    const responsePromise = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === "PUT")
    await page.locator('[data-action="triage-save"]').click()
    const response = await responsePromise
    expect(response.status(), response.ok() ? undefined : await response.text()).toBe(200)
    await expect(page.locator("#triage-overlay")).toBeHidden()
    expect(JSON.parse((await (await request.get(path)).json()).framework_payload)).toEqual({ delay_impact: "costly" })
  } finally { await removeFixtureTask(request, path) }
})

for (const action of ["promote", "archive", "delete"] as const) {
  test(`review ${action} never replaces scoring when its optional metadata read fails`, async ({ page, request }) => {
    const created = await request.post("/api/tasks", { data: {
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
    } finally { await removeFixtureTask(request, path) }
  })
}

test("review reports a rejected primary action without trying metadata or advancing", async ({ page, request }) => {
  const created = await request.post("/api/tasks", { data: {
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
  } finally { await removeFixtureTask(request, path) }
})

test("closing triage while its metadata read is pending prevents a late save", async ({ page, request }) => {
  const created = await request.post("/api/tasks", { data: {
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
      await route.continue()
    })
    await page.goto("/eisenhower")
    await page.locator('[data-action="start-triage"]').click()
    await expect(page.locator("#triage-task-name")).toHaveText(task.title)
    await page.waitForLoadState("networkidle")
    await page.locator("#triage-urgency").fill("4")
    await page.locator(".triage-card__details summary").click()
    await page.locator("#triage-delay-impact").selectOption("critical")
    await page.locator('[data-action="triage-save"]').click()
    await expect.poll(() => pending).toBe(true)
    await page.locator('[data-action="close-triage"]').click()
    await expect(page.locator("#triage-overlay")).toBeHidden()
    const response = page.waitForResponse(response => response.url().endsWith(path) && response.request().method() === "GET")
    release()
    await (await response).finished()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(writes).toBe(0)
    const saved = await (await request.get(path)).json()
    const list = await (await request.get("/api/tasks")).json()
    expect(list.tasks.find((row: { id: string }) => row.id === task.id)).toMatchObject({ urgency: 0, importance: 0 })
    expect(JSON.parse(saved.framework_payload)).toEqual(scoring)
  } finally {
    release()
    await removeFixtureTask(request, path)
  }
})
