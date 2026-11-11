import { expect, test, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

const settingsPath = "/settings#personal-settings"
function timelinePath(search: string) {
  return `/tasks?${new URLSearchParams({ view: "timeline", search })}#timeline`
}

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
  await page.keyboard.press("k")
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

test("K selects Kanban after Table and the numbered keys select each Tasks view", async ({ page }) => {
  await page.goto("/tasks?view=table#table")
  const view = page.locator("[data-task-view]")
  const switcher = page.locator("[data-view-tabs]")
  await expect(view).toHaveAttribute("data-task-view", "table")
  await expect(switcher).toHaveAttribute("data-switcher-ready", "true")

  await page.keyboard.press("k")
  await expect(page).toHaveURL(/\/tasks#kanban$/)
  await expect(view).toHaveAttribute("data-task-view", "kanban")
  await expect(switcher).toHaveAttribute("data-switcher-ready", "true")

  for (const [key, destination] of [["2", "table"], ["3", "calendar"], ["4", "timeline"], ["1", "kanban"]] as const) {
    await page.keyboard.press(key)
    await expect(view).toHaveCount(1)
    await expect(view).toHaveAttribute("data-task-view", destination)
    await expect(switcher).toHaveAttribute("data-switcher-ready", "true")
  }
})

test("shortcut help contains focus and restores its opener after Escape and after an Astro page swap", async ({ page }) => {
  await page.goto("/tasks#kanban")
  const kanban = page.locator("[data-view-tab=kanban]")
  const table = page.locator("[data-view-tab=table]")
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  const close = dialog.getByRole("button", { name: "Close shortcuts" })
  const viewHelp = dialog.getByRole("heading", { name: "On the Tasks page" })
  await expect(page.locator("[data-view-tabs]")).toHaveAttribute("data-switcher-ready", "true")

  await kanban.press("Shift+Slash")
  await expect(close).toBeFocused()
  await expect(dialog.locator("kbd").filter({ hasText: /^[1-4]$/ })).toHaveText(["1", "2", "3", "4"])
  await expect(dialog.locator("h4 ~ span")).toHaveText(["Kanban view", "Table view", "Calendar view", "Timeline view"])
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(close).toBeFocused()
  await viewHelp.click()
  await expect(close).toBeFocused()
  await close.blur()
  await page.keyboard.press("2")
  await expect(page).toHaveURL(/\/tasks#kanban$/)
  await page.keyboard.press("Tab")
  await expect(close).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
  await expect(kanban).toBeFocused()

  await page.evaluate(() => {
    document.addEventListener("astro:after-swap", () => { document.body.dataset.shortcutTestSwapped = "true" }, { once: true })
  })
  await table.click()
  await expect(page.locator("body")).toHaveAttribute("data-shortcut-test-swapped", "true")
  await expect(page.locator("[data-view-tabs]")).toHaveAttribute("data-switcher-ready", "true")
  await table.press("Shift+Slash")
  await expect(close).toBeFocused()
  await viewHelp.click()
  await page.keyboard.press("k")
  await expect(page).toHaveURL(/\/tasks\?view=table#table$/)
  await page.keyboard.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(table).toBeFocused()

  await table.press("Shift+Slash")
  await expect(close).toBeFocused()
  await page.mouse.move(8, 8)
  await page.mouse.down()
  try {
    await expect(close).toBeFocused()
  } finally {
    await page.mouse.up()
  }
  await expect(dialog).toBeHidden()
  await expect(table).toBeFocused()
})

test("shortcut help waits until the native Settings wizard is closed", async ({ page }) => {
  await page.goto("/settings#rules-lenses-settings")
  const launcher = page.locator("#fw-create-btn")
  const wizard = page.locator("#framework-wizard-dialog")
  const wizardClose = wizard.getByRole("button", { name: "Close", exact: true })
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })

  await launcher.click()
  await expect(wizard).toBeVisible()
  await wizardClose.press("Shift+Slash")
  await expect(wizardClose).toBeFocused()
  await expect(help).toBeHidden()

  await wizardClose.click()
  await launcher.press("Shift+Slash")
  await expect(help.getByRole("button", { name: "Close shortcuts" })).toBeFocused()
})

test("shortcut help waits until the narrow Table columns popover is closed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 650 })
  await page.goto("/tasks?view=table#table")
  const launcher = page.getByRole("button", { name: "Customize visible columns" })
  const panel = page.locator("#column-customizer-panel:popover-open")
  const close = panel.getByRole("button", { name: "Close panel" })
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })

  await launcher.click()
  await expect(panel).toBeVisible()
  await close.press("Shift+Slash")
  await expect(close).toBeFocused()
  await expect(help).toBeHidden()
  await page.keyboard.press("k")
  await expect(close).toBeFocused()
  await expect(page).toHaveURL(/\/tasks\?view=table#table$/)

  await close.click()
  await launcher.press("Shift+Slash")
  await expect(help.getByRole("button", { name: "Close shortcuts" })).toBeFocused()
})

