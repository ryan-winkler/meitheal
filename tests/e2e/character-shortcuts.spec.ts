import { expect, test, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

const settingsPath = "/settings#personal-settings"
const timelinePath = "/tasks?view=timeline#timeline"

function preference(page: Page) {
  return page.getByRole("checkbox", { name: "Enable letter, number and symbol shortcuts on this device" })
}

async function openSettings(page: Page) {
  await page.goto(settingsPath)
  await expect(preference(page)).toBeVisible()
}

async function blurActive(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

test("the Settings preference persists and preserves search with a modifier or a button", async ({ page, context }) => {
  await openSettings(page)
  const enabled = preference(page)
  const search = page.locator("#settings-bar-search-launcher")
  const hub = page.locator("#search-hub-overlay")
  const shortcuts = page.locator("#shortcut-modal")
  await expect(enabled).toBeChecked()
  await expect(search).toHaveAttribute("aria-keyshortcuts", "/")
  await enabled.press("Space")
  await expect(enabled).not.toBeChecked()
  await expect(search).not.toHaveAttribute("aria-keyshortcuts")
  await expect(search.locator("kbd")).toBeHidden()

  const otherTab = await context.newPage()
  await openSettings(otherTab)
  await expect(preference(otherTab)).not.toBeChecked()
  await page.bringToFront()
  await page.reload()
  await expect(enabled).not.toBeChecked()
  await blurActive(page)
  await page.keyboard.press("/")
  await page.keyboard.press("Shift+Slash")
  await page.keyboard.press("y")
  await expect(hub).toBeHidden()
  await expect(shortcuts).toBeHidden()
  await expect(page).toHaveURL(/\/settings#personal-settings$/)

  await page.keyboard.press("Control+k")
  await expect(page.locator("#search-hub-input")).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(hub).toBeHidden()
  await expect(page.locator("#search-hub-input")).not.toBeFocused()
  const sidebarCollapsed = await page.locator("body").evaluate(body => body.classList.contains("sidebar-collapsed"))
  await page.keyboard.press("Control+b")
  await expect.poll(() => page.locator("body").evaluate(body => body.classList.contains("sidebar-collapsed"))).toBe(!sidebarCollapsed)
  await search.press("Enter")
  await expect(hub).toBeVisible()
  await page.keyboard.press("Escape")

  await enabled.check()
  await expect(search).toHaveAttribute("aria-keyshortcuts", "/")
  await expect(preference(otherTab)).toBeChecked()
  await blurActive(page)
  await page.keyboard.press("/")
  await expect(hub).toBeVisible()
  await page.keyboard.press("Escape")
  await blurActive(page)
  await page.keyboard.press("Shift+Slash")
  await expect(shortcuts).toBeVisible()
})

test("disabling shortcuts covers sidebar capture, the Kanban board, task details and numeric Tasks views", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const project = await request.post("/api/projects", { headers, data: { title: "Shortcut fixture project" } })
  expect(project.status()).toBe(201)
  const { id: projectId } = await project.json()
  let id: string | undefined
  try {
    const task = await request.post("/api/tasks", { headers, data: { title: "Shortcut fixture board task", project_id: projectId } })
    expect(task.status()).toBe(201)
    id = (await task.json()).id

    await openSettings(page)
    await preference(page).uncheck()
    await page.goto("/tasks?view=kanban#kanban")
    const card = page.locator(`[data-task-id="${id}"] .card-open-btn`)
    const detail = page.locator("#task-detail-overlay")
    await expect(card).toBeVisible()
    await card.press("n")
    await expect(page.locator(".kanban-inline-add")).toHaveCount(0)
    await expect(page.locator("#task-kind-dropdown")).toBeHidden()
    await expect(page.locator("#new-task-overlay")).toBeHidden()
    await card.press("4")
    await expect(page).toHaveURL(/#kanban$/)
    await card.press("Enter")
    await expect(detail).toBeVisible()
    await expect(page.locator("#td-assigned-to")).toBeVisible()
    await page.locator("#td-close").press("a")
    await expect(page.locator("#td-close")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(detail).toBeHidden()
    await expect(card).toBeFocused()

    await openSettings(page)
    await preference(page).check()
    await page.goto("/tasks?view=kanban#kanban")
    await card.press("Enter")
    await expect(detail).toBeVisible()
    await expect(page.locator("#td-assigned-to")).toBeVisible()
    await page.locator("#td-close").press("a")
    await expect(page.locator("#td-assigned-to")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(detail).toBeHidden()
    await card.press("4")
    await expect(page).toHaveURL(/view=timeline#timeline$/)
  } finally {
    if (id) await request.delete(`/api/tasks/${id}`, { headers })
    await request.delete(`/api/projects/${projectId}`, { headers })
  }
})

test("Today and Timeline keep arrows and Enter while letter and punctuation shortcuts are off", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const now = Date.now()
  const ids: string[] = []
  try {
    for (const suffix of ["one", "two"]) {
      const task = await request.post("/api/tasks", { headers, data: {
        title: `Shortcut dated task ${suffix}`,
        start_date: new Date(now - 86400000).toISOString(),
        due_date: new Date(now).toISOString().slice(0, 10),
      } })
      expect(task.status()).toBe(201)
      ids.push((await task.json()).id)
    }
    await openSettings(page)
    await preference(page).uncheck()

    await page.goto("/today")
    const rows = page.locator(`.tli:is([data-id="${ids[0]}"], [data-id="${ids[1]}"])`)
    await expect(rows.first()).toBeVisible()
    await rows.first().focus()
    await page.keyboard.press("j")
    await expect(page.locator(".tli--focused")).toHaveCount(0)
    await page.keyboard.press("ArrowDown")
    await expect(page.locator(".tli--focused")).toHaveCount(1)
    await page.keyboard.press("e")
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
    await page.keyboard.press("Enter")
    await expect(page.locator("#task-detail-overlay")).toBeVisible()

    await page.goto(timelinePath)
    const bars = page.locator(`.gantt-bar:is([data-task-id="${ids[0]}"], [data-task-id="${ids[1]}"])`)
    await expect(bars).toHaveCount(2)
    await blurActive(page)
    await page.keyboard.press("j")
    await expect(bars.first()).not.toBeFocused()
    await expect(bars.last()).not.toBeFocused()
    await page.keyboard.press("ArrowDown")
    await expect(bars.first()).toBeFocused()
    const zoom = page.locator("#timeline-zoom-dropdown summary")
    const originalZoom = await zoom.textContent()
    await page.keyboard.press("=")
    await expect(zoom).toHaveText(originalZoom ?? "")
    await page.keyboard.press("-")
    await expect(zoom).toHaveText(originalZoom ?? "")
    await page.keyboard.press("ArrowDown")
    await expect(bars.last()).toBeFocused()
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})
