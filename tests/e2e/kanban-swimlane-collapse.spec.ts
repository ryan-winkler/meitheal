import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test("Kanban swimlane headings collapse and remember each lane independently", async ({ page, request }) => {
  test.skip(shouldSkipBrowserSpecs() || process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  const label = `Swimlane ${randomUUID()}`
  const ids: string[] = []
  const pending = page.locator('.kanban-column[data-status="pending"]')
  const active = page.locator('.kanban-column[data-status="active"]')

  try {
    for (const status of ["pending", "active"]) {
      const created = await request.post("/api/tasks", {
        data: { title: `${label} ${status}`, status, task_type: "task", priority: 2 },
      })
      expect(created.status()).toBe(201)
      ids.push((await created.json()).id)
    }

    const pendingCard = pending.locator(`.kanban-card[data-id="${ids[0]}"]`)
    const activeCard = active.locator(`.kanban-card[data-id="${ids[1]}"]`)
    const openGrouping = (mode: string) => page.goto(`/tasks?search=${encodeURIComponent(label)}&groupBy=${mode}#kanban`)
    const heading = (column: typeof pending, group: string) => column
      .locator(`.swimlane-group[data-swimlane-type="${group}"]`).getByRole("button").first()

    await openGrouping("type")
    const pendingType = heading(pending, "task")
    await expect(pendingType).toHaveAttribute("aria-expanded", "true")
    const controlled = await pendingType.getAttribute("aria-controls")
    expect(controlled).toBeTruthy()
    await expect(page.locator(`#${controlled}`)).toHaveCount(1)
    await pendingType.press("Enter")
    await expect(pendingType).toHaveAttribute("aria-expanded", "false")
    await expect(pendingType).toBeFocused()
    await expect(pendingCard).toBeHidden()
    await expect(activeCard).toBeVisible()

    await page.reload()
    await expect(pendingType).toHaveAttribute("aria-expanded", "false")
    await expect(heading(active, "task")).toHaveAttribute("aria-expanded", "true")
    await pendingType.press("Space")
    await expect(pendingCard).toBeVisible()
    await pendingCard.locator(".card-open-btn").press("c")
    await expect(pendingCard).toBeHidden()
    await expect(activeCard).toBeHidden()
    await expect(pendingType).toBeFocused()
    await pendingType.press("c")
    await expect(pendingCard).toBeVisible()
    await expect(activeCard).toBeVisible()

    await openGrouping("priority")
    const activePriority = heading(active, "2")
    await activePriority.click()
    await expect(activePriority).toHaveAttribute("aria-expanded", "false")
    await expect(activeCard).toBeHidden()
    await expect(pendingCard).toBeVisible()
    await page.reload()
    await expect(activePriority).toHaveAttribute("aria-expanded", "false")
    await openGrouping("type")
    await expect(activeCard).toBeVisible()
  } finally {
    for (const id of ids) await request.delete(`/api/tasks/${id}`)
  }
})
