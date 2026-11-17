import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")
test.use({ serviceWorkers: "block" })

test("reopening from Completed today restores Unscheduled without a reload", async ({ page, request }) => {
  await page.addInitScript(() => localStorage.setItem("meitheal-theme", "knight-rider"))
  await page.emulateMedia({ reducedMotion: "reduce" })
  const title = "Restore completed task to Unscheduled"
  const created = await request.post("/api/tasks", { data: { title } })
  expect(created.status()).toBe(201)
  const { id } = await created.json()
  try {
    const completed = await request.put(`/api/tasks/${id}`, { data: { status: "complete" } })
    expect(completed.ok()).toBe(true)
    await page.goto("/today#today-work")
    const section = page.locator("#section-unscheduled")
    const row = section.locator(`.tli[data-id="${id}"]`)
    await expect(row).toHaveCount(0)
    const count = section.locator(".today-section__count")
    const previousCount = Number(await count.textContent())
    const disclosure = page.locator(".today-completed-tasks")
    await disclosure.locator("summary").press("Enter")
    const completion = disclosure.getByRole("link", { name: title })
    await completion.press("Enter")
    const status = page.locator("#td-status")
    await expect(status).toHaveValue("complete")
    await status.selectOption("active")
    await expect(count).toHaveText(String(previousCount + 1))
    await expect(section).toBeVisible()
    await expect(completion).toHaveCount(0)
    await page.getByRole("button", { name: "Close detail" }).press("Enter")
    await section.getByRole("button", { name: /^Unscheduled/ }).click()
    await expect(row).toHaveAttribute("data-work-active", "")
  } finally {
    await request.delete(`/api/tasks/${id}`, { data: {} })
  }
})
