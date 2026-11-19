import { expect, test } from "@playwright/test"
import { deferred } from "./_helpers"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
test.use({ serviceWorkers: "block" })

test("a slow assignee directory leaves the ticket editable and ignores a superseded response", async ({ page, request }) => {
  const firstAssignee = "ha_11111111111111111111111111111111"
  const secondAssignee = "ha_22222222222222222222222222222222"
  const first = await request.post("/api/tasks", {
    data: { title: "First assigned ticket", description: "Existing description", assigned_to: firstAssignee },
  })
  const second = await request.post("/api/tasks", { data: { title: "Second assigned ticket", assigned_to: secondAssignee } })
  expect(first.status()).toBe(201)
  expect(second.status()).toBe(201)
  const { id } = await first.json()
  const { id: other } = await second.json()

  const heldDirectory = deferred<void>()
  const staleResponse = deferred<void>()
  let directories = 0
  await page.route("**/api/users", async route => {
    if (route.request().method() !== "GET") return route.continue()
    if (++directories === 1) {
      await heldDirectory.promise
      await route.fulfill({ json: { users: [{ id: firstAssignee, name: "Previous assignee" }] } }).catch(() => {})
      staleResponse.resolve()
      return
    }
    if (directories === 2) return route.fulfill({ json: { users: [{ id: secondAssignee, name: "Current assignee" }] } })
    return route.fulfill({ status: 503, json: { error: "Unavailable" } })
  })

  // The calendar has no assignee labels that would also request the directory.
  await page.goto("/tasks?view=calendar")
  await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
  const assignee = page.locator("#td-assigned-to")
  const savedDescription = "Saved while the directory is pending"
  try {
    await page.evaluate(id => { void window.openTaskDetail?.(id) }, id)
    await expect.poll(() => directories).toBe(1)
    await expect(page.locator("#td-loaded-content")).toBeVisible()
    await expect(assignee).toBeVisible()
    await expect(assignee).toBeDisabled()
    await expect(assignee).toHaveValue(firstAssignee)
    await expect(page.locator("#td-status")).toBeEnabled()
    await page.getByRole("button", { name: "Edit description" }).click()
    await page.locator("#td-description").fill(savedDescription)
    await page.locator("#td-desc-save-btn").click()
    await expect(page.locator("#td-desc-preview")).toHaveText(savedDescription)
    expect(await (await request.get(`/api/tasks/${id}`)).json())
      .toMatchObject({ description: savedDescription, assigned_to: firstAssignee })

    await page.evaluate(id => { void window.openTaskDetail?.(id) }, other)
    await expect(page.locator("#td-title")).toHaveValue("Second assigned ticket")
    await expect(assignee).toBeEnabled()
    await expect(assignee.locator("option:checked")).toHaveText("Current assignee")
    heldDirectory.resolve()
    await staleResponse.promise
    await expect(assignee.locator(`option[value="${firstAssignee}"]`)).toHaveCount(0)
    await expect(assignee).toHaveValue(secondAssignee)

    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.locator("#task-detail-overlay")).toBeHidden()
    await expect(page).toHaveURL(url => url.pathname === "/tasks" && url.searchParams.get("view") === "calendar")
    const reopened = page.waitForResponse(response => new URL(response.url()).pathname === `/api/tasks/${other}`)
    await page.evaluate(id => { void window.openTaskDetail?.(id) }, other)
    expect((await reopened).status()).toBe(200)
    await expect.poll(() => directories).toBe(3)
    await expect(page.locator("#td-loaded-content")).toBeVisible()
    await expect(assignee.locator("option:checked")).toHaveText("Could not load assignee")
    await expect(assignee).toBeDisabled()
    await expect(assignee).toHaveValue(secondAssignee)
  } finally {
    heldDirectory.resolve()
  }
})
