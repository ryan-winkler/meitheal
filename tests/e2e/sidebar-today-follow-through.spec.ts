import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Sidebar and Today follow-through", () => {
  test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Meitheal server")

  let sidebarConfig: unknown
  const createdTaskIds: string[] = []
  test.beforeEach(async ({ request }) => {
    sidebarConfig = (await (await request.get("/api/settings")).json()).sidebar_config
  })
  test.afterEach(async ({ request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    expect((await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: sidebarConfig ?? null } })).ok()).toBe(true)
    for (const id of createdTaskIds.splice(0)) {
      expect((await request.delete(`/api/tasks/${id}`, { headers, data: {} })).status()).toBe(204)
    }
  })

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

  test("the entire Areas menu collapses independently and remembers its state without storage dependence", async ({ page }) => {
    await page.goto("/today", { waitUntil: "domcontentloaded" })
    const group = page.locator("#sidebar-areas-group")
    const toggle = page.locator("#project-nav-group-toggle")
    const home = page.locator("[data-area-toggle]").first()
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { __meithealAreasDisclosure?: unknown }).__meithealAreasDisclosure))).toBe(true)
    await expect(group).toHaveAttribute("open", "")
    await home.press("Enter")
    await expect(home).toHaveAttribute("aria-expanded", "false")
    await toggle.press("Enter")
    await expect(group).not.toHaveAttribute("open")
    await expect(page.locator("#project-nav-content")).toBeHidden()
    await expect(page.locator("#project-nav").getByRole("link", { name: "Manage areas & projects" })).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem("meitheal_project_nav_group_collapsed"))).toBe("true")
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(group).not.toHaveAttribute("open")
    await toggle.press("Space")
    await expect(group).toHaveAttribute("open", "")
    await expect(home).toHaveAttribute("aria-expanded", "false")
    await home.press("Enter")
    await expect(home).toHaveAttribute("aria-expanded", "true")

    await page.setViewportSize({ width: 320, height: 812 })
    await expect(page.locator("#menu-toggle")).toBeEnabled()
    await page.locator("#menu-toggle").click()
    await expect(toggle).toBeInViewport()
    await toggle.press("Enter")
    await expect(group).not.toHaveAttribute("open")
    await toggle.press("Space")
    await expect(group).toHaveAttribute("open", "")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await page.locator("#sidebar-toggle-btn").click()
    await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "false")
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException("Storage blocked", "SecurityError") }
      Storage.prototype.setItem = () => { throw new DOMException("Storage blocked", "SecurityError") }
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(group).toHaveAttribute("open", "")
    await toggle.press("Enter")
    await expect(group).not.toHaveAttribute("open")
    await toggle.press("Space")
    await expect(group).toHaveAttribute("open", "")
  })

  test("Today stays compact, captures work and native sidebar navigation changes its URL", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const now = new Date().toISOString().slice(0, 10)
    const created = await request.post("/api/tasks", { headers, data: { title: "Due-today follow-through", due_date: now } })
    expect(created.status(), await created.text()).toBe(201)
    createdTaskIds.push((await created.json()).id)
    await page.goto("/")
    await page.locator("#sidebar").getByRole("link", { name: "Today", exact: true }).click()
    await expect(page).toHaveURL(/\/today(?:#today-overview)?$/)
    await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible()
    await expect(page.locator("#today-overview .page-hero")).toHaveCount(0)
    await expect(page.locator("#daily-stats .stat-item").first().locator(".stat-value")).not.toHaveText("0")
    await expect(page.locator(".sidebar-footer > #connection-status")).toHaveCount(1)
    await expect(page.locator(".sidebar-footer a #connection-status")).toHaveCount(0)
    await expect(page.locator(".sidebar-footer a")).toHaveAttribute("aria-describedby", "connection-status")
    await expect(page.locator(".sidebar-footer a")).toHaveAccessibleDescription("Meitheal ready")
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
    const capture = await (await request.get(`/api/tasks?q=${encodeURIComponent(title)}`)).json()
    createdTaskIds.push(capture.tasks[0].id)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
    await page.locator("#today-bar-switcher-btn").click()
    await expect(page.locator("#today-bar-switcher-btn")).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("menuitem", { name: /Work/ }).press("Enter")
    await expect(page).toHaveURL(/#today-work$/)
    await expect(page.locator("#section-today")).toBeVisible()
  })
})
