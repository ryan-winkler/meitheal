import { expect, test as base, type APIRequestContext } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

const test = base.extend<{ boardHeaders: Record<string, string> }>({
  boardHeaders: async ({ request, baseURL }, use) => {
    await use(await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin }))
  },
})

const useDev = process.env.MEITHEAL_DEFERRAL_DEV === "1"
test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1" && !useDev, "Needs an isolated Meitheal fixture")
test.use({
  locale: "en-IE",
  serviceWorkers: "block",
  hasTouch: true,
  ...(useDev && process.env.E2E_BASE_URL ? { extraHTTPHeaders: { origin: process.env.E2E_BASE_URL } } : {}),
})

async function seed(request: APIRequestContext, headers: Record<string, string>, title: string, parentId?: string, areaId?: string) {
  const response = await request.post("/api/tasks", { headers, data: { title, status: "pending", parent_id: parentId, area_id: areaId } })
  expect(response.ok(), await response.text()).toBe(true)
  const task = await response.json() as { id: string; ticket_key: string }
  const detail = await request.get(`/api/tasks/${task.id}`)
  expect(detail.ok()).toBe(true)
  return { ...task, updated_at: Number((await detail.json()).task_version) }
}

async function defer(request: APIRequestContext, headers: Record<string, string>, task: Awaited<ReturnType<typeof seed>>) {
  const response = await request.patch(`/api/tasks/${task.id}/deferral`, {
    headers, data: { deferred: true, updated_at: task.updated_at, deferral_revision: null },
  })
  expect(response.ok(), await response.text()).toBe(true)
}

test("keyboard Defer removes a board card and keyboard Resume brings it back", async ({ page, request, boardHeaders }) => {
  const sibling = await seed(request, boardHeaders, "Board deferral neighbor")
  const task = await seed(request, boardHeaders, "Board keyboard deferral")
  await page.goto("/tasks")
  const card = page.locator(`.kanban-card[data-id="${task.id}"]`)
  await expect(card).toBeVisible()
  await expect(page.locator("#kanban-card-menu")).toBeAttached()
  await card.locator(".card-more-btn").press("Enter")
  await page.locator("#kanban-card-menu").getByRole("button", { name: "Defer", exact: true }).press("Enter")
  await expect(card).toHaveCount(0)
  await expect(page.locator(`.kanban-card[data-id="${sibling.id}"] .card-more-btn`)).toBeFocused()

  await page.getByRole("link", { name: "Deferred", exact: true }).click()
  const row = page.locator(`[data-deferred-card="${task.id}"]`)
  await expect(row).toBeVisible()
  const neighbor = await row.evaluate(card => {
    const sibling = (card.nextElementSibling ?? card.previousElementSibling) as HTMLElement | null
    return sibling?.dataset.deferredCard
  })
  await row.getByRole("button", { name: "Resume", exact: true }).press("Enter")
  await expect(row).toHaveCount(0)
  await expect(page.locator(neighbor ? `[data-deferred-card="${neighbor}"] [data-deferred-details]` : "#deferred-heading")).toBeFocused()
  await page.getByRole("link", { name: "Back to Tasks" }).click()
  await expect(card).toBeVisible()
})

