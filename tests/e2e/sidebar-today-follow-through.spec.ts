import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
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
    if (createdTaskIds.length) {
      const boardHeaders = await currentBoardWriteHeaders(request, "household", headers)
      for (const id of createdTaskIds.splice(0)) {
        expect((await request.delete(`/api/tasks/${id}`, { headers: boardHeaders, data: {} })).status()).toBe(204)
      }
    }
  })

  test("Hiding Boards also hides its Household shortcuts", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    expect((await request.put("/api/settings", {
      headers, data: { key: "sidebar_config", value: { boards: false, areas: true } },
    })).ok()).toBe(true)
    await page.goto("/tasks")
    // Hidden items stay in the document for inline editing but are not shown.
    await expect(page.locator('#sidebar [data-page="boards"]')).toBeHidden()
    await expect(page.locator("[data-sidebar-board-children]")).toBeHidden()
  })

  test("Household Areas remain under Boards with legacy visibility and label settings", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const saveConfig = async (value: Record<string, unknown>) =>
      expect((await request.put("/api/settings", { headers, data: { key: "sidebar_config", value } })).ok()).toBe(true)
    // Areas are no longer an editor row, but saved Areas labels and visibility still apply under Boards.
    await saveConfig({ labels: { areas: "Household areas" } })
    await page.goto("/today")
    const boardGroup = page.locator('#sidebar [data-sidebar-group="boards"]')
    const household = boardGroup.locator('[data-named-board-shortcut="household"]')
    await expect(household.getByRole("button", { name: "Household areas in Household" })).toBeAttached()
    await expect(page.locator('#sidebar [data-sidebar-group="areas"]')).toHaveCount(0)
    await saveConfig({ areas: false })
    await page.reload()
    await expect(household.locator("[data-board-groups]")).toHaveCount(0)
    await saveConfig({})
    await page.reload()
    await expect(household.locator("[data-board-groups]")).toHaveCount(1)

    // Deep links open the Sidebar Configuration disclosure, whose editor adds custom links.
    await page.goto("/settings#nav-sidebar-menu-section")
    const editor = page.locator("#sidebar-item-list")
    await expect(editor.getByRole("button", { name: "Hide · Boards", exact: true }).first()).toBeVisible()
    await page.locator("#settings-add-link-toggle").click()
    await page.getByRole("textbox", { name: "Custom link label", exact: true }).fill("Notes")
    await page.getByRole("textbox", { name: "Custom link URL", exact: true }).fill("/planning#spaces")
    await page.locator("#settings-add-link-form").getByRole("button", { name: "Add custom link", exact: true }).click()
    await expect(editor.getByRole("button", { name: "Hide · Notes", exact: true })).toBeVisible()
    await page.locator("#save-sidebar").click()
    await expect(page.locator("#sidebar-dirty-bar")).toBeHidden()
    await expect(page.locator("#sidebar").getByRole("link", { name: "Notes", exact: true })).toBeVisible()
    await expect(page.locator('#sidebar [data-page="system-pinned"]')).toHaveAttribute("href", "/pinned")
    await expect(page.locator('#sidebar [data-page="system-pinned"]')).toHaveCount(1)
    await page.setViewportSize({ width: 320, height: 812 })
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await saveConfig({})
  })

  test("Sidebar Reset clears a stored hidden Areas flag, Discard keeps it and Save applies it", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin }
    const storedConfig = async () => (await (await request.get("/api/settings")).json()).sidebar_config
    expect((await request.put("/api/settings", { headers, data: { key: "sidebar_config", value: { areas: false } } })).ok()).toBe(true)
    await page.goto("/settings#nav-sidebar-menu-section")
    const dirtyBar = page.locator("#sidebar-dirty-bar")
    const household = page.locator('#sidebar [data-named-board-shortcut="household"]')
    await expect(household.locator("[data-board-groups]")).toHaveCount(0)
    await expect(dirtyBar).toBeHidden()
    const reset = async () => {
      await page.locator("#reset-sidebar").click()
      await page.getByRole("alertdialog").getByRole("button", { name: "Confirm", exact: true }).click()
    }

    // Reset changes only the Areas flag here, so it alone must make the draft dirty.
    await reset()
    await expect(dirtyBar).toBeVisible()
    const save = page.locator("#save-sidebar")
    const saveSidebar = async (click: () => Promise<void>) => {
      const response = page.waitForResponse(res => new URL(res.url()).pathname === "/api/settings"
        && res.request().method() === "PUT" && res.request().postDataJSON()?.key === "sidebar_config")
      await click()
      expect((await response).ok()).toBe(true)
      await expect(save).toBeEnabled()
      await expect(save).not.toHaveAttribute("aria-busy", "true")
    }
    await page.locator("#discard-sidebar").click()
    await expect(dirtyBar).toBeHidden()
    // Saving the discarded draft must write the committed Areas flag back unchanged.
    await saveSidebar(() => save.evaluate(button => (button as HTMLButtonElement).click()))
    expect(await storedConfig()).toMatchObject({ areas: false })

    await reset()
    await expect(dirtyBar).toBeVisible()
    await saveSidebar(() => save.click())
    await expect(dirtyBar).toBeHidden()
    const saved = await storedConfig()
    expect(saved.areas).not.toBe(false)
    expect(saved.hiddenItems ?? []).not.toContain("areas")
    await page.goto("/today")
    await expect(household.locator("[data-board-groups]")).toHaveCount(1)
  })

  test("Boards and its per-Board Areas disclosure collapse independently and work with blocked storage", async ({ page }) => {
    await page.goto("/today", { waitUntil: "domcontentloaded" })
    const group = page.locator("[data-sidebar-board-children]")
    const toggle = page.locator("[data-sidebar-boards-toggle]")
    const home = group.getByRole("button", { name: "Areas in Household" })
    await expect(group).toBeVisible()
    await expect(home).toHaveAttribute("aria-expanded", "false")
    await home.press("Enter")
    await expect(home).toHaveAttribute("aria-expanded", "true")
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(group).toBeHidden()
    await expect(page.locator("#sidebar").getByRole("link", { name: "Planning", exact: true })).toBeVisible()
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(group).toBeHidden()
    await toggle.press("Space")
    await expect(group).toBeVisible()
    await expect(home).toHaveAttribute("aria-expanded", "true")
    await home.press("Enter")
    await expect(home).toHaveAttribute("aria-expanded", "false")

    // Resizing the sidebar keeps the current disclosure even with a stale saved value.
    await page.evaluate(() => sessionStorage.setItem("meitheal-boards-collapsed", "true"))
    await page.setViewportSize({ width: 320, height: 812 })
    await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "true")
    await expect(toggle).toBeInViewport()
    await expect(group).toBeVisible()
    await toggle.press("Enter")
    await expect(group).toBeHidden()
    await toggle.press("Space")
    await expect(group).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await page.locator("#sidebar-toggle-btn").click()
    await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "false")
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException("Storage blocked", "SecurityError") }
      Storage.prototype.setItem = () => { throw new DOMException("Storage blocked", "SecurityError") }
    })
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(group).toBeVisible()
    await toggle.press("Enter")
    await expect(group).toBeHidden()
    await toggle.press("Space")
    await expect(group).toBeVisible()
  })

  test("Today stays compact, captures work and native sidebar navigation changes its URL", async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
    // The readiness dot was removed from navigation; no link may describe itself by a missing element.
    await expect(page.locator("#connection-status")).toHaveCount(0)
    await expect(page.locator('#sidebar [aria-describedby="connection-status"]')).toHaveCount(0)
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
