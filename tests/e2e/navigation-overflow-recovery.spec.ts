import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.describe("Native navigation overflow", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test("one More serves both sidebar lists and retains links, focus and the current route through resize", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const previous = (await (await request.get("/api/settings")).json()).sidebar_config
    expect((await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: {
      customItems: [{ id: "overflow-reference", label: "Long reference destination ".repeat(12), href: "https://example.com/reference", icon: "link" }],
    } } })).ok()).toBe(true)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.addInitScript(() => localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" })))
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.goto("/today")
      const row = page.locator('[data-nav-overflow="sidebar"]')
      const more = row.locator("[data-nav-overflow-more]")
      const summary = more.locator("summary")
      const menu = more.locator("[data-nav-overflow-menu]")
      await expect(row).toHaveAttribute("data-nav-overflow-active", "")
      await expect(row.locator("[data-nav-overflow-primary]")).toHaveCount(2)
      await expect(more).toHaveCount(1)
      const count = await row.locator("a[data-page]").count()
      await row.evaluate(el => { el.style.maxWidth = "320px" })
      await expect(more).toBeVisible()
      await expect(menu.locator('[data-page="dashboard"]')).toHaveCount(1)
      await expect(row.locator('[data-nav-overflow-primary] a[data-page="today"]')).toHaveAttribute("aria-current", "page")
      const reference = row.locator('[data-page="overflow-reference"]')
      await expect(menu.locator('[data-page="overflow-reference"]')).toHaveCount(1)
      await expect(reference).toHaveAttribute("href", "https://example.com/reference")
      await expect(reference).toHaveAttribute("target", "_blank")
      await expect(reference).toHaveAttribute("rel", /noopener/)
      await reference.evaluate(link => {
        link.dataset.retainedNode = "original"
        link.addEventListener("retained-link-fixture", () => { link.dataset.retainedListener = "called" }, { once: true })
      })
      const planning = row.locator('[data-page="planning"]')
      const originalHref = await planning.getAttribute("href")
      await planning.evaluate(link => link.setAttribute("href", "/api/hassio_ingress/overflow/planning#spaces"))
      await summary.focus()
      await summary.press("ArrowDown")
      await expect(more).toHaveAttribute("open", "")
      await expect(menu.locator("a").first()).toBeFocused()
      await page.keyboard.press("End")
      await expect(reference).toBeFocused()
      const box = await menu.boundingBox()
      const focusedBox = await reference.boundingBox()
      expect(focusedBox!.y).toBeGreaterThanOrEqual(box!.y)
      expect(focusedBox!.y + focusedBox!.height).toBeLessThanOrEqual(box!.y + box!.height + 1)
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(1440)

      await row.evaluate(el => {
        el.style.maxWidth = "none"
        el.querySelector('[data-page="overflow-reference"] .nav-label')!.textContent = "Reference"
      })
      await page.setViewportSize({ width: 2200, height: 900 })
      await expect(more).toBeHidden()
      await expect(reference).toBeFocused()
      await expect(reference).toHaveAttribute("data-retained-node", "original")
      await expect(planning).toHaveAttribute("href", "/api/hassio_ingress/overflow/planning#spaces")
      await reference.dispatchEvent("retained-link-fixture")
      await expect(reference).toHaveAttribute("data-retained-listener", "called")

      await row.evaluate(el => { el.style.maxWidth = "300px" })
      await expect(more).toHaveAttribute("open", "")
      await expect(reference).toBeFocused()
      await reference.press("Escape")
      await expect(more).not.toHaveAttribute("open", "")
      await expect(summary).toBeFocused()
      await summary.press("Enter")
      await expect(more).toHaveAttribute("open", "")
      await page.locator("#main-content").click({ position: { x: 20, y: 20 } })
      await expect(more).not.toHaveAttribute("open", "")
      await summary.focus()
      await row.evaluate(el => { el.style.maxWidth = "none" })
      await expect(more).toBeHidden()
      await expect(row.locator('[data-page="today"]')).toBeFocused()
      expect(await row.locator("a[data-page]").count()).toBe(count)
      await planning.evaluate((link, href) => link.setAttribute("href", href!), originalHref)
      await planning.click()
      await expect(page).toHaveURL(/\/planning(?:#spaces)?$/)
      await expect(page.locator('[data-nav-overflow="sidebar"] a[data-page="planning"]')).toHaveAttribute("aria-current", "page")
      await expect(page.locator("#sidebar-more-destinations")).toHaveCount(1)
      expect(errors).toEqual([])
    } finally {
      expect((await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })).ok()).toBe(true)
    }
  })

  test("a saved long Areas label leaves More and Settings reachable at 769px", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const previous = (await (await request.get("/api/settings")).json()).sidebar_config
    const longLabel = "HouseholdAreas_".repeat(48)
    const created = await request.post("/api/areas", { headers, data: { name: "Navbar label fixture" } })
    expect(created.status()).toBe(201)
    const { id } = await created.json()
    try {
      expect((await request.put("/api/settings", { headers, data: {
        key: "sidebar_config", value: {
          order: ["dashboard", "today", "upcoming", "tasks", "areas", "progress", "planning"],
          labels: { areas: longLabel },
        },
      } })).ok()).toBe(true)
      expect((await (await request.get("/api/settings")).json()).sidebar_config.labels.areas).toBe(longLabel)
      await page.addInitScript(() => localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" })))
      await page.setViewportSize({ width: 769, height: 900 })
      await page.goto("/today")
      const row = page.locator('[data-nav-overflow="sidebar"]')
      const more = row.locator("[data-nav-overflow-more]")
      const menu = more.locator("[data-nav-overflow-menu]")
      const toggle = page.locator("#project-nav-group-toggle")
      const settings = page.locator(".sidebar-footer a")
      await expect(row).toHaveAttribute("data-nav-overflow-active", "")
      await expect(row.locator("[data-nav-overflow-primary]")).toHaveCount(2)
      await expect(more).toHaveCount(1)
      await expect(menu.locator('[data-page="dashboard"]')).toHaveCount(1)
      await expect(menu.locator('[data-page="planning"]')).toHaveCount(1)
      await expect(more.locator("summary")).toBeInViewport()
      await expect(settings).toBeInViewport()
      await expect(toggle).toHaveAccessibleName(longLabel)
      await expect(toggle.locator(".stree__label")).toHaveText(longLabel)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(770)
      await toggle.focus()
      await toggle.press("Enter")
      await expect(page.locator("#sidebar-areas-group")).toHaveAttribute("open", "")
      await expect(page.locator(`[data-area-toggle="${id}"]`)).toBeInViewport()
      await expect(more.locator("summary")).toBeInViewport()
      await expect(settings).toBeInViewport()
      await toggle.press("Space")
      await expect(page.locator("#sidebar-areas-group")).not.toHaveAttribute("open", "")
      await more.locator("summary").press("ArrowDown")
      await expect(menu.locator("a").first()).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(more.locator("summary")).toBeFocused()
      await settings.focus()
      await expect(settings).toBeFocused()
      expect((await (await request.get("/api/settings")).json()).sidebar_config.labels.areas).toBe(longLabel)
    } finally {
      expect((await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: previous ?? null } })).ok()).toBe(true)
      expect((await request.delete(`/api/areas/${id}`, { headers })).ok()).toBe(true)
    }
  })

  test("crowded Tasks views keep the selected native link visible and navigate from More with filters", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto("/tasks?q=overflow-filter&priority=2")
    const row = page.locator('[data-nav-overflow="views"]')
    const more = row.locator("[data-nav-overflow-more]")
    const menu = more.locator("[data-nav-overflow-menu]")
    const summary = more.locator("summary")
    await expect(row).toHaveAttribute("data-nav-overflow-active", "")
    await expect(row.locator("a[data-view-tab]")).toHaveCount(4)
    await expect(row.locator('[data-nav-overflow-primary] a[data-view-tab="kanban"]')).toHaveAttribute("aria-current", "page")
    await expect(more).toBeVisible()
    await summary.focus()
    await summary.press("ArrowUp")
    await expect(menu.locator("a").last()).toBeFocused()
    await page.keyboard.press("Home")
    await expect(menu.locator("a").first()).toBeFocused()
    const destination = await menu.locator("a").first().getAttribute("data-view-tab")
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(url => url.pathname === "/tasks" && url.searchParams.get("view") === destination
      && url.searchParams.get("q") === "overflow-filter" && url.searchParams.get("priority") === "2")
    await expect(page.locator(`[data-nav-overflow-primary] a[data-view-tab="${destination}"]`)).toHaveAttribute("aria-current", "page")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
  })

  test("the phone drawer restores every destination to its native list and keeps its existing close control", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" })))
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.goto("/today")
    const row = page.locator('[data-nav-overflow="sidebar"]')
    await expect(row).toHaveAttribute("data-nav-overflow-active", "")
    const count = await row.locator("a[data-page]").count()
    await page.setViewportSize({ width: 320, height: 800 })
    await expect(row).not.toHaveAttribute("data-nav-overflow-active", "")
    await expect(row.locator("[data-nav-overflow-more]")).toBeHidden()
    await expect(row.locator("[data-nav-overflow-primary] a[data-page]")).toHaveCount(count)
    await page.locator("#menu-toggle").click()
    await expect(page.locator("#sidebar")).toHaveClass(/open/)
    await expect(row.locator('a[data-page="planning"]')).toBeVisible()
    await page.locator("#sidebar-toggle-btn").click()
    await expect(page.locator("#sidebar")).not.toHaveClass(/open/)
    await expect(page.locator("#menu-toggle")).toBeFocused()
  })
})
