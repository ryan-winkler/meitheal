import { expect, test, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

async function openSettings(page: Page, fragment = ""): Promise<void> {
  await page.goto(`/settings${fragment}`)
  await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
  await expect(page.getByRole("heading", { name: "Settings", exact: true, level: 1 })).toBeVisible()
}

test.describe("Settings Controls", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  for (const [locale, disableAll] of [["en", "Disable all"], ["ga", "Díchumasaigh uile"]] as const) {
    test(`Calendar and To-do actions fit at 320px in ${locale}`, async ({ page, context, baseURL }) => {
      await page.setViewportSize({ width: 320, height: 720 })
      await context.addCookies([{ name: "meitheal-locale", value: locale, url: baseURL! }])
      await page.route("**/api/integrations/calendar/status", (route) => route.fulfill({
        json: { ok: true, calendars: [{ entity_id: "calendar.family", friendly_name: "Family calendar", state: "off" }] },
      }))
      await page.route("**/api/todo", (route) => route.fulfill({
        json: { ok: true, entities: [{ entity_id: "todo.shopping", friendly_name: "Shopping list", state: "0" }] },
      }))

      await page.goto("/settings#integration-calendar")
      await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
      for (const id of ["cal-disable-all", "todo-disable-all"]) {
        if (id.startsWith("todo")) await page.locator('[aria-controls="integration-todo-body"]').click()
        const button = page.locator(`#${id}`)
        await expect(button).toHaveAccessibleName(disableAll)
        await button.scrollIntoViewIfNeeded()
        await expect(button).toBeInViewport({ ratio: 1 })
        const box = await button.boundingBox()
        expect(box!.height).toBeGreaterThanOrEqual(44)
      }
    })
  }

  test("retry hydrates stored values before enabling controls", async ({ page }) => {
    let reads = 0
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "GET") return route.continue()
      reads += 1
      if (reads === 1) return route.fulfill({ status: 503, json: {} })
      return route.fulfill({ json: { timezone: "UTC" } })
    })
    await page.goto("/settings")
    await expect(page.getByRole("alert")).toContainText("Settings could not load")
    await expect(page.locator("#settings-panels")).toHaveAttribute("inert", "")
    await page.getByRole("button", { name: "Try again" }).click()
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    await expect(page.locator("#timezone-select")).toHaveValue("UTC")
    expect(reads).toBe(2)
  })

  for (const status of [403, 503]) {
    test(`a rejected ${status} preference write restores the prior value`, async ({ page }) => {
      await page.route("**/api/settings", (route) => route.request().method() === "PUT"
        ? route.fulfill({ status, json: {} })
        : route.fulfill({ json: { timezone: "Europe/Dublin" } }))
      await openSettings(page)
      await page.locator("#timezone-select").selectOption("UTC")
      await expect(page.locator("#toast-container .toast.error")).toContainText(/could not be saved/i)
      await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
      await expect(page.locator("#timezone-select")).toHaveValue("Europe/Dublin")
      expect(await page.evaluate(() => localStorage.getItem("meitheal-timezone"))).not.toBe("UTC")
    })
  }

  test("custom field changes stop after a failed read and retain the draft", async ({ page }) => {
    await openSettings(page, "#workflow-settings")
    let reads = 0
    let writes = 0
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "GET") reads += 1
      if (route.request().method() === "PUT") writes += 1
      await route.fulfill({ status: 503, json: {} })
    })
    await page.locator("#add-custom-field").click()
    const field = page.getByRole("textbox", { name: "Field name" }).last()
    await field.fill("Local field")
    await page.locator(".custom-field-save").click()
    await expect(page.locator("#toast-container .toast.error")).toBeVisible()
    await expect(field).toHaveValue("Local field")
    expect(reads).toBe(1)
    expect(writes).toBe(0)
  })

  test("multi-key failure stops the save and identifies partial persistence", async ({ page }) => {
    const writes: string[] = []
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      const { key } = route.request().postDataJSON()
      writes.push(key)
      await route.fulfill({ status: writes.length === 2 ? 503 : 200, json: {} })
    })
    await openSettings(page, "#automation-ai-settings")
    await page.locator("#save-agent-protocols").click()
    await expect(page.locator("#toast-container .toast.error")).toContainText("Some changes were saved")
    await expect(page.locator("#save-agent-protocols")).toBeEnabled()
    await expect(page.locator("#toast-container .toast.success")).toHaveCount(0)
    expect(writes).toEqual(["agent-protocols-a2a-enabled", "agent-protocols-webmcp-enabled"])
  })

  test("cancel retains focus and issues no destructive request", async ({ page }) => {
    let deletions = 0
    await page.route("**/api/settings?reset=all", async (route) => {
      deletions += 1
      await route.abort()
    })
    await openSettings(page, "#danger-zone-settings")
    const reset = page.locator("#reset-settings")
    await reset.click()
    const cancel = page.getByRole("alertdialog").getByRole("button", { name: "Cancel" })
    await expect(cancel).toBeFocused()
    await cancel.click()
    await expect(reset).toBeFocused()
    expect(deletions).toBe(0)
  })
})
