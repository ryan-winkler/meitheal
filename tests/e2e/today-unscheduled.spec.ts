import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test("pages a large unscheduled queue and filters across every page", async ({ page, request, baseURL }) => {
  test.skip(shouldSkipBrowserSpecs(), "Requires a disposable Meitheal server")
  const origin = new URL(baseURL!).origin
  const headers = { origin }
  const prefix = `Unscheduled fixture ${crypto.randomUUID()}`
  const target = `${prefix} beyond the first page`
  const ids: string[] = []

  try {
    for (let row = 0; row < 52; row++) {
      const result = await request.post("/api/tasks", {
        headers,
        data: { title: row === 0 ? target : `${prefix} row ${row}`, priority: row === 0 ? 5 : 1 },
      })
      expect(result.status(), await result.text()).toBe(201)
      ids.push((await result.json()).id)
    }

    const initial = await page.goto(`/today?search=${encodeURIComponent(prefix)}#today-work`)
    expect(await initial?.text()).not.toContain(target)
    const due = page.getByRole("button", { name: /^Due Today \d+$/ })
    const dueList = page.locator("#today-due-list")
    await expect(due).toHaveAttribute("aria-controls", "today-due-list")
    await due.getByText("Due Today").click()
    await expect(due).toHaveAttribute("aria-expanded", "false")
    await expect(dueList).toHaveAttribute("inert", "")
    await page.reload()
    await expect(due).toHaveAttribute("aria-expanded", "false")
    await expect(dueList).toHaveAttribute("inert", "")
    await due.press("Enter")
    await expect(due).toHaveAttribute("aria-expanded", "true")
    await expect(dueList).not.toHaveAttribute("inert", "")

    const section = page.locator("#section-unscheduled")
    const toggle = section.getByRole("button", { name: /^Unscheduled \d+$/ })
    const range = section.locator("[data-unscheduled-range]")
    const rows = section.locator(".tli")
    await expect(page.locator("#batch-mode-toggle")).toBeAttached()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(rows).toHaveCount(0)
    await toggle.getByText("Unscheduled").click()

    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(range).toHaveText("Showing 1–50 of 52")
    await expect(rows).toHaveCount(50)
    await expect(section.getByText(target, { exact: true })).toHaveCount(0)
    await section.getByRole("link", { name: "Next" }).press("Enter")
    await expect(range).toHaveText("Showing 51–52 of 52")
    await expect(range).toBeFocused()
    await expect(rows).toHaveCount(2)
    await expect(page).toHaveURL(/unscheduledPage=2/)
    await page.reload()
    await expect(range).toHaveText("Showing 51–52 of 52")

    await section.getByRole("link", { name: "Previous" }).click()
    await expect(range).toHaveText("Showing 1–50 of 52")
    await page.locator('[data-unified-bar-section="today-focus"]').click()
    await page.locator("#today-search").fill(target)
    await page.locator('[data-unified-bar-section="today-work"]').click()
    await expect(range).toHaveText("Showing 1–1 of 1")
    await expect(rows).toHaveCount(1)
    await rows.first().getByRole("link", { name: target, exact: true }).press("Enter")
    await expect(page.locator("#td-title")).toHaveValue(target)
    await page.keyboard.press("Escape")

    await page.locator('[data-unified-bar-section="today-focus"]').click()
    await page.locator("#today-search").fill(prefix)
    await page.locator("#today-sort").selectOption("priority-desc")
    await page.locator('[data-unified-bar-section="today-work"]').click()
    await expect(range).toHaveText("Showing 1–50 of 52")
    await expect(rows.first()).toContainText(target)
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(page).not.toHaveURL(/unscheduledPage=/)
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})

test("a status refresh preserves focus on another Unscheduled row", async ({ page, request, baseURL }) => {
  test.skip(shouldSkipBrowserSpecs(), "Requires a disposable Meitheal server")
  const headers = { origin: new URL(baseURL!).origin }
  const prefix = `Unscheduled focus ${crypto.randomUUID()}`
  const ids: string[] = []
  let release: (() => void) | undefined
  try {
    for (const title of [`${prefix} first`, `${prefix} second`]) {
      const response = await request.post("/api/tasks", { headers, data: { title } })
      expect(response.status(), await response.text()).toBe(201)
      ids.push((await response.json()).id)
    }
    await page.route(`**/api/tasks/${ids[0]}`, async route => {
      if (route.request().method() === "PUT") await new Promise<void>(resolve => { release = resolve })
      await route.continue()
    })
    await page.goto(`/today?search=${encodeURIComponent(prefix)}&unscheduledPage=1#today-work`)
    const list = page.locator("#today-unscheduled-list")
    const first = list.locator(`.tli[data-id="${ids[0]}"]`)
    const next = list.locator(`.tli[data-id="${ids[1]}"] .tli__checkbox`)
    await first.locator(".tli__checkbox").press("Space")
    await expect.poll(() => Boolean(release)).toBe(true)
    await next.focus()
    release?.()
    await expect(first).toHaveCount(0)
    await expect(next).toBeFocused()
  } finally {
    release?.()
    for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
  }
})
