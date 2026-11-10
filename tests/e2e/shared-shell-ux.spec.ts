import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test("Today and Settings content stays opaque during entry motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  const layers = ".main-content, .content-area, main .card"
  await page.addInitScript((selector) => {
    document.addEventListener("animationstart", (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || !target.matches(selector)) return
      for (const animation of target.getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName === event.animationName) {
          animation.pause()
        }
      }
    }, { capture: true })
  }, layers)

  for (const [path, shell] of [["/today", "#today-overview"], ["/settings#personal-settings", "#settings-shell"]] as const) {
    await page.goto(path)
    await expect(page.locator(shell)).toBeVisible()
    const translucent = await page.locator(layers).evaluateAll((elements) =>
      elements.filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).opacity !== "1")
        .map((element) => [element.id || element.className, getComputedStyle(element).opacity]),
    )
    expect(translucent, path).toEqual([])
  }
})

for (const theme of ["light", "dark"]) {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    test(`shared shell and work surfaces at ${viewport.width}px in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("meitheal-theme", value), theme)

      for (const path of ["/", "/tasks", "/settings"]) {
        await page.goto(path)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await expect(page.locator("#main-content")).toBeVisible()
        await page.evaluate(() => document.fonts.ready)

        await expect(page.locator(".shortcut-hint")).toHaveCount(0)

        if ((path === "/" || path === "/settings") && viewport.width === 390) {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
          const goTop = page.getByRole("button", { name: "Scroll to top" })
          await expect(goTop).toBeVisible()
          const button = (await goTop.boundingBox())!
          const bar = (await page.getByRole("navigation", { name: "Mobile navigation" }).boundingBox())!
          expect(button.y + button.height).toBeLessThan(bar.y)
          expect(button.width).toBeGreaterThanOrEqual(44)
          expect(button.height).toBeGreaterThanOrEqual(44)
          await goTop.click()
          await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
        }

        const scan = new AxeBuilder({ page }).withRules(["color-contrast", "nested-interactive", "target-size", "link-in-text-block"])
        if (path === "/settings") {
          scan
            .include(".sidebar")
            .include(".unified-bar")
            .include("#mobile-tab-bar")
            .include(".settings-shell-nav")
            .include("#rules-lenses-settings")
            .include("#automation-ai-settings .integration-config")
            .include("#ha-agent-status")
            .include("#ext-ai-badge")
            .include("#agent-protocols-status")
            .include("#grocy-status")
            .include("#n8n-status")
        }
        const { violations } = await scan.analyze()
        expect(violations.map(({ id, nodes }) => [id, nodes.map(({ target }) => target)]), path).toEqual([])
      }
    })
  }
}

test("empty area hints stay readable in both themes", async ({ browser, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const area = await request.post("/api/areas", { headers, data: { name: "Empty area contrast fixture" } })
  expect(area.status()).toBe(201)
  const { id } = await area.json()
  const selector = `#stree-area-projects-${id} .stree__empty-hint`

  try {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" })
      try {
        const page = await context.newPage()
        await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)
        await page.goto(baseURL!)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        await expect(page.locator(selector)).toBeVisible()
        const { violations } = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze()
        expect(violations.map(({ id }) => id), theme).toEqual([])
      } finally {
        await context.close()
      }
    }
  } finally {
    await request.delete(`/api/areas/${id}`, { headers })
  }
})

test("area disclosure keeps keyboard focus and actions separate", async ({ page, request, baseURL }) => {
  const headers = { origin: new URL(baseURL!).origin }
  const areaName = `Sidebar fixture ${crypto.randomUUID()}`
  const createArea = await request.post("/api/areas", { headers, data: { name: areaName } })
  expect(createArea.status()).toBe(201)
  const { id: areaId } = await createArea.json()
  let projectId: string | undefined
  try {
    const title = "Sidebar disclosure fixture"
    const createProject = await request.post("/api/projects", { headers, data: { title, area_id: areaId } })
    expect(createProject.status()).toBe(201)
    projectId = (await createProject.json()).id

    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto("/")
    const area = page.locator(`[data-area-group="${areaId}"]`)
    const toggle = area.getByRole("button", { name: areaName, exact: true })
    const actions = area.locator(".stree__actions").first()
    const menu = actions.getByRole("button", { name: `Area options - ${areaName}` })
    const add = actions.getByRole("button", { name: `New project in ${areaName}` })
    const projects = area.locator(`#stree-area-projects-${areaId}`)
    const project = projects.locator(`a[href="/projects/${projectId}"]`)

    await expect(toggle).toHaveAttribute("aria-controls", `stree-area-projects-${areaId}`)
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(projects).toHaveAttribute("inert", "")
    await project.evaluate((link: HTMLElement) => link.focus())
    await expect(toggle).toBeFocused()

    await page.keyboard.press("Tab")
    await expect(menu).toBeFocused()
    await menu.press("Enter")
    await expect(page.locator(".stree__dropdown [data-action='rename']").first()).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Tab")
    await expect(add).toBeFocused()

    await page.locator('.sidebar .nav-link[href="/tasks"]').click()
    await expect(page).toHaveURL(/\/tasks(?:#kanban)?$/)
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.press("Space")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await toggle.press("ArrowDown")
    await expect(project).toBeFocused()

    await toggle.press("Enter")
    await page.reload()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await add.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(projects.getByRole("textbox")).toBeFocused()
  } finally {
    if (projectId) await request.delete(`/api/projects/${projectId}`, { headers })
    await request.delete(`/api/areas/${areaId}`, { headers })
  }
})
