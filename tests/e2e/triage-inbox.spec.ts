import { expect, test, type APIRequestContext } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
test.use({ serviceWorkers: "block" })

async function create(request: APIRequestContext, title: string, status = "backlog") {
  const response = await request.post("/api/tasks", { data: { title, status } })
  expect(response.status()).toBe(201)
  return await response.json() as { id: string; title: string; ticket_key: string }
}

async function setMode(request: APIRequestContext, value: unknown) {
  expect((await request.put("/api/settings", { data: { key: "backlog_mode", value } })).status()).toBe(200)
}

let previousMode: unknown
test.beforeEach(async ({ request }) => {
  previousMode = (await (await request.get("/api/settings")).json()).backlog_mode
  await setMode(request, "visible")
})
test.afterEach(async ({ request }) => { await setMode(request, previousMode ?? "visible") })

test("Planning opens the bounded queue and keyboard decisions preserve context", async ({ page, request }) => {
  const ids: string[] = []
  try {
    await setMode(request, "visible")
    for (let index = 0; index < 26; index++) {
      ids.push((await create(request, `Triage fixture ${index + 1}`)).id)
    }
    ids.push((await create(request, "Already accepted", "pending")).id)
    await page.goto("/planning#triage")
    const cards = page.locator("[data-triage-card]")
    await expect(cards).toHaveCount(25)
    await expect(page.locator("[data-triage-range]")).toHaveText("1–25 of 26")
    await expect(page.locator("[data-triage-count]")).toHaveText("26 tasks in Backlog")
    const details = cards.first().getByRole("link", { name: "Details" })
    await page.waitForFunction(() => typeof window.openTaskDetail === "function")
    await details.press("Enter")
    const detail = page.locator("#task-detail-overlay")
    await expect(detail).toHaveClass(/active/)
    await expect(detail).toHaveAttribute("data-open-task-id", ids[0]!)
    expect(await detail.getAttribute("data-task-id")).toBeNull()
    await page.keyboard.press("Escape")
    await expect(detail).not.toHaveClass(/active/)
    await expect(details).toBeFocused()

    await page.getByRole("link", { name: "Next" }).click()
    await expect(page).toHaveURL(/\/planning\?triagePage=2#triage$/)
    await expect(cards).toHaveCount(1)
    await expect(page.locator("[data-triage-range]")).toHaveText("26–26 of 26")
    const accepted = await cards.first().getAttribute("data-triage-card")
    await cards.first().getByRole("button", { name: "Accept to Todo" }).press("Enter")
    await expect(cards).toHaveCount(25)
    await expect(page.locator("#triage-heading")).toBeFocused()
    expect(await (await request.get(`/api/tasks/${accepted}`)).json()).toMatchObject({ status: "pending" })
    const first = await cards.first().getAttribute("data-triage-card")
    await cards.first().getByRole("button", { name: "Start now" }).press("Enter")
    await expect(cards).toHaveCount(24)
    await expect(cards.first().getByRole("link", { name: "Details" })).toBeFocused()
    expect(await (await request.get(`/api/tasks/${first}`)).json()).toMatchObject({ status: "active" })

    await page.goto("/tasks#kanban")
    const card = page.locator(`.kanban-card[data-id="${accepted}"]`)
    await card.locator(".card-more-btn").press("Enter")
    await page.getByRole("group", { name: "Task actions", exact: true }).getByRole("button", { name: "Backlog" }).press("Enter")
    await expect(page.locator('.kanban-column[data-status="backlog"]').locator(card)).toBeVisible()
    await page.goto("/triage")
    await expect(cards).toHaveCount(25)
    await expect(page.locator(`[data-triage-card="${accepted}"]`)).toBeVisible()
  } finally {
    for (const id of ids) expect((await request.delete(`/api/tasks/${id}`, { data: {} })).status()).toBe(204)
  }
})

test("hidden and invalid modes block URL opening and visible mode fits a small Irish viewport", async ({ page, request, context, baseURL }) => {
  const item = await create(request, "Long household repair " + "socket".repeat(65))
  const itemPath = `/api/tasks/${item.id}`
  let detailReads = 0
  page.on("request", http => {
    if (http.method() === "GET" && new URL(http.url()).pathname === itemPath) detailReads++
  })
  try {
    for (const [mode, expected] of [["hidden", "hidden"], ["disabled", "disabled"], [null, "unavailable"]] as const) {
      await setMode(request, mode)
      await page.goto(`/triage?open=${item.id}`)
      await expect(page.locator(`[data-triage-mode-message="${expected}"]`)).toBeVisible()
      await expect(page.locator("[data-triage-card]")).toHaveCount(0)
      await expect(page.locator("[data-triage-count]")).toHaveCount(0)
      await page.goto(`/triage#task-${item.id}`)
      await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
      expect(detailReads).toBe(0)
      await page.goto("/planning#triage")
      await expect(page.locator(`[data-triage-mode-message="${expected}"]`)).toBeVisible()
      await expect(page.locator("[data-triage-count]")).toHaveCount(0)
    }
    await setMode(request, "visible")
    await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
    await page.setViewportSize({ width: 320, height: 740 })
    await page.goto("/triage")
    await expect(page.getByRole("heading", { name: "Triáis" })).toBeVisible()
    const card = page.locator(`[data-triage-card="${item.id}"]`)
    await expect(card.getByRole("button", { name: "Tosaigh anois" })).toBeVisible()
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  } finally {
    await setMode(request, "visible")
    expect((await request.delete(itemPath, { data: {} })).status()).toBe(204)
  }
})

test("blocked, stale, and uncertain decisions retain the card and restore focus", async ({ page, request }) => {
  const item = await create(request, "Fit the replacement radiator")
  const prerequisite = await create(request, "Receive the radiator", "pending")
  const path = `/api/tasks/${item.id}`
  try {
    expect((await request.post(path + "/links", { data: { target_task_id: prerequisite.id, link_type: "blocked_by" } })).status()).toBe(201)
    await page.goto("/triage")
    const card = page.locator(`[data-triage-card="${item.id}"]`)
    const start = card.getByRole("button", { name: "Start now" })
    const status = page.locator("[data-triage-status]")
    await start.press("Enter")
    await expect(status).toContainText(prerequisite.ticket_key)
    await expect(start).toBeFocused()
    await expect(page.getByText("This task changed in another session. Reload to see the latest version.")).toHaveCount(0)

    await page.route(`**${path}`, route => route.request().method() === "PATCH" ? route.abort("failed") : route.continue())
    const accept = card.getByRole("button", { name: "Accept to Todo" })
    await accept.press("Enter")
    await expect(status).toContainText("check whether the decision saved")
    await expect(accept).toBeFocused()
    await expect(card).toBeVisible()
    await page.unroute(`**${path}`)

    expect((await request.patch(path, { data: { title: "Changed elsewhere" } })).status()).toBe(200)
    await accept.press("Enter")
    await expect(status).toContainText("This task changed")
    await expect(accept).toBeFocused()
    expect(await (await request.get(path)).json()).toMatchObject({ status: "backlog", title: "Changed elsewhere" })
  } finally {
    expect((await request.delete(path, { data: {} })).status()).toBe(204)
    expect((await request.delete(`/api/tasks/${prerequisite.id}`, { data: {} })).status()).toBe(204)
  }
})

function gate() {
  let resolve = () => {}
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

test("an acknowledgement during Details keeps the dialog and retires the accepted decision", async ({ page, request }) => {
  const first = await create(request, "Acknowledged intake")
  const second = await create(request, "Inspect another intake task")
  const path = `/api/tasks/${first.id}`
  const held = gate()
  const intercepted = gate()
  try {
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue()
      const saved = await route.fetch()
      intercepted.resolve()
      await held.promise
      await route.fulfill({ response: saved })
    })
    await page.goto("/triage")
    const firstCard = page.locator(`[data-triage-card="${first.id}"]`)
    await firstCard.getByRole("button", { name: "Accept to Todo" }).click()
    await intercepted.promise
    await page.locator(`[data-triage-card="${second.id}"]`).getByRole("link", { name: "Details" }).click()
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
    held.resolve()
    await expect(page.locator("[data-triage-status]")).toContainText("Decision saved")
    await expect(firstCard).not.toHaveAttribute("aria-busy", "true")
    await expect(firstCard.getByRole("button", { name: "Accept to Todo" })).toBeDisabled()
    await expect(page.locator("#task-detail-overlay")).toHaveClass(/active/)
    await page.keyboard.press("Escape")
    await expect(page.locator("#task-detail-overlay")).not.toHaveClass(/active/)
    await page.getByRole("link", { name: "Reload Triage" }).click()
    await expect(firstCard).toHaveCount(0)
  } finally {
    held.resolve()
    expect((await request.delete(path, { data: {} })).status()).toBe(204)
    expect((await request.delete(`/api/tasks/${second.id}`, { data: {} })).status()).toBe(204)
  }
})

