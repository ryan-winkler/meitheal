import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Sidebar and Today follow-through", () => {
  test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Meitheal server")

  test("Areas visibility, label and order persist, with one custom link per click", async ({ page }) => {
    await page.goto("/settings#workflow-settings")
    await expect(page.getByRole("checkbox", { name: "Show Areas in sidebar" })).toBeVisible()
    await page.getByRole("textbox", { name: "Custom label for Areas" }).fill("Household areas")
    await page.getByRole("button", { name: "Move Areas up", exact: true }).press("Enter")
    await page.getByRole("button", { name: "Move Areas up", exact: true }).press("Enter")
    await expect(page.getByRole("textbox", { name: "Custom label for Areas" })).toHaveValue("Household areas")
    await page.getByRole("button", { name: "+ Add Custom Link", exact: true }).click()
    await expect(page.locator(".sidebar-custom-link")).toHaveCount(1)
    await page.getByRole("textbox", { name: "Custom link label", exact: true }).fill("Notes")
    await page.getByRole("textbox", { name: "Custom link URL", exact: true }).fill("/planning#spaces")
    await page.getByRole("button", { name: "Save Sidebar Config", exact: true }).click()
    await expect(page.getByRole("textbox", { name: "Custom label for Areas" })).toHaveValue("Household areas")
    await expect(page.locator("#project-nav .stree__label")).toHaveText("Household areas")
    const sidebarOrder = await page.locator("#sidebar .sidebar-scroll").evaluate(scroll => {
      const targets = Array.from(scroll.querySelectorAll("a[data-page], #sidebar-hierarchy-panel"))
      return targets.map(target => target.id === "sidebar-hierarchy-panel" ? "areas" : target.getAttribute("data-page"))
    })
    expect(sidebarOrder.indexOf("areas")).toBeLessThan(sidebarOrder.indexOf("progress"))
    await expect(page.locator("#sidebar").getByRole("link", { name: "Notes", exact: true })).toBeVisible()
    await expect(page.locator('#sidebar [data-page="system-pinned"]')).toHaveAttribute("href", "/pinned")
    await expect(page.locator('#sidebar [data-page="system-pinned"]')).toHaveCount(1)

    await page.setViewportSize({ width: 320, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await page.getByRole("checkbox", { name: "Show Areas in sidebar" }).uncheck()
    await page.getByRole("button", { name: "Save Sidebar Config", exact: true }).click()
    await expect(page.locator("#sidebar-hierarchy-panel")).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole("checkbox", { name: "Show Areas in sidebar" })).not.toBeChecked()

    await page.getByRole("checkbox", { name: "Show Areas in sidebar" }).check()
    await page.getByRole("button", { name: "Save Sidebar Config", exact: true }).click()
    await expect(page.locator("#sidebar-hierarchy-panel")).toHaveCount(1)
  })

  test("Today stays compact, captures work and native sidebar navigation changes its URL", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const now = new Date().toISOString().slice(0, 10)
    const created = await request.post("/api/tasks", { headers, data: { title: "Due-today follow-through", due_date: now } })
    expect(created.status(), await created.text()).toBe(201)
    await page.goto("/")
    await page.locator("#sidebar").getByRole("link", { name: "Today", exact: true }).click()
    await expect(page).toHaveURL(/\/today(?:#today-overview)?$/)
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible()
    await expect(page.locator("#today-overview .page-hero")).toHaveCount(0)
    await expect(page.locator("#daily-stats .stat-item").first().locator(".stat-value")).not.toHaveText("0")
    await expect(page.locator(".sidebar-footer > #connection-status")).toHaveCount(0)
    await expect(page.locator(".sidebar-footer a #connection-status")).toHaveCount(1)
    expect(await page.locator(".sidebar-footer").evaluate(footer => footer.getBoundingClientRect().height)).toBeLessThan(70)

    await page.setViewportSize({ width: 320, height: 812 })
    await expect(page.getByLabel("Add a task for today", { exact: true })).toBeInViewport()
    const title = `Quick capture ${crypto.randomUUID().slice(0, 8)}`
    await page.getByLabel("Add a task for today", { exact: true }).fill(title)
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#quick-add-form").getByRole("button", { name: "Add", exact: true }).click(),
    ])
    await expect.poll(async () => {
      const response = await request.get(`/api/tasks?q=${encodeURIComponent(title)}`)
      const data = await response.json()
      return data.tasks?.[0]?.title
    }).toBe(title)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
    await page.locator("#today-bar-switcher-btn").click()
    await expect(page.locator("#today-bar-switcher-btn")).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("menuitem", { name: /Work/ }).press("Enter")
    await expect(page).toHaveURL(/#today-work$/)
    await expect(page.locator("#section-today")).toBeVisible()
  })
})
