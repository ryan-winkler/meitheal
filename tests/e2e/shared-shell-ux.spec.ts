import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

async function openHouseholdAreas(page: Page) {
  const boards = page.locator("[data-sidebar-boards-toggle]")
  if (await boards.getAttribute("aria-expanded") !== "true") await boards.press("Enter")
  const household = page.locator('[data-named-board-shortcut="household"]')
  const areas = household.getByRole("button", { name: "Areas in Household" })
  if (await areas.getAttribute("aria-expanded") !== "true") await areas.press("Enter")
  await expect(areas).toHaveAttribute("aria-expanded", "true")
  return household
}

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

test("work queue links and Pillar actions retain contrast through hover", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  const targets = [
    ["/deferred", "[data-deferred-root] > header > a"],
    ["/inactivity", "a[data-inactivity-back]"],
    ["/triage", "[data-triage-root] > header > a"],
    ["/progress#pillars", "#pillar-add-btn, #pillar-add-btn-empty"],
  ] as const
  await page.goto("/deferred")
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => localStorage.setItem("meitheal-theme", value), theme)
    for (const [path, selector] of targets) {
      await page.goto(path)
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await expect(page.locator(selector).first(), path).toBeVisible()
      await page.mouse.move(0, 0)
      const check = async (state: string) => {
        const { violations, passes } = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze()
        const sample = `${path} in ${theme}, ${state}`
        expect.soft(violations, sample).toEqual([])
        expect.soft(passes.some(({ id }) => id === "color-contrast"), sample).toBe(true)
      }
      await check("normal")
      for (const [index, control] of (await page.locator(selector).all()).entries()) {
        await expect(control).toBeVisible()
        await control.hover()
        await control.evaluate(element => Promise.allSettled(element.getAnimations().map(animation => animation.finished)))
        await check(`hover ${index + 1}`)
      }
    }
  }
})

for (const theme of ["light", "dark"] as const) {
  for (const width of [320, 1440]) {
    test(`shared task rows announce types and keep five readable priorities at ${width}px in ${theme} theme`, async ({ page, request, baseURL }) => {
      const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
      const dueDate = new Date().toISOString().slice(0, 10)
      const priorities = ["Critical", "High", "Medium", "Low", "Minimal"]
      const tasks: Array<{ id: string; priority: string }> = []

      try {
        for (const [index, label] of priorities.entries()) {
          const created = await request.post("/api/tasks", {
            headers,
            data: {
              title: `Task row contrast fixture: ${label}`,
              due_date: dueDate,
              priority: index + 1,
              urgency: 5,
              importance: 5,
            },
          })
          expect(created.status()).toBe(201)
          tasks.push({ id: (await created.json()).id, priority: label })
        }

        await page.setViewportSize({ width, height: 960 })
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)

        for (const [path, section] of [["/today", "#today-work"], ["/eisenhower", "#eisenhower-matrix"]] as const) {
          await page.goto(path)
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
          await page.evaluate(() => document.fonts.ready)
          const scan = new AxeBuilder({ page }).withRules(["aria-prohibited-attr", "color-contrast"])

          for (const { id, priority } of tasks) {
            const row = `${section} .tli[data-id="${id}"]`
            const label = `${row} .tli__meta > span:first-child`
            await expect(page.locator(label)).toHaveText(priority)
            await expect(page.locator(label)).toBeVisible()
            expect.soft(await page.locator(row).getByRole("img", { name: "Task Type: task" }).count(), path).toBe(1)
            scan.include(label).include(`${row} .task-type-icon`)
          }

          const { violations, passes } = await scan.analyze()
          expect.soft(violations.map(({ id, nodes }) => [id, nodes.map(({ target }) => target)]), path).toEqual([])
          expect.soft(passes.find(({ id }) => id === "color-contrast")?.nodes, path).toHaveLength(priorities.length)
        }
      } finally {
        for (const { id } of tasks) {
          await request.delete(`/api/tasks/${id}`, { headers, data: {} })
        }
      }
    })
  }
}

for (const theme of ["light", "dark"]) {
  for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
    test(`shared shell and work surfaces at ${viewport.width}px in ${theme} theme`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.addInitScript((value) => localStorage.setItem("meitheal-theme", value), theme)

      const settingsSections = ["", "#rules-lenses-settings", "#automation-ai-settings", "#integrations-settings"]
      for (const path of ["/", "/tasks", ...settingsSections.map(hash => `/settings${hash}`)]) {
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
        if (path.startsWith("/settings")) {
          await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert")
          const sections = page.locator("#settings-sections-toggle")
          if (await sections.getAttribute("aria-expanded") === "false") await sections.click()
          scan
            .include(".sidebar")
            .include("#settings-bar")
            .include("#mobile-tab-bar")
            .include("#settings-directory")
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
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const area = await request.post("/api/areas", { headers, data: { name: "Empty area contrast fixture" } })
  expect(area.status()).toBe(201)
  const { id } = await area.json()
  const selector = `[data-board-projects="${id}"] > [data-board-group-status]`

  try {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" })
      try {
        const page = await context.newPage()
        await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)
        await page.goto(new URL("/today", baseURL!).href)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        const household = await openHouseholdAreas(page)
        await household.getByRole("button", { name: "Projects in Empty area contrast fixture" }).press("Enter")
        await expect(page.locator(selector)).toBeVisible()
        await expect(page.locator(selector)).toHaveText("No Projects yet")
        const { violations } = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze()
        expect(violations.map(({ id }) => id), theme).toEqual([])
      } finally {
        await context.close()
      }
    }
  } finally {
    await request.delete(`/api/areas/${id}`, { headers, data: {} })
  }
})

