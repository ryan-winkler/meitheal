import { expect, test, type APIRequestContext } from "@playwright/test"

const useDev = process.env.MEITHEAL_DEFERRAL_DEV === "1"
test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1" && !useDev, "Needs an isolated Meitheal fixture")
test.use({
  locale: "en-IE",
  serviceWorkers: "block",
  hasTouch: true,
  ...(useDev && process.env.E2E_BASE_URL ? { extraHTTPHeaders: { origin: process.env.E2E_BASE_URL } } : {}),
})

async function seed(request: APIRequestContext, title: string, parentId?: string) {
  const response = await request.post("/api/tasks", { data: { title, status: "pending", parent_id: parentId } })
  expect(response.ok()).toBe(true)
  const task = await response.json() as { id: string; ticket_key: string }
  const detail = await request.get(`/api/tasks/${task.id}`)
  expect(detail.ok()).toBe(true)
  return { ...task, updated_at: Number((await detail.json()).task_version) }
}

async function defer(request: APIRequestContext, task: Awaited<ReturnType<typeof seed>>) {
  const response = await request.patch(`/api/tasks/${task.id}/deferral`, {
    data: { deferred: true, updated_at: task.updated_at, deferral_revision: null },
  })
  expect(response.ok()).toBe(true)
}

test("keyboard Defer removes a board card and keyboard Resume brings it back", async ({ page, request }) => {
  const sibling = await seed(request, "Board deferral neighbor")
  const task = await seed(request, "Board keyboard deferral")
  await page.goto("/tasks")
  const card = page.locator(`.kanban-card[data-id="${task.id}"]`)
  await expect(card).toBeVisible()
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

test("Details keeps session reconciliation across a linked task and terminal states", async ({ page, request }) => {
  const parent = await seed(request, "Deferral linked parent")
  const child = await seed(request, "Deferral linked child", parent.id)
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

test("the queue renders 25 rows and clamps after resuming the final row", async ({ page, request }) => {
  test.setTimeout(45_000)
  const entries = []
  for (let index = 0; index < 26; index++) {
    const task = await seed(request, `Deferral pagination ${index}`)
    await defer(request, task)
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
  for (const task of entries) await request.delete(`/api/tasks/${task.id}`, { data: {} })
})

test("a stale Resume offers a fresh read and only retries on a new decision", async ({ page, request }) => {
  const task = await seed(request, "DeferralStaleResume".repeat(22))
  await defer(request, task)
  await page.setViewportSize({ width: 320, height: 740 })
  let attempts = 0
  page.on("request", candidate => {
    if (candidate.method() === "PATCH" && new URL(candidate.url()).pathname === `/api/tasks/${task.id}/deferral`) attempts++
  })
  await page.goto("/deferred")
  const card = page.locator(`[data-deferred-card="${task.id}"]`)
  await expect(card).toBeVisible()
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect((await request.put(`/api/tasks/${task.id}`, { data: { title: "Edited elsewhere" } })).ok()).toBe(true)
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

test("deferred rows remain visible in Table and a terminal status clears the badge", async ({ page, request }) => {
  const task = await seed(request, "Deferral retained Table row")
  await defer(request, task)
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