test("a late acknowledgement leaves a changed location alone, and a restored page revalidates its mode", async ({ page, request }) => {
  const first = await create(request, "Intake before a location change")
  const second = await create(request, "Intake after a location change")
  const path = `/api/tasks/${first.id}`
  const held = gate()
  const intercepted = gate()
  try {
    await page.route(`**${path}`, async route => {
      if (route.request().method() !== "PATCH") return route.continue()
      const saved = await route.fetch()
      intercepted.resolve()
      await held.promise
      await route.fulfill({ response: saved })
    })
    await page.goto("/triage")
    const firstCard = page.locator(`[data-triage-card="${first.id}"]`)
    const firstAccept = firstCard.getByRole("button", { name: "Accept to Todo" })
    await firstAccept.click()
    await intercepted.promise
    await page.evaluate(() => { location.hash = "triage-heading" })
    held.resolve()
    await expect(firstCard).not.toHaveAttribute("aria-busy", "true")
    await expect(firstAccept).toBeDisabled()
    await expect(page).toHaveURL(/\/triage#triage-heading$/)
    await expect(page.locator("[data-triage-status]")).toBeHidden()
    await page.locator(`[data-triage-card="${second.id}"]`).getByRole("button", { name: "Start now" }).click()
    await expect(page.locator("[data-triage-empty]")).toBeVisible()
    expect(await (await request.get(`/api/tasks/${second.id}`)).json()).toMatchObject({ status: "active" })

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })))
    await expect(page.locator("[data-triage-count]")).toHaveCount(0)
    await setMode(request, "hidden")
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })))
    await expect(page.locator("[data-triage-mode-message=hidden]")).toBeVisible()
    await expect(page.locator("[data-triage-count]")).toHaveCount(0)
  } finally {
    held.resolve()
    await setMode(request, "visible")
    expect((await request.delete(path, { data: {} })).status()).toBe(204)
    expect((await request.delete(`/api/tasks/${second.id}`, { data: {} })).status()).toBe(204)
  }
})
