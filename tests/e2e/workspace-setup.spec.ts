import { expect, test } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

test.describe("workspace setup", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

  test("Skip restores focus and preserves existing choices", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("link", { name: "Set up Meitheal" }).click()
    await expect(page).toHaveURL(/\/setup$/)
    const skip = page.getByRole("button", { name: "Skip setup", exact: true })
    const dialog = page.getByRole("dialog", { name: "Skip setup?" })
    await skip.click()
    await expect(dialog.getByRole("button", { name: "Keep setting up" })).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(skip).toBeFocused()
    await skip.click()
    await dialog.click({ position: { x: 4, y: 4 } })
    await expect(dialog).toBeHidden()
    await expect(skip).toBeFocused()

    await page.getByRole("combobox", { name: "Theme" }).selectOption("dark")
    await skip.click()
    await dialog.getByRole("button", { name: "Skip setup", exact: true }).click()
    await expect(page).toHaveURL(/view=dashboard/)
    expect(await page.evaluate(() => localStorage.getItem("meitheal-workspace-v1:browser")))
      .toBe(JSON.stringify({ acknowledged: true }))
    await page.goto("/")
    await expect(page.getByRole("link", { name: "Set up Meitheal" })).toBeHidden()
  })

  test("Simple saves a theme and ordinary Quick Add while Advanced controls the first page", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" })
    await page.goto("/setup")
    await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue("auto")
    await page.getByRole("combobox", { name: "Theme" }).selectOption("dark")
    await page.getByRole("button", { name: "Use Simple" }).click()
    await expect(page).toHaveURL(/view=dashboard/)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")

    await page.locator("#dashboard-bar-new-task").click()
    const quick = page.getByRole("dialog", { name: "Quick Add" })
    await expect(quick.getByRole("textbox")).toBeFocused()
    const title = "First setup task " + Date.now()
    await quick.getByRole("textbox").fill(title)
    await quick.getByRole("button", { name: "Add task", exact: true }).click()
    await expect(page.locator("#task-list")).toContainText(title)

    await page.goto("/tasks?view=kanban")
    await page.locator("#kanban-bar-new-task").click()
    await expect(quick.getByRole("textbox")).toBeFocused()
    await quick.getByRole("textbox").fill("Remember the groceries")
    await quick.getByRole("button", { name: "Open full task form" }).click()
    await expect(page.locator("#new-task-title-input")).toHaveValue("Remember the groceries")

    await page.goto("/settings#app-pwa-settings")
    await page.getByRole("link", { name: "Run setup again" }).click()
    await page.getByText("Advanced", { exact: true }).click()
    await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue("dark")
    await page.getByText("AI Setup", { exact: true }).click()
    await expect(page.locator('a[href*="#ai-agents-settings"]').last()).toBeVisible()
    await page.getByText("Framework Scoring", { exact: true }).click()
    await expect(page.locator('a[href*="#scoring-settings"]').last()).toBeVisible()
    await page.getByRole("combobox", { name: "First page" }).selectOption("tasks")
    await page.getByRole("button", { name: "Finish setup" }).click()
    await expect(page).toHaveURL(/\/tasks\?view=kanban#kanban$/)

    await page.goto("/?view=dashboard#dashboard-overview")
    await expect(page).toHaveURL(/\/\?view=dashboard#dashboard-overview$/)
    await page.goto("/")
    await expect(page).toHaveURL(/\/tasks\?view=kanban#kanban$/)
  })

  test("a pending Quick Add cannot be dismissed and resubmitted before the result", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("meitheal-workspace-v1:browser", JSON.stringify({ capture: "quick" })))
    const release = deferred<void>()
    let submits = 0
    await page.route("**/api/tasks", async route => {
      if (route.request().method() !== "POST") return route.continue()
      submits += 1
      await release.promise
      await route.fulfill({ status: 503, json: { error: "Result unconfirmed" } })
    })
    await page.goto("/?view=dashboard")
    await page.locator("#dashboard-bar-new-task").click()
    const quick = page.getByRole("dialog", { name: "Quick Add" })
    await quick.getByRole("textbox").fill("One uncertain task")
    await quick.getByRole("button", { name: "Add task", exact: true }).click()
    try {
      await expect(quick.getByText("Saving task…")).toBeVisible()
      await page.keyboard.press("Escape")
      await expect(quick).toBeVisible()
    } finally {
      release.resolve()
    }
    await expect(quick.getByRole("alert")).toContainText("Check your tasks")
    await expect(quick.getByRole("textbox")).toHaveValue("One uncertain task")
    await expect(quick.getByRole("button", { name: "Add task", exact: true })).toBeDisabled()
    await expect(quick.getByRole("button", { name: "Open full task form" })).toBeDisabled()
    expect(submits).toBe(1)
  })

  test("setup keeps the selected theme when browser storage rejects the save", async ({ page }) => {
    await page.addInitScript(() => {
      const save = Storage.prototype.setItem
      let blocked = true
      Storage.prototype.setItem = function (key, value) {
        if (blocked && key === "meitheal-workspace-v1:browser") {
          blocked = false
          throw new DOMException("Storage blocked", "QuotaExceededError")
        }
        save.call(this, key, value)
      }
    })
    await page.goto("/setup")
    const selector = page.getByRole("combobox", { name: "Theme" })
    const finish = page.getByRole("button", { name: "Use Simple" })
    await selector.selectOption("dark")
    await finish.click()
    await expect(page.getByRole("alert")).toContainText("This browser couldn’t save your choices")
    await expect(selector).toHaveValue("dark")
    await finish.click()
    await expect(page).toHaveURL(/view=dashboard/)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  })
})
