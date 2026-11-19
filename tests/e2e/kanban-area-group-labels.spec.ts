import { randomUUID } from "node:crypto"
import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

test("Kanban groups the current page by available Area names and reflects changes after refresh", async ({ page, request, baseURL }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin, "sec-fetch-site": "same-origin" })
  const prefix = `Area grouping ${randomUUID().slice(0, 8)}`
  const areaIds: string[] = []
  const taskIds: string[] = []
  const retiredAreas = new Set<string>()

  async function createArea(name: string) {
    const response = await request.post("/api/areas", { headers, data: { name, icon: "📁" } })
    expect(response.status()).toBe(201)
    const { id } = await response.json() as { id: string }
    areaIds.push(id)
    return id
  }

  async function renameArea(id: string, name: string) {
    const response = await request.put(`/api/areas/${id}`, { headers, data: { name } })
    expect(response.ok()).toBe(true)
  }

  try {
    const areaOne = await createArea("First fixture Area")
    const areaTwo = await createArea("Second fixture Area")
    const [zulu, alpha] = areaOne < areaTwo ? [areaOne, areaTwo] : [areaTwo, areaOne]
    await renameArea(zulu, "Zulu workbench")
    await renameArea(alpha, "Alpha kitchen")
    const formerOffice = await createArea("Former office")
    const formerPantry = await createArea("Former pantry")

    for (const [area, suffix] of [[zulu, "bench"], [alpha, "tap"], ["default", "capture"], [formerOffice, "legacy desk"], [formerPantry, "legacy shelves"]]) {
      const response = await request.post("/api/tasks", { headers, data: { area_id: area, title: `${prefix} ${suffix}` } })
      expect(response.status()).toBe(201)
      taskIds.push((await response.json() as { id: string }).id)
    }
    for (const area of [formerOffice, formerPantry]) {
      const retirement = await request.delete(`/api/areas/${area}`, { headers, data: {} })
      expect(retirement.status(), await retirement.text()).toBe(200)
      retiredAreas.add(area)
    }

    await page.goto(`/tasks?search=${encodeURIComponent(prefix)}#kanban`)
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    await page.locator("#kanban-group-by-dropdown summary").click()
    await page.locator("#kanban-group-by-dropdown").getByRole("button", { name: "By Area" }).click()
    const lane = page.locator('.kanban-column[data-status="pending"]')
    const groups = lane.locator(".dynamic-group")
    const groupNames = groups.locator(".swimlane-label")
    await expect(groupNames).toHaveText(["📁 Alpha kitchen", "📋 Default", "📋 No area", "📁 Zulu workbench"])
    const unavailable = groups.filter({ hasText: "No area" })
    await expect(unavailable).toHaveCount(1)
    const unavailableCards = unavailable.locator(".kanban-card")
    await expect(unavailableCards).toHaveCount(2)
    for (const suffix of ["legacy desk", "legacy shelves"]) {
      await expect(unavailableCards.filter({ hasText: `${prefix} ${suffix}` })).toBeVisible()
    }
    await expect(lane.locator(".kanban-count")).toHaveText("5")

    await unavailable.locator(".swimlane-header").click()
    await expect(unavailable).toHaveClass(/swimlane-collapsed/)
    await page.reload()
    await expect(unavailable).toHaveClass(/swimlane-collapsed/)

    await renameArea(zulu, "Aardvark workbench")
    await page.getByRole("textbox", { name: "Filter by text" }).fill(`${prefix} bench`)
    await expect(groupNames).toHaveText(["📁 Aardvark workbench"])
    await page.reload()
    await expect(groupNames).toHaveText(["📁 Aardvark workbench"])
  } finally {
    for (const id of taskIds) {
      const response = await request.delete(`/api/tasks/${id}`, { headers, data: {} })
      expect(response.status(), await response.text()).toBe(204)
    }
    for (const id of areaIds) {
      if (!retiredAreas.has(id)) await request.delete(`/api/areas/${id}`, { headers, data: {} })
    }
  }
})
