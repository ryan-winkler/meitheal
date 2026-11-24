import { expect, test } from "@playwright/test"
import { APPEARANCE_PREFERENCES } from "../../apps/web/src/lib/appearance-preferences"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { deferred, shouldSkipBrowserSpecs } from "./_helpers"
import { saveAppearance } from "../helpers/appearance-settings"

test.describe("Appearance preferences", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
  test.use({ serviceWorkers: "block" })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("meitheal-theme", localStorage.getItem("meitheal-theme") || "dark"));
    await page.goto("/settings#look-and-feel-settings");
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "");
    await expect(page.locator('[data-settings-nav="look-and-feel-settings"]').first()).toHaveAttribute(
      "aria-current",
      "location",
    );
  });

  test("all ten appearance categories apply, persist and reset without changing the theme", async ({ page }) => {
    await page.locator("#theme-select").selectOption("dark")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.evaluate(() => {
      localStorage.setItem("meitheal-accent-color", "#ffffff")
      localStorage.setItem("meitheal_sidebar_collapsed", "true")
      localStorage.setItem("meitheal_project_nav_group_collapsed", "false")
    })
    await page.goto("/settings#look-and-feel-settings")
    await page.reload()
    // One Look and Feel form holds the theme and every appearance category.
    const visualForm = page.locator("#appearance-preferences-form")
    const save = page.locator("#appearance-save-btn")
    await expect(visualForm.locator("select")).toHaveCount(1 + Object.keys(APPEARANCE_PREFERENCES).length)
    const visualChoices = {
      font: "comic", base: "mist", radius: "1.5",
      width: "boxed", header: "default", panelStyle: "floating",
    }
    const navChoices = {
      navigation: "navbar", navTone: "accent", navStyle: "floating", sidebar: "folded",
    }
    const choices = { ...visualChoices, ...navChoices }
    for (const [name, value] of Object.entries(choices)) await visualForm.locator(`[name="${name}"]`).selectOption(value)
    await save.click()
    await expect(page.locator("#appearance-save-status")).toHaveText("Appearance saved on this device.")

    for (const [name, value] of Object.entries(choices)) {
      const suffix = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
      await expect(page.locator("html")).toHaveAttribute(`data-appearance-${suffix}`, value)
    }
    await expect(page.locator("body")).toHaveCSS("font-family", /Comic Neue/)
    expect(await page.evaluate(() => document.fonts.load('16px "Comic Neue"').then(fonts => fonts.length))).toBeGreaterThan(0)
    await expect(page.locator("#sidebar")).toHaveCSS("position", "relative")
    await expect(page.locator(".main-content")).toHaveCSS("margin-left", "0px")
    await expect(page.locator("#settings-bar")).toHaveCSS("position", "static")
    expect(await page.locator("#main-content").evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1184)
    await expect(page.locator("#task-detail-panel")).toHaveCSS("border-radius", "24px")
    await page.locator("#settings-bar-search-launcher").click()
    await expect(page.locator(".search-hub-panel")).toBeVisible()
    await expect(page.locator(".search-hub-panel")).toHaveCSS("width", "768px")
    await page.keyboard.press("Escape")
    const sidebar = page.locator("#sidebar")
    await expect(sidebar).not.toHaveCSS("background-color", "rgb(255, 255, 255)")
    if (await page.locator("#sidebar-areas-group").count()) {
      const boardsToggle = page.locator("[data-sidebar-boards-toggle]")
      if (await boardsToggle.getAttribute("aria-expanded") === "false") await boardsToggle.press("Enter")
      await expect(page.locator("#sidebar-areas-group")).not.toHaveAttribute("open", "")
      await page.locator("#project-nav-group-toggle").press("Enter")
      await expect(page.locator("#project-nav-content")).toBeVisible()
      await page.locator("#project-nav-group-toggle").press("Escape")
      await expect(boardsToggle).toBeFocused()
      await expect(page.locator("#sidebar-board-children")).toBeHidden()
      expect(await page.evaluate(() => localStorage.getItem("meitheal_project_nav_group_collapsed"))).toBe("false")
    }
    await page.reload()
    for (const [name, value] of Object.entries(choices)) await expect(visualForm.locator(`[name="${name}"]`)).toHaveValue(value)
    await page.setViewportSize({ width: 320, height: 780 })
    await expect(page.locator("#mobile-tab-bar")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(321)
    await expect(page.locator("body")).not.toHaveClass(/sidebar-collapsed/)
    // Reset previews every default, including the personal accent, until saved. The theme stays.
    await page.getByRole("button", { name: "Reset to defaults" }).click()
    await expect(page.locator("html")).toHaveAttribute("data-appearance-font", "sans")
    await save.click()
    await expect(page.locator("#appearance-save-status")).toHaveText("Appearance saved on this device.")
    for (const name of Object.keys(choices)) await expect(visualForm.locator(`[name="${name}"]`)).toHaveValue(APPEARANCE_PREFERENCES[name as keyof typeof APPEARANCE_PREFERENCES].defaultValue)
    expect(await page.evaluate(() => localStorage.getItem("meitheal-theme"))).toBe("dark")
    expect(await page.evaluate(() => localStorage.getItem("meitheal-accent-color"))).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem("meitheal_sidebar_collapsed"))).toBe("true")
  })

  test("sidebar modes preserve remembered state and expand for keyboard focus", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => {
      localStorage.setItem("meitheal_sidebar_collapsed", "false")
      localStorage.setItem("meitheal-appearance", JSON.stringify({ sidebar: "folded" }))
    })
    await page.goto("/settings#look-and-feel-settings")
    await page.reload()
    const sidebar = page.locator("#sidebar")
    const body = page.locator("body")
    await expect(body).toHaveClass(/sidebar-collapsed/)
    const form = page.locator("#appearance-preferences-form")
    const save = page.locator("#appearance-save-btn")
    await form.locator('[name="sidebar"]').selectOption("expanded")
    await save.click()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    await page.locator("#sidebar-edge-toggle").click()
    await expect(body).toHaveClass(/sidebar-collapsed/)
    expect(await page.evaluate(() => localStorage.getItem("meitheal_sidebar_collapsed"))).toBe("false")
    await page.reload()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    await form.locator('[name="sidebar"]').selectOption("hover")
    await form.locator('[name="navStyle"]').selectOption("floating")
    await save.click()
    await page.mouse.move(1000, 700)
    await expect(body).toHaveClass(/sidebar-collapsed/)
    // Finish the mode-change transition before checking that focus expansion stays in place.
    await expect(page.locator(".main-content")).toHaveCSS("margin-left", "76px")
    const before = await page.locator(".main-content").evaluate(el => el.getBoundingClientRect().left)
    await sidebar.locator('a[href="/today"]').first().focus()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    expect(await page.locator(".main-content").evaluate(el => el.getBoundingClientRect().left)).toBe(before)
    await form.locator('[data-visual-field="sidebar"][aria-checked="true"]').focus()
    await expect(body).toHaveClass(/sidebar-collapsed/)
    await form.locator('[name="sidebar"]').selectOption("remember")
    await save.click()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
  })

  test("neutral palette follows Light and Auto while fluid width and sticky headers remain effective", async ({ page }) => {
    await page.setViewportSize({ width: 2000, height: 1000 })
    await page.goto("/settings#look-and-feel-settings")
    const visualForm = page.locator("#appearance-preferences-form")
    await visualForm.locator('[name="base"]').selectOption("stone")
    await visualForm.locator('[name="width"]').selectOption("fluid")
    await visualForm.locator('[name="navigation"]').selectOption("navbar")
    await page.locator("#appearance-save-btn").click()
    expect(await page.locator("#settings-shell").evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(1280)
    await expect(page.locator("#settings-bar")).toHaveCSS("position", "sticky")
    await expect(page.locator("#settings-bar")).toHaveCSS("top", "64px")
    await page.goto("/settings#look-and-feel-settings")
    await page.locator("#theme-select").selectOption("light")
    await saveAppearance(page, { theme: true })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-primary-rgb").trim())).toBe("250 250 249")
    await page.emulateMedia({ colorScheme: "light" })
    await page.locator("#theme-select").selectOption("auto")
    await saveAppearance(page, { theme: true })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-primary-rgb").trim())).toBe("250 250 249")
    await page.emulateMedia({ colorScheme: "dark" })
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-primary-rgb").trim())).toBe("28 25 23")
  })

  test("a pending save commits its submitted choices and leaves later edits in preview", async ({ page }) => {
    const root = page.locator("html")
    const theme = page.locator("#theme-select")
    const form = page.locator("#appearance-preferences-form")
    const font = form.locator('[name="font"]')
    const save = form.locator("#appearance-save-btn")
    const saveGate = deferred<void>()
    await page.route("**/api/settings", async (route) => {
      if (route.request().method() === "PUT") await saveGate.promise
      await route.continue()
    })

    await theme.selectOption("light")
    await font.selectOption("mono")
    const themeRequest = page.waitForRequest((request) =>
      request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings")
    await save.click()
    try {
      expect((await themeRequest).postDataJSON()).toEqual({ key: "theme", value: "light" })
      await form.locator("[data-appearance-reset]").click()
      await theme.selectOption("dark")
      await expect(font).toHaveValue("sans")
    } finally {
      saveGate.resolve()
    }

    await expect(save).toBeEnabled()
    await expect(root).toHaveAttribute("data-theme", "dark")
    await expect(root).toHaveAttribute("data-appearance-font", "sans")
    await expect(form.locator("[data-appearance-dirty-bar]")).toBeVisible()
    expect(await page.evaluate(() => ({
      theme: localStorage.getItem("meitheal-theme"),
      font: JSON.parse(localStorage.getItem("meitheal-appearance")!).font,
    }))).toEqual({ theme: "light", font: "mono" })

    await form.locator("[data-appearance-discard]").click()
    await expect(root).toHaveAttribute("data-theme", "light")
    await expect(root).toHaveAttribute("data-appearance-font", "mono")
    await expect(form.locator("[data-appearance-dirty-bar]")).toBeHidden()
  })

  test("appearance preserves other saved preferences and keeps the draft if storage rejects it", async ({ page }) => {
    await page.evaluate(() => localStorage.setItem("meitheal-appearance", JSON.stringify({
      font: "invalid", radius: "9", navigation: "navbar", futurePreference: "retained",
    })))
    await page.goto("/settings#look-and-feel-settings")
    await page.reload()
    const root = page.locator("html")
    const form = page.locator("#appearance-preferences-form")
    const font = form.locator('[name="font"]')
    const radius = form.locator('[name="radius"]')
    const save = page.locator("#appearance-save-btn")
    const status = page.locator("#appearance-save-status")
    await expect(font).toHaveValue("sans")
    await expect(radius).toHaveValue("1")
    await font.selectOption("mono")
    await radius.selectOption("1.5")
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        if (key === "meitheal-appearance") throw new DOMException("Storage blocked by fixture")
        setItem.call(this, key, value)
      }
    })
    await save.click()
    await expect(status).toHaveText("Appearance could not be saved in this browser.")
    // The rejected draft stays selected and previewed so it can be saved again.
    await expect(font).toHaveValue("mono")
    await expect(radius).toHaveValue("1.5")
    await expect(root).toHaveAttribute("data-appearance-font", "mono")
    await expect(page.locator("#appearance-dirty-bar")).toBeVisible()

    await page.reload()
    await expect(root).toHaveAttribute("data-appearance-font", "sans")
    await font.selectOption("mono")
    await radius.selectOption("1.5")
    await save.click()
    await expect(status).toHaveText("Appearance saved on this device.")
    await expect(page.locator("body")).toHaveCSS("font-family", /monospace/)
    await expect(save).toHaveCSS("border-radius", "9px")
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meitheal-appearance")!))).toEqual({
      navigation: "navbar", navTone: "match", font: "mono", base: "slate", radius: "1.5",
      width: "default", header: "sticky", navStyle: "attached", panelStyle: "attached", sidebar: "remember",
      futurePreference: "retained",
    })
  })

  test("expanded Boards and Areas survive More, wide navbar and phone drawer handoffs", async ({ page, request, baseURL }) => {
    test.slow()
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin }, "", true)
    const areaResponse = await request.post("/api/areas", { headers, data: { name: "Resize Area" } })
    expect(areaResponse.status()).toBe(201)
    const { id: areaId } = await areaResponse.json()
    let projectId: string | undefined
    try {
      const created = await request.post("/api/projects", { headers, data: { title: "Resize Project", area_id: areaId } })
      expect(created.status()).toBe(201)
      projectId = (await created.json()).id
      await page.addInitScript(() => {
        localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" }))
        localStorage.setItem("meitheal_project_nav_group_collapsed", "true")
        sessionStorage.setItem("meitheal-boards-collapsed", "true")
      })
      await page.setViewportSize({ width: 769, height: 900 })
      await page.goto("/today")
      const row = page.locator('[data-nav-overflow="sidebar"]')
      await expect(row).toHaveAttribute("data-nav-overflow-active", "")
      await row.evaluate(element => { element.style.maxWidth = "180px" })
      const more = row.locator("[data-nav-overflow-more]")
      const boards = row.locator('[data-sidebar-group="boards"]')
      const boardToggle = boards.locator("[data-sidebar-boards-toggle]")
      const areaToggle = boards.getByRole("button", { name: "Areas in Household", exact: true })
      const projectToggle = boards.getByRole("button", { name: "Projects in Resize Area", exact: true })
      const project = boards.getByRole("link", { name: "Resize Project", exact: true })
      const arrowTo = async () => {
        for (let step = 0; step < 20; step++) {
          if (await project.evaluate(element => element === document.activeElement)) break
          await page.keyboard.press("ArrowDown")
        }
        await expect(project).toBeFocused()
      }
      await more.locator(":scope > summary").press("ArrowDown")
      await boardToggle.click()
      await expect(boardToggle).toHaveAttribute("aria-expanded", "true")
      await areaToggle.click()
      await expect(areaToggle).toHaveAttribute("aria-expanded", "true")
      await projectToggle.click()
      await expect(projectToggle).toHaveAttribute("aria-expanded", "true")
      await more.locator(":scope > summary").press("ArrowDown")
      await arrowTo()

      await row.evaluate(element => { element.style.maxWidth = "none" })
      await page.setViewportSize({ width: 2200, height: 900 })
      await expect(more).toBeHidden()
      await expect(project).toBeFocused()
      await expect(areaToggle).toHaveAttribute("aria-expanded", "true")
      await expect(projectToggle).toHaveAttribute("aria-expanded", "true")
      await page.setViewportSize({ width: 320, height: 900 })
      await expect(row).not.toHaveAttribute("data-nav-overflow-active", "")
      await expect(areaToggle).toHaveAttribute("aria-expanded", "true")
      await expect(projectToggle).toHaveAttribute("aria-expanded", "true")
      await expect(boardToggle).toHaveAttribute("aria-expanded", "true")
      await expect(page.locator("#sidebar")).toHaveClass(/open/)
      await expect(project).toBeFocused()
      await expect(boards.getByRole("link", { name: "Household", exact: true })).toBeVisible()
      await expect(project).toBeVisible()
      await expect(project).not.toHaveAttribute("tabindex", "-1")
    } finally {
      if (projectId) expect((await request.delete(`/api/projects/${projectId}`, { headers, data: {} })).ok()).toBe(true)
      expect((await request.delete(`/api/areas/${areaId}`, { headers, data: {} })).ok()).toBe(true)
    }
  })
})
