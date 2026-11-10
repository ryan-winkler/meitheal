import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

async function addUser(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post("/api/users/custom", { data: { name } })
  expect(response.status()).toBe(201)
  return (await response.json()).id
}

function userRequests(page: Page): string[] {
  const calls: string[] = []
  page.on("request", request => {
    const { pathname } = new URL(request.url())
    if (pathname.startsWith("/api/users")) calls.push(`${request.method()} ${pathname}`)
  })
  return calls
}

test.describe("Settings users", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test("loads People and notifications together and refreshes both after edits", async ({ page, request }) => {
    const original = await addUser(request, "Shared settings user")
    const calls = userRequests(page)

    await page.goto("/settings#workflow-settings")
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    const select = page.getByRole("combobox", { name: "Default task assignee" })
    const notifications = page.locator("#notif-user-toggles")
    const originalToggle = notifications.locator(`input[data-user-id="${original}"]`)
    await expect(select.locator(`option[value="${original}"]`)).toHaveText("Shared settings user (Custom)")
    await expect(originalToggle).toBeChecked()
    expect(calls).toEqual(["GET /api/users"])

    // A custom-user refresh must not discard unsaved notification preferences.
    await originalToggle.locator("..").click()
    await expect(originalToggle).not.toBeChecked()

    await page.getByRole("textbox", { name: "New custom user name" }).fill("New settings user")
    const [created] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/users/custom"),
      page.getByRole("button", { name: "+ Add User" }).click(),
    ])
    expect(created.status()).toBe(201)
    const added = (await created.json()).id
    const addedToggle = notifications.locator(`input[data-user-id="${added}"]`)
    await expect(select.locator(`option[value="${added}"]`)).toHaveText("New settings user (Custom)")
    await expect(addedToggle).toBeChecked()
    await expect(originalToggle).not.toBeChecked()

    await select.selectOption(original)
    const [saved] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/users/default"),
      page.locator("#save-default-assignee").click(),
    ])
    expect(saved.status()).toBe(200)
    expect(await saved.json()).toEqual({ default_assignee: original })

    const [deleted] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname === "/api/users/custom"),
      page.getByRole("button", { name: "Remove New settings user" }).click(),
    ])
    expect(deleted.status()).toBe(200)
    await expect(select.locator(`option[value="${added}"]`)).toHaveCount(0)
    await expect(select).toHaveValue(original)
    await expect(addedToggle).toHaveCount(0)
    await expect(originalToggle).not.toBeChecked()
    expect(calls).toEqual([
      "GET /api/users",
      "POST /api/users/custom", "GET /api/users",
      "PUT /api/users/default",
      "DELETE /api/users/custom", "GET /api/users",
    ])

    const [preferences] = await Promise.all([
      page.waitForResponse(response => {
        const request = response.request()
        return request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings"
          && request.postDataJSON().key === "notification_preferences"
      }),
      page.getByRole("button", { name: "Save notification preferences" }).click(),
    ])
    expect(preferences.status()).toBe(200)
    expect(preferences.request().postDataJSON().value.disabled_users).toEqual([original])
  })

  test("keeps custom users and default assignee available when the merged read fails", async ({ page, request }) => {
    const user = await addUser(request, "Fallback settings user")
    const saved = await request.put("/api/users/default", { data: { user_id: user } })
    expect(saved.ok()).toBe(true)
    const calls = userRequests(page)
    await page.route("**/api/users", route => route.fulfill({ status: 503, json: {} }))

    await page.goto("/settings#workflow-settings")
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "")
    await expect(page.getByRole("combobox", { name: "Default task assignee" })).toHaveValue(user)
    await expect(page.locator("#custom-users-list")).toContainText("Fallback settings user")
    await expect(page.locator("#discovered-users-list")).toContainText("Could not load Home Assistant users")
    await expect(page.locator(`#notif-user-toggles input[data-user-id="${user}"]`)).toBeChecked()
    expect(calls.sort()).toEqual(["GET /api/users", "GET /api/users/custom", "GET /api/users/default"])
  })
})