test("shortcut help waits for the Planning prompt to close", async ({ page }) => {
  await page.goto("/planning#spaces")
  await page.locator("#create-area-btn").click()
  const prompt = page.getByRole("dialog", { name: "Create Area" })
  const cancel = prompt.getByRole("button", { name: "Cancel" })
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })

  await expect(prompt.locator("#prompt-input")).toBeFocused()
  await cancel.press("Shift+Slash")
  await expect(cancel).toBeFocused()
  await expect(help).toBeHidden()
  await page.keyboard.press("k")
  await expect(cancel).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(prompt).toBeHidden()
  await expect(page).toHaveURL(/\/planning#spaces$/)
})

test("the numbered shortcut labels remain reachable in Irish on a short screen", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
  await page.setViewportSize({ width: 320, height: 300 })
  await page.goto("/tasks#kanban")
  await expect(page.locator("[data-view-tabs]")).toHaveAttribute("data-switcher-ready", "true")
  await page.keyboard.press("?")
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  const close = dialog.getByRole("button", { name: "Close shortcuts" })
  const panel = dialog.locator(".shortcut-modal-content")
  await expect(close).toBeFocused()
  await expect(dialog.getByRole("heading", { name: "Ar leathanach na dtascanna" })).toBeVisible()
  const bounds = await panel.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + 5, bounds!.y + 5)
  await page.mouse.down()
  try {
    await expect(close).toBeFocused()
  } finally {
    await page.mouse.up()
  }
  const timeline = dialog.getByText("Amharc amlíne")
  await expect(timeline).not.toBeInViewport()
  await page.keyboard.press("End")
  await expect(timeline).toBeInViewport()
  await page.keyboard.press("Home")
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(0)
  await expect(timeline).not.toBeInViewport()
  await panel.hover()
  await page.mouse.wheel(0, 500)
  await expect(timeline).toBeInViewport()
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
    const detailClose = page.locator("#td-close")
    await detailClose.press("Shift+Slash")
    const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })
    const helpClose = help.getByRole("button", { name: "Close shortcuts" })
    await expect(helpClose).toBeFocused()
    await helpClose.click()
    await expect(help).toBeHidden()
    await expect(detail).toBeVisible()
    await expect(detailClose).toBeFocused()
    await expect(page.locator("#td-assigned-to")).toBeVisible()
    await detailClose.press("a")
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

const datedShortcutTest = test.extend<{ datedTasks: { ids: string[]; query: string } }>({
  datedTasks: async ({ request, baseURL }, use) => {
    const headers = { origin: new URL(baseURL!).origin }
    const now = Date.now()
    const query = `shortcut dated task ${crypto.randomUUID()}`
    const ids: string[] = []
    try {
      for (const suffix of ["one", "two"]) {
        const task = await request.post("/api/tasks", { headers, data: {
          title: `${query} ${suffix}`,
          start_date: new Date(now - 86400000).toISOString(),
          due_date: new Date(now).toISOString().slice(0, 10),
        } })
        expect(task.status()).toBe(201)
        ids.push((await task.json()).id)
      }
      await use({ ids, query })
    } finally {
      for (const id of ids) await request.delete(`/api/tasks/${id}`, { headers })
    }
  },
})

