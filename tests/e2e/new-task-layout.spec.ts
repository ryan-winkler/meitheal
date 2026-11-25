import { expect, test } from "@playwright/test"
import {
  createDefaultTaskDetailBaseConfig,
  createDefaultTaskDetailBaseConfigForKind,
  taskDetailLayoutKey,
} from "../../apps/web/src/lib/task-detail-layout"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test("New Task layout edits form fields without overwriting detail-only preferences", async ({ page }) => {
  const shopping = createDefaultTaskDetailBaseConfigForKind("shopping_item")
  shopping.labels.comments = "Private notes"
  shopping.labels.tracked = "Effort spent"
  const existing = { ...createDefaultTaskDetailBaseConfig(), kinds: { shopping_item: shopping } }
  await page.addInitScript(({ key, layout }) => localStorage.setItem(key, JSON.stringify(layout)), {
    key: taskDetailLayoutKey,
    layout: existing,
  })

  await page.goto("/today")
  await page.getByRole("button", { name: "New Task", exact: true }).click()
  await page.locator('[data-kind="shopping_item"]').click()
  const toggle = page.locator("#nt-toggle-layout")
  await toggle.click()
  const editor = page.locator("#nt-layout-panel")
  await expect(editor.getByRole("tab")).toHaveCount(5)

  await expect(editor.locator("[data-layout-sections-list] > [data-layout-item]"))
    .toHaveCount(3)
  await expect(editor.locator("[data-layout-sections-list] > li > .td-layout-editor__row"))
    .toHaveCount(0)
  await expect(editor.locator("[data-layout-reset], [data-layout-reset-scope]")).toHaveCount(0)
  await expect(editor.locator('[data-layout-item="description"], [data-layout-item="comments"], [data-layout-item="tracked"], [data-layout-item="reminder"]')).toHaveCount(0)

  const scheduling = editor.locator('[data-layout-item="scheduling"]')
  await scheduling.getByText("Scheduling · Ticket details", { exact: true }).click()
  const dates = scheduling.getByRole("list", { name: "Scheduling · Ticket details", exact: true })
  await editor.getByRole("tab", { name: "Event", exact: true }).click()
  await expect(dates.locator('[data-layout-item="due"]')).toBeHidden()
  await expect(dates.locator('[data-layout-item="recurrence"] [data-layout-move="up"]')).toBeHidden()
  await editor.getByRole("tab", { name: "Shopping", exact: true }).click()
  await dates.locator('[data-layout-item="recurrence"] [data-layout-move="up"]').press("Enter")
  await expect(dates.locator("[data-layout-item]").first()).toHaveAttribute("data-layout-item", "recurrence")
  await scheduling.getByText("Scheduling · More options", { exact: true }).click()
  await expect(scheduling.getByRole("list", { name: "Scheduling · More options", exact: true })
    .locator("[data-layout-move], [data-layout-handle]")).toHaveCount(0)

  const metadata = editor.locator('[data-layout-item="metadata"]')
  await metadata.locator("summary").click()
  const showCustomFields = metadata.getByRole("button", { name: "Show · Custom Fields", exact: true })
  await showCustomFields.click()
  await toggle.click()
  await expect(page.locator("#nt-due-grid > [data-layout-item]").first()).toHaveAttribute("data-layout-item", "recurrence")
  await page.locator("#nt-options > summary").click()
  await expect(page.locator("#nt-add-custom-field-btn")).toBeVisible()

  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), taskDetailLayoutKey)
  expect(saved.kinds.shopping_item.orders.sections).toEqual(shopping.orders.sections)
  expect(saved.kinds.shopping_item.orders.scheduling).toEqual(["recurrence", "reminder", "due", "progress", "tracked"])
  expect(saved.kinds.shopping_item.hidden.sections).toEqual(shopping.hidden.sections)
  expect(saved.kinds.shopping_item.labels).toEqual(shopping.labels)
  expect(saved.orders).toEqual(existing.orders)

  await page.locator('[data-kind="calendar_event"]').click()
  await expect(page.locator("#nt-ctx-due-row")).toBeHidden()
  await expect(page.locator("#nt-event-start")).toBeVisible()
})
