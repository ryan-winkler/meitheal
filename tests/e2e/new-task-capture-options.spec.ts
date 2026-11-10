import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

async function seedGoal(request: APIRequestContext, origin: string, title: string) {
  // The modal shows the assignment row when at least one user can be assigned.
  const headers = { origin }
  const user = await request.post("/api/users/custom", { headers, data: { name: title + " assignee" } })
  expect(user.status()).toBe(201)
  const goal = await request.post("/api/goals", { headers, data: { title } })
  expect(goal.status()).toBe(201)
  const { id }: { id: string } = await goal.json()
  return id
}

function watchOptions(page: Page) {
  const reads = { lanes: 0, backlog: 0, goals: 0 }
  page.on("request", request => {
    if (request.method() !== "GET") return
    const url = new URL(request.url())
    if (url.pathname === "/api/lanes") reads.lanes++
    if (url.pathname === "/api/settings" && url.searchParams.get("key") === "backlog_mode") reads.backlog++
    if (url.pathname === "/api/goals") reads.goals++
  })
  return reads
}

async function loadToday(page: Page) {
  await page.goto("/today")
  await expect(page.locator("#new-task-overlay")).toHaveAttribute("data-new-task-controller", "ready")
  await page.waitForLoadState("networkidle")
}

test("Today loads capture options once, when New Task opens", async ({ page, request, baseURL }) => {
  const goalId = await seedGoal(request, new URL(baseURL!).origin, "Capture options fixture")
  const reads = watchOptions(page)
  await loadToday(page)
  console.log("Today capture-option reads before open", JSON.stringify(reads))
  expect(reads).toEqual({ lanes: 0, backlog: 0, goals: 0 })

  const open = page.locator("#today-bar-new-task")
  const modal = page.locator("#new-task-overlay")
  const title = modal.locator("#new-task-title-input")
  const status = modal.locator("#new-task-status")
  const goals = modal.locator("#new-task-goal")
  const active = modal.locator('[data-status="active"]')
  await open.click()
  await expect(title).toBeFocused()
  await expect(modal.locator("#nt-ai-handoff")).toHaveCount(0)
  await expect(status).toHaveValue("pending")
  await expect(active).toBeVisible()
  await expect(goals.locator(`option[value="${goalId}"]`)).toHaveCount(1)
  console.log("Today capture-option reads after open", JSON.stringify(reads))
  expect(reads).toEqual({ lanes: 1, backlog: 1, goals: 1 })

  await active.click()
  await goals.selectOption(goalId)
  await modal.locator("#cancel-new-task").click()
  await expect(modal).toBeHidden()
  await open.click()
  await expect(title).toBeFocused()
  await expect(status).toHaveValue("pending")
  await expect(goals).toHaveValue("")
  expect(reads).toEqual({ lanes: 1, backlog: 1, goals: 1 })

  await title.fill("Deferred options capture fixture")
  await active.click()
  await goals.selectOption(goalId)
  let task: { id: string; goal_id: string } | undefined
  await page.route("**/api/tasks", async route => {
    if (route.request().method() !== "POST") return route.continue()
    const response = await route.fetch()
    if (response.status() === 201) task = await response.json()
    await route.fulfill({ response })
  })
  const [created] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/tasks"
      && response.request().method() === "POST"),
    modal.locator("#submit-new-task-btn").click(),
  ])
  expect(created.status()).toBe(201)
  expect(created.request().postDataJSON()).not.toHaveProperty("handoff_state")
  expect(task).toMatchObject({ id: expect.any(String), goal_id: goalId })
  const readback = await request.get(`/api/tasks/${task!.id}`)
  expect(readback.status()).toBe(200)
  expect(await readback.json()).toMatchObject({ title: "Deferred options capture fixture", status: "active" })
})

test("reopening retries failed and cancelled reads while keeping the task form usable", async ({ page, request, baseURL }) => {
  const goalId = await seedGoal(request, new URL(baseURL!).origin, "Retried goal fixture")

  let lanesAttempts = 0
  const releaseLanes = deferred<void>()
  await page.route("**/api/lanes", async route => {
    if (++lanesAttempts === 1) return route.fulfill({ status: 503 })
    await releaseLanes.promise
    return route.continue()
  })
  await page.route("**/api/settings?key=backlog_mode", route => route.fulfill({ json: { value: "hidden" } }))
  let goalsAttempts = 0
  const delayed = deferred<void>()
  const staleResponse = deferred<void>()
  await page.route("**/api/goals", async route => {
    if (++goalsAttempts !== 1) return route.continue()
    await delayed.promise
    await route.fulfill({ json: { goals: [{ id: "stale", title: "Stale goal" }] } }).catch(() => {})
    staleResponse.resolve()
  })

  await loadToday(page)
  const open = page.locator("#today-bar-new-task")
  const modal = page.locator("#new-task-overlay")
  const status = modal.locator("#new-task-status")
  const goals = modal.locator("#new-task-goal")
  const cancel = modal.locator("#cancel-new-task")
  try {
    const [failed] = await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/lanes"),
      open.click(),
    ])
    expect(failed.status()).toBe(503)
    await expect.poll(() => goalsAttempts).toBe(1)
    await expect(modal.getByRole("radiogroup", { name: "Task status" }).getByRole("radio")).toHaveCount(1)
    await expect(status).toHaveValue("pending")
    await expect(goals).toHaveValue("")
    await cancel.click()
    await expect(modal).toBeHidden()

    await open.click()
    await expect(modal.locator("#new-task-title-input")).toBeFocused()
    const pending = modal.locator('[data-status="pending"]')
    await pending.focus()
    releaseLanes.resolve()
    const active = modal.locator('[data-status="active"]')
    await expect(active).toBeVisible()
    await expect(pending).toBeFocused()
    await expect(modal.locator('[data-status="backlog"]')).toHaveCount(0)
    await expect(goals.locator(`option[value="${goalId}"]`)).toHaveCount(1)
    await active.click()
    await goals.selectOption(goalId)
    delayed.resolve()
    await staleResponse.promise
    await expect(goals.locator('option[value="stale"]')).toHaveCount(0)
    await expect(goals).toHaveValue(goalId)
    await expect(status).toHaveValue("active")
    expect(lanesAttempts).toBe(2)
    expect(goalsAttempts).toBe(2)
  } finally {
    releaseLanes.resolve()
    delayed.resolve()
  }
})