datedShortcutTest("Timeline keeps contextual K after a zoom rerender", async ({ page, datedTasks }) => {
  const path = timelinePath(datedTasks.query)
  await page.goto(path)
  const bars = page.locator(".gantt-bar")
  await expect(bars).toHaveCount(2)
  const zoom = page.locator("#timeline-zoom-dropdown")
  await zoom.locator("summary").click()
  await zoom.getByRole("button", { name: "Month", exact: true }).click()
  await expect(page.locator("#timeline-zoom-label")).toHaveText("Month")
  await expect(bars).toHaveCount(2)
  await blurActive(page)

  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await expect(bars.last()).toBeFocused()
  await page.keyboard.press("k")
  await expect(bars.first()).toBeFocused()
  await expect(page).toHaveURL(path)
})

datedShortcutTest("shortcut help covers the Timeline popup and restores its action", async ({ page, datedTasks }) => {
  await page.goto(timelinePath(datedTasks.query))
  const bar = page.locator(`.gantt-bar[data-task-id="${datedTasks.ids[0]}"]`)
  await bar.press("Enter")
  const details = page.locator(".gantt-popup").getByRole("button", { name: /View Details/ })
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" })
  const close = help.getByRole("button", { name: "Close shortcuts" })

  await details.press("Shift+Slash")
  await expect(close).toBeFocused()
  await expect.poll(() => details.evaluate(button => {
    const { x, y, width, height } = button.getBoundingClientRect()
    const target = document.elementFromPoint(x + width / 2, y + height / 2)
    return Boolean(target?.closest("#shortcut-modal"))
  })).toBe(true)
  await page.keyboard.press("Escape")
  await expect(help).toBeHidden()
  await expect(details).toBeFocused()

  await details.press("Shift+Slash")
  await close.click()
  await expect(help).toBeHidden()
  await expect(details).toBeFocused()
  await details.press("Enter")
  await expect(page.locator("#task-detail-overlay")).toBeVisible()
})

datedShortcutTest("Today keeps contextual K after an Astro page swap", async ({ page, datedTasks }) => {
  await openSettings(page)
  await expect(preference(page)).toBeChecked()
  await page.evaluate(() => {
    document.addEventListener("astro:after-swap", () => { document.body.dataset.todayShortcutSwapped = "true" }, { once: true })
  })
  await page.locator('#sidebar a[href="/today"]').first().click()
  await expect(page.locator("body")).toHaveAttribute("data-today-shortcut-swapped", "true")
  const dueRows = page.locator(`#today-due-list .tli:is([data-id="${datedTasks.ids[0]}"], [data-id="${datedTasks.ids[1]}"])`)
  await expect(dueRows).toHaveCount(2)
  await expect(dueRows.last()).toHaveAttribute("draggable", "true")
  await page.locator("#today-search").fill(datedTasks.query)
  await expect(page).toHaveURL(url => url.pathname === "/today" && url.searchParams.get("search") === datedTasks.query)
  const todayUrl = page.url()
  await blurActive(page)
  const rows = page.locator("#page-shell .tli:not(.filtered-out, .today-section--collapsed .tli):visible")

  await page.keyboard.press("ArrowDown")
  await expect(rows.first()).toHaveClass(/tli--focused/)
  await page.keyboard.press("ArrowDown")
  await expect(rows.nth(1)).toHaveClass(/tli--focused/)
  expect(datedTasks.ids).toContain(await rows.nth(1).getAttribute("data-id"))
  await page.keyboard.press("k")
  await expect(rows.first()).toHaveClass(/tli--focused/)
  await expect(page).toHaveURL(todayUrl)
})

datedShortcutTest("Today and Timeline keep arrows and Enter while letter and punctuation shortcuts are off", async ({ page, datedTasks }) => {
  await openSettings(page)
  await preference(page).uncheck()

  await page.goto("/today")
  const rows = page.locator(`.tli:is([data-id="${datedTasks.ids[0]}"], [data-id="${datedTasks.ids[1]}"])`)
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

  await page.goto(timelinePath(datedTasks.query))
  const bars = page.locator(".gantt-bar")
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
})
