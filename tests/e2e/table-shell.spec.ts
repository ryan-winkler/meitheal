import { randomUUID } from "node:crypto"

import { expect, test as base } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

interface TableTask {
  id: string
  title: string
  ticket_key: string
}

const test = base.extend<{ tableTasks: [TableTask, TableTask] }>({
  tableTasks: async ({ request, baseURL }, use) => {
    const headers = { origin: new URL(baseURL!).origin }
    const tasks: TableTask[] = []
    const createTask = async (status: string, priority: number): Promise<TableTask> => {
      const data = { title: `Table ${status} fixture ${randomUUID()}`, status, priority }
      const response = await request.post("/api/tasks", { headers, data })
      expect(response.status(), await response.text()).toBe(201)
      const task: TableTask = await response.json()
      tasks.push(task)
      return task
    }
    try {
      await use([await createTask("active", 1), await createTask("complete", 3)])
    } finally {
      for (const task of tasks) {
        await request.delete(`/api/tasks/${task.id}`, { headers })
      }
    }
  },
})

test.describe("Table Shell", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("the legacy route opens Table and keyboard-applied filter rules survive reload", async ({ page, tableTasks }) => {
    const [matching, other] = tableTasks
    await page.goto("/table")

    await expect(page).toHaveURL(/\/tasks\?view=table#table$/)
    await expect(page.getByRole("heading", { name: "Table View" })).toBeVisible()
    const views = page.getByRole("navigation", { name: "Task views" })
    await expect(views.getByRole("link", { name: "Table" })).toHaveAttribute("aria-current", "page")
    const table = page.getByRole("table")
    const match = table.getByRole("row").filter({ hasText: matching.title })
    const excluded = table.getByRole("row").filter({ hasText: other.title })
    await expect(match).toBeVisible()
    await expect(excluded).toBeVisible()

    const toolbar = page.locator("#table-shell").getByRole("toolbar", { name: "Filter tasks" })
    const toggle = toolbar.getByRole("button", { name: "Toggle filter builder" })
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    const builder = toolbar.getByRole("region", { name: "Custom Filter Builder" })
    await builder.getByRole("button", { name: "Condition" }).press("Enter")
    await builder.getByPlaceholder("Value...").fill(matching.title)
    await builder.getByRole("button", { name: "Apply Rules" }).press("Enter")

    await expect(page).toHaveURL(/advancedFilter=/)
    await expect(match).toBeVisible()
    await expect(excluded).toBeHidden()

    await page.reload()
    await expect(page).toHaveURL(/advancedFilter=/)
    await expect(match).toBeVisible()
    await expect(excluded).toBeHidden()
  })

  test("the shared search and Assist launchers open their respective panels", async ({ page }) => {
    await page.route("**/api/ha/agents", route => route.fulfill({ json: { agents: [] } }))
    await page.goto("/table")
    await page.getByRole("button", { name: "Search Meitheal…" }).press("Enter")

    await expect(page.locator("#search-hub-overlay")).toBeVisible()
    await expect(page.locator("#search-hub-input")).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(page.locator("#search-hub-overlay")).toBeHidden()

    await page.getByRole("button", { name: "Ask Home Assistant" }).press("Enter")
    await expect(page.getByRole("heading", { name: "Ask Home Assistant" })).toBeVisible()
  })

  test("the shared new task button opens the task capture modal", async ({ page }) => {
    await page.goto("/table")
    await page.getByRole("banner").getByRole("button", { name: "New Task" }).press("Enter")

    await expect(page.locator("#new-task-overlay")).toHaveClass(/active/)
    await expect(page.locator("#new-task-title-input")).toBeFocused()
  })

  test("keyboard view switching keeps URL filters, including a query with no matches", async ({ page, tableTasks }) => {
    const [matching, other] = tableTasks
    const views = page.getByRole("navigation", { name: "Task views" })
    const tableLink = views.getByRole("link", { name: "Table" })
    const kanbanLink = views.getByRole("link", { name: "Kanban" })

    await page.goto("/table?status=active&priority=1")
    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1&view=table#table$/)
    const table = page.getByRole("table")
    const match = table.getByRole("row").filter({ hasText: matching.title })
    const excluded = table.getByRole("row").filter({ hasText: other.title })
    await expect(match).toBeVisible()
    await expect(excluded).toBeHidden()

    await expect(views).toHaveAttribute("data-switcher-ready", "true")
    await tableLink.press("1")
    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1#kanban$/)
    await expect(kanbanLink).toHaveAttribute("aria-current", "page")
    await expect(views).toHaveAttribute("data-switcher-ready", "true")
    await kanbanLink.press("2")
    await expect(page).toHaveURL(/\/tasks\?status=active&priority=1&view=table#table$/)
    await expect(tableLink).toHaveAttribute("aria-current", "page")
    await expect(match).toBeVisible()
    await expect(excluded).toBeHidden()

    const missing = `missing-table-task-${randomUUID()}`
    await page.goto(`/tasks?search=${missing}#kanban`)
    await expect(page).toHaveURL(`/tasks?search=${missing}#kanban`)
    await expect(views).toHaveAttribute("data-switcher-ready", "true")
    await kanbanLink.press("2")
    await expect(page).toHaveURL(`/tasks?search=${missing}&view=table#table`)
    await expect(table.locator(".no-results-row")).toBeVisible()
    await expect(match).toBeHidden()
    const toolbar = page.locator("#table-shell").getByRole("toolbar", { name: "Filter tasks" })
    await expect(toolbar.getByRole("textbox", { name: "Filter by text" })).toHaveValue(missing)
    await toolbar.getByRole("button", { name: "Clear all active filters" }).press("Enter")
    await expect(page).toHaveURL(url => url.hash === "#table" && !url.searchParams.has("search"))
    await expect(match).toBeVisible()
  })

  test("a task key opens detail by keyboard and returns focus when closed", async ({ page, tableTasks }) => {
    const [task] = tableTasks
    await page.goto("/table")
    const row = page.getByRole("row").filter({ hasText: task.title })
    const opener = row.getByRole("button", { name: new RegExp(task.ticket_key) })
    await opener.press("Enter")

    const detail = page.getByRole("dialog", { name: `Task detail: ${task.title}` })
    await expect(detail.locator("#td-title")).toHaveValue(task.title)
    await detail.getByRole("button", { name: "Close detail" }).click()
    await expect(detail).toBeHidden()
    await expect(opener).toBeFocused()

    await row.locator(".td-due").click()
    await expect(detail.locator("#td-title")).toHaveValue(task.title)
  })

  test("a completed row exposes its title and type and remains editable by keyboard", async ({ page, tableTasks }) => {
    const [, task] = tableTasks
    await page.goto("/tasks?view=table")
    await expect(page.getByRole("navigation", { name: "Task views" })).toHaveAttribute("data-switcher-ready", "true")
    const row = page.getByRole("row").filter({
      has: page.getByRole("button", { name: new RegExp(task.ticket_key) }),
    })
    const title = row.getByRole("textbox", { name: "Title", exact: true })
    await expect(title).toHaveText(task.title)
    await expect(row.getByRole("img", { name: "Task Type: task" })).toBeVisible()

    const selection = row.getByRole("checkbox", { name: `Select task: ${task.title}` })
    await selection.check()
    await expect(selection).toBeChecked()
    await expect(page.locator("#bulk-bar")).toBeVisible()
    await selection.uncheck()
    await expect(selection).not.toBeChecked()

    const renamed = `${task.title} renamed`
    await title.fill(renamed)
    await title.press("Tab")
    await expect(title).toHaveAttribute("data-original", renamed)
    await title.fill("Discard this edit")
    await title.press("Escape")
    await expect(title).toHaveText(renamed)
    await page.reload()
    await expect(title).toHaveText(renamed)
  })
})