test("area disclosure keeps keyboard focus and actions separate", async ({ page, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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
    await page.goto("/today")
    const household = await openHouseholdAreas(page)
    const area = household.locator(`[data-area-group="${areaId}"]`)
    const toggle = area.getByRole("button", { name: `Projects in ${areaName}`, exact: true })
    const actions = area.locator(".stree__actions").first()
    const menu = actions.getByRole("button", { name: `Area options - ${areaName}` })
    const add = actions.getByRole("button", { name: `New project in ${areaName}` })
    const projects = area.locator(`[data-board-projects="${areaId}"]`)
    const project = projects.getByRole("link", { name: title, exact: true })

    await expect(toggle).toHaveAttribute("aria-controls", `stree-area-projects-${areaId}`)
    await toggle.press("Enter")
    await expect(project).toBeVisible()
    const opened = await project.elementHandle()
    await toggle.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await expect(projects).toHaveAttribute("inert", "")
    await expect(project).toHaveCount(0)
    expect(await opened!.evaluate(link => { link.focus(); return link.isConnected })).toBe(false)
    await expect(toggle).toBeFocused()

    await page.keyboard.press("Tab")
    await expect(menu).toBeFocused()
    await menu.press("Enter")
    await expect(page.locator(".stree__dropdown [data-action='rename']").first()).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Tab")
    await expect(add).toBeFocused()

    // The URL changes before Astro finishes rebinding the persisted sidebar.
    const pageLoaded = page.evaluate(() => new Promise<void>(resolve => {
      document.addEventListener("astro:page-load", () => resolve(), { once: true })
    }))
    await page.locator('#sidebar a[data-page="tasks"]').click()
    await pageLoaded
    await expect(page).toHaveURL(url => ["/tasks", "/boards/household"].includes(url.pathname))
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await toggle.press("Space")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(project).toBeVisible()
    await toggle.press("ArrowDown")
    await expect(project).toBeFocused()

    await toggle.press("Enter")
    await page.reload()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    await add.press("Enter")
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(projects.getByRole("textbox")).toBeFocused()
  } finally {
    if (projectId) {
      const removeProject = await request.delete(`/api/projects/${projectId}`, { headers, data: {} })
      expect(removeProject.status()).toBe(200)
    }
    const removeArea = await request.delete(`/api/areas/${areaId}`, { headers, data: {} })
    expect(removeArea.status()).toBe(200)
  }
})

test("sidebar edge toggle, 64px collapsed rail, and unclipped controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto("/", { waitUntil: "networkidle" })

  await expect(page.locator(".shortcut-hint")).toHaveCount(0)

  const sidebar = page.locator("#sidebar")
  const edgeToggle = page.locator("#sidebar-edge-toggle")
  const railCta = page.locator("#sidebar-rail-new-task")

  await expect(sidebar).toHaveCSS("overflow", "visible")
  await expect(edgeToggle).toBeVisible()
  await expect(railCta).toBeVisible()

  const expandedBox = (await sidebar.boundingBox())!
  const edgeBox = (await edgeToggle.boundingBox())!
  expect(Math.round(expandedBox.width)).toBe(240)
  expect(Math.abs((edgeBox.x + edgeBox.width / 2) - (expandedBox.x + expandedBox.width))).toBeLessThanOrEqual(4)
  expect(edgeBox.width).toBeGreaterThanOrEqual(24)
  expect(edgeBox.height).toBeGreaterThanOrEqual(24)

  await edgeToggle.click()
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/)
  await expect.poll(async () => Math.round(((await sidebar.boundingBox())!).width)).toBe(64)

  const railCtaBox = (await railCta.boundingBox())!
  expect(Math.round(railCtaBox.width)).toBe(40)
  expect(Math.round(railCtaBox.height)).toBe(40)

  // The rail CTA and the shared "meitheal:new-task" event open the New Task modal.
  const newTaskOverlay = page.locator("#new-task-overlay")
  await railCta.click()
  await expect(newTaskOverlay).toBeVisible()
  await expect(page.locator("#new-task-title-input")).toBeFocused()
  await page.locator("#close-new-task-modal").click()
  await expect(newTaskOverlay).toBeHidden()
  await page.evaluate(() => document.dispatchEvent(new CustomEvent("meitheal:new-task")))
  await expect(newTaskOverlay).toBeVisible()
  await page.locator("#close-new-task-modal").click()
  await expect(newTaskOverlay).toBeHidden()

  await edgeToggle.click()
  await expect(page.locator("body")).not.toHaveClass(/sidebar-collapsed/)

  await page.setViewportSize({ width: 375, height: 812 })
  await expect(edgeToggle).toBeHidden()
})