test("Details keeps session reconciliation across a linked task and terminal states", async ({ page, request, boardHeaders }) => {
  const parent = await seed(request, boardHeaders, "Deferral linked parent")
  const child = await seed(request, boardHeaders, "Deferral linked child", parent.id)
  await page.goto(`/tasks?open=${child.ticket_key}`)
  const modal = page.locator("#task-detail-overlay")
  const action = modal.locator("#td-deferral-action")
  await expect(action).toHaveText("Defer")
  await action.click()
  await expect(modal.locator("#td-deferred-badge")).toBeVisible()
  await modal.locator("#td-parent").click()
  await expect(modal.locator("#td-title")).toHaveValue("Deferral linked parent")
  await modal.locator("#td-close").click()
  await expect(page.locator(`.kanban-card[data-id="${child.id}"]`)).toHaveCount(0)

  await page.goto(`/deferred?open=${child.id}`)
  await expect(action).toHaveText("Resume")
  await expect(modal.locator("#td-deferred-badge")).toBeVisible()
  await modal.locator("#td-status").selectOption("complete")
  await expect(modal.locator("#td-deferred-badge")).toBeHidden()
  await expect(action).toBeHidden()
  await modal.locator("#td-status").selectOption("pending")
  await expect(action).toHaveText("Defer")
  await expect(action).toBeVisible()
  await modal.locator("#td-close").click()
  await expect(page.locator(`[data-deferred-card="${child.id}"]`)).toHaveCount(0)
  await expect(page.locator("#deferred-heading")).toBeFocused()
})

test("the queue renders 25 rows and clamps after resuming the final row", async ({ page, request, boardHeaders }) => {
  test.setTimeout(45_000)
  const entries = []
  for (let index = 0; index < 26; index++) {
    const task = await seed(request, boardHeaders, `Deferral pagination ${index}`)
    await defer(request, boardHeaders, task)
    entries.push(task)
  }
  await page.goto("/deferred")
  await expect(page.locator("[data-deferred-card]")).toHaveCount(25)
  await page.getByRole("link", { name: "Next", exact: true }).click()
  const final = page.locator("[data-deferred-card]")
  await expect(final).toHaveCount(1)
  await final.getByRole("button", { name: "Resume", exact: true }).click()
  await expect(page.locator("[data-deferred-card]")).toHaveCount(25)
  await expect(page).not.toHaveURL(/page=/)
  await expect(page.locator("#deferred-heading")).toBeFocused()
  for (const task of entries) await request.delete(`/api/tasks/${task.id}`, { headers: boardHeaders, data: {} })
})

test("a stale Resume offers a fresh read and only retries on a new decision", async ({ page, request, boardHeaders }) => {
  const task = await seed(request, boardHeaders, "DeferralStaleResume".repeat(22))
  await defer(request, boardHeaders, task)
  await page.setViewportSize({ width: 320, height: 740 })
  let attempts = 0
  page.on("request", candidate => {
    if (candidate.method() === "PATCH" && new URL(candidate.url()).pathname === `/api/tasks/${task.id}/deferral`) attempts++
  })
  await page.goto("/deferred")
  const card = page.locator(`[data-deferred-card="${task.id}"]`)
  await expect(card).toBeVisible()
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await request.put(`/api/tasks/${task.id}`, { headers: boardHeaders, data: { title: "Edited elsewhere" } })).ok()).toBe(true)
  await card.getByRole("button", { name: "Resume", exact: true }).tap()
  const reload = page.getByRole("link", { name: "Reload Deferred", exact: true })
  await expect(reload).toBeFocused()
  await expect(card.getByRole("button", { name: "Resume", exact: true })).toBeDisabled()
  await reload.press("Enter")
  await expect(card.getByRole("heading", { name: "Edited elsewhere" })).toBeVisible()
  expect(attempts).toBe(1)
  await card.getByRole("button", { name: "Resume", exact: true }).tap()
  await expect(card).toHaveCount(0)
  expect(attempts).toBe(2)
})

test("deferred rows remain visible in Table and a terminal status clears the badge", async ({ page, request, boardHeaders }) => {
  const task = await seed(request, boardHeaders, "Deferral retained Table row")
  await defer(request, boardHeaders, task)
  await page.goto("/tasks?view=table#table")
  const row = page.locator(`.table-row[data-id="${task.id}"]`)
  const badge = row.locator("[data-table-deferred]")
  await expect(badge).toBeVisible()
  await row.locator('select[data-field="status"]').selectOption("complete")
  await expect(badge).toBeHidden()
  await expect(row).toHaveAttribute("data-status", "complete")
  await row.locator('select[data-field="status"]').selectOption("pending")
  await expect(row).toHaveAttribute("data-status", "pending")
  await expect(badge).toBeHidden()
})

