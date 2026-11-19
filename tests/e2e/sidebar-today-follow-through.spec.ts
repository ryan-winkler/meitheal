import { expect, test } from "@playwright/test"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"

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

  test("Hiding Boards also hides its Household shortcuts", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    expect((await request.put("/api/settings", {
      headers, data: { key: "sidebar_config", value: { boards: false, areas: true } },
    })).ok()).toBe(true)
    await page.goto("/tasks")
    await expect(page.locator('#sidebar [data-page="boards"]')).toHaveCount(0)
    await expect(page.locator("#sidebar-hierarchy-panel")).toHaveCount(0)
  })

  test("Household Areas remain under Boards with legacy visibility and label settings", async ({ page }) => {
    await page.goto("/settings#navigation-settings")
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
    expect(sidebarOrder.indexOf("areas")).toBe(sidebarOrder.indexOf("boards") + 1)
    await expect(page.locator('#sidebar [data-sidebar-group="boards"] #sidebar-hierarchy-panel')).toHaveCount(1)
    await expect(page.locator('#sidebar [data-sidebar-group="areas"]')).toHaveCount(0)
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
    await expect(page.locator("#sidebar").getByRole("link", { name: "Planning", exact: true })).toBeVisible()
    await expect.poll(() => page.evaluate(() => localStorage.getItem("meitheal_project_nav_group_collapsed"))).toBe("true")
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(group).not.toHaveAttribute("open")
    await toggle.press("Space")
    await expect(group).toHaveAttribute("open", "")
    await expect(home).toHaveAttribute("aria-expanded", "false")
    await home.press("Enter")
    await expect(home).toHaveAttribute("aria-expanded", "true")

    // A sidebar-to-drawer resize keeps the current disclosure even with a stale saved value.
    await page.evaluate(() => localStorage.setItem("meitheal_project_nav_group_collapsed", "true"))
    await page.setViewportSize({ width: 320, height: 812 })
    await expect(page.locator("#menu-toggle")).toBeEnabled()
    await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "true")
    await expect(toggle).toBeInViewport()
    await expect(group).toHaveAttribute("open", "")
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

    const mobileMenu = page.locator("#menu-toggle")
    await expect(mobileMenu).toHaveAttribute("data-drawer-ready", "true")
    const todayLink = page.locator("#sidebar").getByRole("link", { name: "Today", exact: true })
    await todayLink.focus()
    await expect(todayLink).toBeFocused()
    await page.setViewportSize({ width: 320, height: 812 })
    await expect(mobileMenu).toHaveAttribute("aria-expanded", "true")
    await page.locator("#sidebar").getByRole("button", { name: "Close sidebar", exact: true }).click()
    await expect(mobileMenu).toHaveAttribute("aria-expanded", "false")
    await expect(mobileMenu).toBeFocused()
    await expect(page.getByLabel("Add a task for today", { exact: true })).toBeInViewport()
    const title = `Quick capture ${crypto.randomUUID().slice(0, 8)}`
    await page.getByLabel("Add a task for today", { exact: true }).fill(title)
    const receipt = page.waitForResponse(response =>
      new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "POST",
    )
    await page.locator("#quick-add-form").getByRole("button", { name: "Add", exact: true }).click()
    const response = await receipt
    expect(response.status()).toBe(201)
    expect(response.request().postDataJSON().title).toBe(title)
    await expect.poll(async () => {
      const response = await request.get(`/api/tasks?q=${encodeURIComponent(title)}`)
      const data = await response.json()
      return data.tasks?.[0]?.title
    }).toBe(title)
    const capture = await (await request.get(`/api/tasks?q=${encodeURIComponent(title)}`)).json()
    const capturedId = capture.tasks[0].id as string
    expect(capturedId).toBeTruthy()
    createdTaskIds.push(capturedId)
    await expect(page.getByLabel("Add a task for today", { exact: true })).toHaveValue("")
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await expect.poll(() => page.evaluate(() => typeof window.openTaskDetail)).toBe("function")
    await page.locator("#today-bar-switcher-btn").click()
    await expect(page.locator("#today-bar-switcher-btn")).toHaveAttribute("aria-expanded", "true")
    await page.getByRole("menuitem", { name: /Work/ }).press("Enter")
    await expect(page).toHaveURL(/#today-work$/)
    await expect(page.locator("#section-today")).toBeVisible()
    await expect(page.locator(`#today-due-list .tli[data-id="${capturedId}"]`)).toBeVisible()
  })

  test.describe("navigation focus handoff", () => {
    // The gate must hold the actual module request before service-worker handling.
    test.use({ serviceWorkers: "block" })

    for (const moveFocusToPage of [false, true]) {
      test(`phone resize during Today loading ${moveFocusToPage ? "preserves a newly focused page input" : "restores the focused sidebar destination"}`, async ({ page }) => {
        const releaseModule = deferred<void>()
        let moduleHeld = false
        await page.route(url => url.pathname.includes("/today.astro")
          && (url.pathname.endsWith(".js") || url.searchParams.get("type") === "script"), async route => {
          moduleHeld = true
          await releaseModule.promise
          await route.continue()
        })
        try {
          await page.goto("/")
          const menu = page.locator("#menu-toggle")
          await expect(menu).toHaveAttribute("data-drawer-ready", "true")
          const today = page.locator("#sidebar").getByRole("link", { name: "Today", exact: true })
          await today.click()
          await expect.poll(() => moduleHeld, { timeout: 15_000 }).toBe(true)
          await expect(page).toHaveURL(/\/today(?:#today-overview)?$/)
          await expect(page.getByRole("heading", { name: "Today", level: 1 })).toBeVisible()
          await expect(today).toBeFocused()
          await expect(menu).toBeDisabled()
          await expect(menu).not.toHaveAttribute("data-drawer-ready", "true")
          const input = page.getByLabel("Add a task for today", { exact: true })
          if (moveFocusToPage) {
            await input.fill("Keep this draft")
            await expect(input).toBeFocused()
          }
          await page.setViewportSize({ width: 320, height: 812 })
          await expect(menu).toBeDisabled()
          releaseModule.resolve()
          await expect(menu).toHaveAttribute("data-drawer-ready", "true")
          await expect(menu).toBeEnabled()
          if (moveFocusToPage) {
            await expect(menu).toHaveAttribute("aria-expanded", "false")
            await expect(input).toBeFocused()
            await expect(input).toHaveValue("Keep this draft")
            await expect(input).toBeInViewport()
          } else {
            await expect(menu).toHaveAttribute("aria-expanded", "true")
            await expect(today).toBeFocused()
            await expect(today).toBeInViewport()
            await page.locator("#sidebar").getByRole("button", { name: "Close sidebar", exact: true }).click()
            await expect(menu).toHaveAttribute("aria-expanded", "false")
            await expect(menu).toBeFocused()
          }
        } finally {
          releaseModule.resolve()
        }
      })
    }

    for (const intent of ["next sidebar destination", "page input then page heading"]) {
      test(`phone resize during Today loading respects newer focus on ${intent}`, async ({ page }) => {
        const releaseModule = deferred<void>()
        let moduleHeld = false
        await page.route(url => url.pathname.includes("/today.astro")
          && (url.pathname.endsWith(".js") || url.searchParams.get("type") === "script"), async route => {
          moduleHeld = true
          await releaseModule.promise
          await route.continue()
        })
        try {
          await page.goto("/")
          const menu = page.locator("#menu-toggle")
          await expect(menu).toHaveAttribute("data-drawer-ready", "true")
          const today = page.locator("#sidebar").getByRole("link", { name: "Today", exact: true })
          await today.click()
          await expect.poll(() => moduleHeld, { timeout: 15_000 }).toBe(true)
          await expect(page).toHaveURL(/\/today(?:#today-overview)?$/)
          const heading = page.getByRole("heading", { name: "Today", level: 1 })
          await expect(heading).toBeVisible()
          await expect(today).toBeFocused()
          await expect(menu).toBeDisabled()
          const upcoming = page.locator('#sidebar [data-page="upcoming"]')
          const input = page.getByLabel("Add a task for today", { exact: true })
          if (intent === "next sidebar destination") {
            await page.keyboard.press("Tab")
            await expect(upcoming).toBeFocused()
          } else {
            await input.fill("Keep newer page intent")
            await expect(input).toBeFocused()
            await heading.click()
            await expect(page.locator("body")).toBeFocused()
          }
          await page.setViewportSize({ width: 320, height: 812 })
          await expect(menu).toBeDisabled()
          releaseModule.resolve()
          await expect(menu).toHaveAttribute("data-drawer-ready", "true")
          await expect(menu).toBeEnabled()
          if (intent === "next sidebar destination") {
            await expect(menu).toHaveAttribute("aria-expanded", "true")
            await expect(upcoming).toBeFocused()
            await expect(upcoming).toBeInViewport()
            await page.locator("#sidebar").getByRole("button", { name: "Close sidebar", exact: true }).click()
            await expect(menu).toHaveAttribute("aria-expanded", "false")
            await expect(menu).toBeFocused()
          } else {
            await expect(menu).toHaveAttribute("aria-expanded", "false")
            await expect(page.locator("body")).toBeFocused()
            await expect(input).toHaveValue("Keep newer page intent")
            await expect(input).toBeInViewport()
          }
        } finally {
          releaseModule.resolve()
        }
      })
    }
  })
})