test("Deferred preserves the Board Area and can widen to all Areas", async ({ page, request, boardHeaders }) => {
  const area = await request.post("/api/areas", { headers: boardHeaders, data: { name: "Deferred Area" } })
  expect(area.status()).toBe(201)
  const { id: areaId } = await area.json()
  const local = await seed(request, boardHeaders, "Deferred in selected area", undefined, areaId)
  const elsewhere = await seed(request, boardHeaders, "Deferred in another area")
  await defer(request, boardHeaders, local)
  await defer(request, boardHeaders, elsewhere)

  await page.goto(`/tasks?area=${areaId}#kanban`)
  await page.getByRole("link", { name: "Deferred", exact: true }).click()
  const areaFilter = page.getByRole("combobox", { name: "Area", exact: true })
  await expect(areaFilter).toHaveValue(areaId)
  await expect(page.locator(`[data-deferred-card="${local.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-deferred-card="${elsewhere.id}"]`)).toHaveCount(0)
  await expect(page.locator("[data-deferred-count]")).toContainText("1 deferred task")
  await expect(page.getByRole("link", { name: "Back to Tasks" })).toHaveAttribute("href", `/tasks?area=${areaId}#kanban`)
  await expect(page.getByRole("link", { name: "Reload Deferred" })).toBeHidden()

  await areaFilter.selectOption({ label: "All areas" })
  await page.getByRole("button", { name: "Apply area" }).click()
  await expect(areaFilter).toHaveValue("")
  await expect(page.locator(`[data-deferred-card="${elsewhere.id}"]`)).toBeVisible()
  await expect(page.locator(`[data-deferred-card="${local.id}"]`)).toBeVisible()
  await page.getByRole("link", { name: "Back to Tasks" }).click()
  await expect(page).toHaveURL(/\/tasks\?area=#kanban$/)

  for (const task of [local, elsewhere]) await request.delete(`/api/tasks/${task.id}`, { headers: boardHeaders, data: {} })
})

test("a missing Deferred Area stays visible on the Board until the user widens it", async ({ page, request, boardHeaders }) => {
  const id = crypto.randomUUID()
  const task = await seed(request, boardHeaders, "Recover an open task")
  try {
    await page.goto(`/deferred?area=${id}`)
    const area = page.getByRole("combobox", { name: "Area", exact: true })
    await expect(area).toHaveValue(id)
    await page.getByRole("link", { name: "Back to Tasks" }).click()
    const trigger = page.locator("#area-selector-trigger")
    await expect(trigger).toContainText("Area unavailable")
    const add = page.getByRole("button", { name: "Add task to Backlog" })
    await add.click()
    await expect(page.getByRole("alert")).toContainText("Choose an available Area or All Areas before adding a task.")
    await expect(trigger).toBeFocused()
    await expect(page.locator(".kanban-inline-add")).toHaveCount(0)
    await expect(page).toHaveURL(url => url.searchParams.get("area") === id)
    const card = page.locator(`.kanban-card[data-id="${task.id}"]`)
    await expect(card).toHaveCount(0)
    await page.getByRole("textbox", { name: "Filter by text" }).fill("Recover")
    await expect(page).toHaveURL(url => url.searchParams.get("area") === id && url.searchParams.get("search") === "Recover")
    await expect(card).toHaveCount(0)
    await trigger.click()
    await page.locator('#area-selector-dropdown [data-area-id=""]').click()
    await expect(trigger).toContainText("All Areas")
    await expect(page).toHaveURL(url => url.searchParams.get("area") === "")
    await expect(card).toBeVisible()
    await add.click()
    await expect(page.getByRole("textbox", { name: "New task title" })).toBeVisible()
  } finally {
    await request.delete(`/api/tasks/${task.id}`, { headers: boardHeaders, data: {} })
  }
})
