import { writeFile } from "node:fs/promises"
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { shouldSkipBrowserSpecs } from "./_helpers"

// These tests create and remove their own data in the disposable local fixture.
const configuredOrigin = process.env.E2E_BASE_URL ? new URL(process.env.E2E_BASE_URL) : null
const localFixture = configuredOrigin && ["127.0.0.1", "localhost", "[::1]"].includes(configuredOrigin.hostname)
test.skip(shouldSkipBrowserSpecs() || !localFixture, "Run against a disposable loopback fixture")
test.use({
  serviceWorkers: "block", trace: "retain-on-failure",
  ...(localFixture ? { extraHTTPHeaders: { origin: configuredOrigin.origin } } : {}),
})

type Placement = "primary" | "More" | "phone"

async function removeFixtureEntity(request: APIRequestContext, path: string) {
  const headers = await currentBoardWriteHeaders(request, "household", {})
  const deleted = await request.delete(path, { headers, data: {} })
  expect(deleted.status()).toBe(200)
}

async function openHierarchy(page: Page, placement?: Placement) {
  const drawer = page.locator("#menu-toggle")
  if (await drawer.isVisible() && await drawer.getAttribute("aria-expanded") !== "true") await drawer.click()
  const boards = page.locator("[data-sidebar-boards-toggle]")
  const more = page.locator("#sidebar [data-nav-overflow-more]")
  const inMore = page.locator("[data-nav-overflow-menu] [data-sidebar-boards-toggle]")
  if (placement === "More") await expect(inMore).toHaveCount(1)
  if (placement === "primary" || placement === "phone") await expect(inMore).toHaveCount(0)
  if (await inMore.count()) {
    if (!(await more.evaluate(element => (element as HTMLDetailsElement).open))) {
      await more.locator(":scope > summary").click()
    }
  }
  if (await boards.getAttribute("aria-expanded") !== "true") await boards.click()
  const areas = page.locator("#sidebar-areas-group")
  if (!(await areas.evaluate(element => (element as HTMLDetailsElement).open))) {
    await areas.locator(":scope > summary").click()
  }
  await expect(page.locator("#project-nav-content")).toBeVisible()
}

async function expectHierarchyOpen(page: Page, trigger: Locator, placement: Placement) {
  await expect(page.locator("[data-sidebar-boards-toggle]")).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator("#sidebar-areas-group")).toHaveJSProperty("open", true)
  if (placement === "phone") await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "true")
  if (await trigger.evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))) {
    await expect(page.locator("#sidebar [data-nav-overflow-more]")).toHaveJSProperty("open", true)
  }
}

async function checkColorIconEscape(page: Page, trigger: Locator, menu: Locator, placement: Placement) {
  await trigger.click()
  const colorIcon = menu.getByRole("button", { name: "Color & Icon", exact: true })
  await expect(colorIcon).toBeVisible()
  await colorIcon.press("Enter")
  const popover = page.locator("body > #color-icon-popover")
  await expect(popover).toBeVisible()
  await expect(popover.locator("[data-emoji-tab]").first()).toBeFocused()
  await page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent("meitheal:view-changed"))
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  await expect(popover).toBeVisible()
  await expect(popover.locator("[data-emoji-tab]").first()).toBeFocused()
  if (await trigger.evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))) {
    await expect(page.locator("#sidebar [data-nav-overflow-more]")).toHaveJSProperty("open", true)
  }
  await page.keyboard.press("Escape")
  await expect(popover).toBeHidden()
  await expect(trigger).toBeFocused()
  await expectHierarchyOpen(page, trigger, placement)
}

for (const placement of ["primary", "More", "phone"] as const) {
  test.describe(`navbar hierarchy actions in ${placement}`, () => {
    let areaId: string
    let projectId: string
    let areaName: string
    let projectName: string

    test.beforeEach(async ({ page, request }) => {
      areaId = ""
      projectId = ""
      await page.setViewportSize({ width: { primary: 2200, More: 769, phone: 390 }[placement], height: 1000 })
      await page.addInitScript(() => {
        localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" }))
      })
      const suffix = crypto.randomUUID().slice(0, 8)
      areaName = `Navbar action Area ${suffix}`
      projectName = `Navbar action Project ${suffix}`
      const headers = await currentBoardWriteHeaders(request, "household", {})
      const area = await request.post("/api/areas", { headers, data: { name: areaName } })
      expect(area.status()).toBe(201)
      areaId = (await area.json()).id
      const project = await request.post("/api/projects", { headers, data: { title: projectName, area_id: areaId } })
      expect(project.status()).toBe(201)
      projectId = (await project.json()).id
      await page.goto("/today")
      await expect(page.locator("html")).toHaveAttribute("data-appearance-navigation", "navbar")
      // Let the asynchronous badge update finish before placing focus inside More.
      await expect(page.locator(`[data-project-task-count="${projectId}"]`)).toHaveAttribute("data-loaded", "true")
      await openHierarchy(page, placement)
    })

    test.afterEach(async ({ request }) => {
      if (projectId) await removeFixtureEntity(request, `/api/projects/${projectId}`)
      if (areaId) await removeFixtureEntity(request, `/api/areas/${areaId}`)
    })

    test("Project Rename stays visible and Escape cancels without a delayed save", async ({ page, request }, testInfo) => {
      if (placement === "primary") test.setTimeout(60_000)
      const pageErrors: string[] = []
      page.on("pageerror", error => pageErrors.push(error.message))
      const trigger = page.locator(`[data-project-menu="${projectId}"]`)
      const row = trigger.locator("xpath=ancestor::div[contains(@class, 'stree__project')][1]")
      await expect(trigger).toBeVisible()
      expect(await trigger.evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))).toBe(placement === "More")
      if (placement === "primary") {
        await row.locator(`[data-project-id="${projectId}"]`).click({ button: "right" })
        await expect(page.locator(`#project-nav-pinned-list [data-project-id="${projectId}"]`)).toBeVisible()
      }
      await row.hover()
      await testInfo.attach("project-action-hit-targets.json", {
        body: JSON.stringify(await row.evaluate(element => [element, ...element.querySelectorAll("button, .stree__actions, .stree__count")].map(node => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return { tag: node.tagName, class: node.className, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, pointerEvents: style.pointerEvents, opacity: style.opacity }
        })), null, 2), contentType: "application/json",
      })
      await trigger.click()
      const menu = page.locator("body > #project-menu-dropdown")
      await expect(menu).toBeVisible()
      await menu.getByRole("button", { name: "Rename", exact: true }).click()
      const input = row.locator(".stree__inline-input")
      await expect(input).toBeVisible()
      await expect(input).toBeFocused()
      await input.fill(projectName + " must not save")
      const sameInput = await input.elementHandle()
      if (!sameInput) throw new Error("Expected the visible Project editor")
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("meitheal:view-changed")))
      await page.waitForTimeout(250)
      expect(await sameInput.evaluate(element => element.isConnected)).toBe(true)
      await expect(input).toBeVisible()
      await expect(input).toBeFocused()
      expect((await (await request.get(`/api/projects/${projectId}`)).json()).title).toBe(projectName)
      if (placement === "primary") {
        await page.setViewportSize({ width: 390, height: 1000 })
        await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "true")
        expect(await sameInput.evaluate(element => element.isConnected)).toBe(true)
        await expect(input).toBeVisible()
        await expect(input).toBeFocused()
        await page.waitForTimeout(250)
        expect((await (await request.get(`/api/projects/${projectId}`)).json()).title).toBe(projectName)
      }
      await input.press("Escape")
      await expect(input).toHaveCount(0)
      await expect(trigger).toBeFocused()
      if (placement === "primary") await page.setViewportSize({ width: 2200, height: 1000 })
      // The inline editor saves on blur after 100ms; cancellation must survive that timer.
      await page.waitForTimeout(250)
      const persisted = await request.get(`/api/projects/${projectId}`)
      expect(persisted.status()).toBe(200)
      expect((await persisted.json()).title).toBe(projectName)
      await expect(trigger).toBeVisible()
      await row.hover()
      await trigger.click()
      await expect(menu).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath("project-rename-cancelled.png") })
      await page.keyboard.press("Escape")
      await expect(trigger).toBeFocused()
      await expect(menu).toBeHidden()
      await expect(row).toBeVisible()
      await trigger.press("Enter")
      await expect(menu).toBeVisible()
      await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
      if (placement === "phone") {
        await page.keyboard.press("Shift+Tab")
        await expect(menu.locator("[data-action=\"delete\"]")).toBeFocused()
        await page.keyboard.press("Tab")
        await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
      }
      await page.keyboard.press("Tab")
      await expect(menu.getByRole("button", { name: "Rename", exact: true })).toBeFocused()
      await page.keyboard.press("Shift+Tab")
      await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(row).toBeVisible()
      if (placement === "primary") {
        await row.hover()
        await trigger.click()
        await menu.getByRole("button", { name: "Rename", exact: true }).click()
        await expect(input).toBeVisible()
        await expect(input).toBeFocused()
        const savedName = projectName + " saved"
        await input.fill(savedName)
        const saved = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}`)
          && response.request().method() === "PUT" && response.status() === 200)
        // A deliberate native click outside the editor must retain the existing blur-save behavior.
        await page.locator("[data-sidebar-boards-toggle]").click()
        await saved
        await expect(input).toHaveCount(0)
        expect((await (await request.get(`/api/projects/${projectId}`)).json()).title).toBe(savedName)
        projectName = savedName
        await openHierarchy(page)
        await expect(trigger).toHaveAttribute("aria-label", `Project options - ${savedName}`)
        await expect(page.locator(`#project-nav-pinned-list [data-project-id="${projectId}"] .stree__project-name`)).toHaveText(savedName)
        await row.hover()
        await trigger.click()
        await menu.getByRole("button", { name: "Rename", exact: true }).click()
        await expect(input).toHaveValue(savedName)
        await expect(input).toBeFocused()
        await input.press("Escape")
        await expect(input).toHaveCount(0)
        await expect(trigger).toBeFocused()
      }
      await row.hover()
      await checkColorIconEscape(page, trigger, menu, placement)
      if (placement === "primary") {
        await trigger.click()
        await menu.getByRole("button", { name: "Color & Icon", exact: true }).press("Enter")
        const popover = page.locator("body > #color-icon-popover")
        await expect(popover).toBeVisible()
        await popover.locator("[data-emoji-panel=\"0\"] [data-emoji-value=\"🚀\"]").click()
        const saved = page.waitForResponse(response => response.url().endsWith(`/api/projects/${projectId}`)
          && response.request().method() === "PUT" && response.status() === 200)
        await popover.locator("#color-icon-save").click()
        await saved
        await expect(popover).toBeHidden()
        expect((await (await request.get(`/api/projects/${projectId}`)).json()).icon).toBe("🚀")
        await expect(row.locator(".stree__project-icon use")).toHaveAttribute("href", "#mt-icon-rocket")
        await expect(page.locator(`#project-nav-pinned-list [data-project-id="${projectId}"] .stree__project-icon use`)).toHaveAttribute("href", "#mt-icon-rocket")
      }
      await row.hover()
      await trigger.click()
      const manage = menu.getByRole("link", { name: "Edit Project", exact: true })
      await expect(manage).toHaveAttribute("href", `/projects/${projectId}#settings`)
      await manage.click()
      // The existing legacy entry hands off to the canonical Board Project settings.
      await expect(page).toHaveURL(url => url.pathname === "/boards/household"
        && url.searchParams.get("project") === projectId && url.hash === "#project-settings")
      await expect(page.locator("#section-project-settings")).toBeVisible()
      await expect(page.locator("#edit-proj-title")).toHaveValue(projectName)
      await expect(page.locator("#save-proj-btn")).toBeVisible()
      await expect(page.locator("[data-sidebar-boards-toggle]")).toHaveAttribute("aria-expanded", "false")
      const moreAfterNavigation = page.locator("#sidebar [data-nav-overflow-more]")
      if (await moreAfterNavigation.count()) await expect(moreAfterNavigation).toHaveJSProperty("open", false)
      expect(pageErrors).toEqual([])
      if (placement === "primary") {
        await page.locator("#sidebar a[data-page=tasks]").click()
        await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
        await expect(page.locator("[data-inactivity-link]")).toBeVisible()
        await page.evaluate(() => Reflect.set(window, "navbarHierarchyReturnProbe", true))
        await page.locator("[data-inactivity-link]").click()
        await expect(page.locator("#sidebar")).toHaveCount(0)
        await page.locator("[data-inactivity-back]").click()
        await expect(page.locator("#sidebar")).toHaveCount(1)
        expect(await page.evaluate(() => Reflect.get(window, "navbarHierarchyReturnProbe"))).toBe(true)
        await openHierarchy(page, placement)
        await row.hover()
        await trigger.click()
        await expect(menu).toBeVisible()
        await menu.getByRole("button", { name: "Rename", exact: true }).click()
        await expect(input).toHaveValue(projectName)
        await expect(input).toBeFocused()
        await input.fill(projectName + " after return must not save")
        await input.press("Escape")
        await expect(input).toHaveCount(0)
        await expect(trigger).toBeFocused()
        await page.waitForTimeout(250)
        expect((await (await request.get(`/api/projects/${projectId}`)).json()).title).toBe(projectName)
        expect(pageErrors).toEqual([])
      }
    })

    test("Project Delete exposes its confirmation and dismissal preserves the Project", async ({ page, request }, testInfo) => {
      const trigger = page.locator(`[data-project-menu="${projectId}"]`)
      const row = trigger.locator("xpath=ancestor::div[contains(@class, 'stree__project')][1]")
      await expect(trigger).toBeVisible()
      expect(await trigger.evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))).toBe(placement === "More")
      if (placement === "primary") {
        await row.locator(`[data-project-id="${projectId}"]`).click({ button: "right" })
        await expect(page.locator(`#project-nav-pinned-list [data-project-id="${projectId}"]`)).toBeVisible()
      }
      await row.hover()
      await trigger.click()
      await page.locator("body > #project-menu-dropdown").getByRole("button", { name: "Delete Project", exact: true }).click()
      const confirmation = row.getByRole("button", { name: "Confirm Delete", exact: true })
      await expect(confirmation).toBeVisible()
      await expect(confirmation).toBeFocused()
      await page.screenshot({ path: testInfo.outputPath("project-delete-confirmation.png") })
      // Escape must cancel now, before the separate three-second expiry timer.
      await page.keyboard.press("Escape")
      await expect(confirmation).toHaveCount(0, { timeout: 1000 })
      await expect(trigger).toBeFocused()
      await expect(trigger).toBeVisible()
      await expectHierarchyOpen(page, trigger, placement)
      const persisted = await request.get(`/api/projects/${projectId}`)
      expect(persisted.status()).toBe(200)
      expect((await persisted.json()).title).toBe(projectName)
      // Focused destinations may move out of More so their opener remains visible.
      await openHierarchy(page)
      await expect(trigger).toBeVisible()
      if (placement === "primary") {
        await row.hover()
        await trigger.click()
        await page.locator("body > #project-menu-dropdown").getByRole("button", { name: "Delete Project", exact: true }).click()
        await expect(confirmation).toBeVisible()
        await expect(confirmation).toBeFocused()
        // Independently exercise automatic expiry without pressing Escape.
        await expect(confirmation).toHaveCount(0, { timeout: 4000 })
        await expect(trigger).toBeFocused()
        await expect(trigger).toBeVisible()
        const afterExpiry = await request.get(`/api/projects/${projectId}`)
        expect(afterExpiry.status()).toBe(200)
        expect((await afterExpiry.json()).title).toBe(projectName)
      }
    })

    test("Area Rename stays visible and Escape cancels without a delayed save", async ({ page, request }, testInfo) => {
      const trigger = page.locator(`[data-area-menu="${areaId}"]`)
      const row = page.locator(`[data-area-group="${areaId}"] > .stree__area-row`)
      await expect(trigger).toBeVisible()
      expect(await trigger.evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))).toBe(placement === "More")
      await row.hover()
      await trigger.click()
      const menu = page.locator("body > #area-menu-dropdown")
      await expect(menu).toBeVisible()
      await menu.getByRole("button", { name: "Rename", exact: true }).click()
      const input = row.locator(".stree__inline-input")
      await expect(input).toBeVisible()
      await expect(input).toBeFocused()
      await input.fill(areaName + " must not save")
      const sameInput = await input.elementHandle()
      if (!sameInput) throw new Error("Expected the visible Area editor")
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("meitheal:view-changed")))
      await page.waitForTimeout(250)
      expect(await sameInput.evaluate(element => element.isConnected)).toBe(true)
      await expect(input).toBeVisible()
      await expect(input).toBeFocused()
      expect((await (await request.get(`/api/areas/${areaId}`)).json()).name).toBe(areaName)
      await input.press("Escape")
      await expect(input).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await page.waitForTimeout(250)
      const persisted = await request.get(`/api/areas/${areaId}`)
      expect(persisted.status()).toBe(200)
      expect((await persisted.json()).name).toBe(areaName)
      await expect(trigger).toBeVisible()
      await row.hover()
      await trigger.click()
      await expect(menu).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath("area-rename-cancelled.png") })
      await page.keyboard.press("Escape")
      await expect(trigger).toBeFocused()
      await expect(menu).toBeHidden()
      await expect(row).toBeVisible()
      await trigger.press("Enter")
      await expect(menu).toBeVisible()
      await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
      if (placement === "phone") {
        await page.keyboard.press("Shift+Tab")
        await expect(menu.locator("[data-action=\"delete\"]")).toBeFocused()
        await page.keyboard.press("Tab")
        await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
      }
      await page.keyboard.press("Tab")
      await expect(menu.getByRole("button", { name: "Rename", exact: true })).toBeFocused()
      await page.keyboard.press("Shift+Tab")
      await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
      await page.keyboard.press("Escape")
      await expect(menu).toBeHidden()
      await expect(trigger).toBeFocused()
      await expect(row).toBeVisible()
      await row.hover()
      await checkColorIconEscape(page, trigger, menu, placement)
      if (placement === "primary") {
        const posts: string[] = []
        page.on("request", request => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/api/projects") posts.push(request.url())
        })
        const create = page.locator(`[data-area-add="${areaId}"]`)
        await row.hover()
        await create.click()
        const creationInput = page.locator(`[data-area-projects="${areaId}"] > .stree__inline-input`)
        await expect(creationInput).toBeVisible()
        await expect(creationInput).toBeFocused()
        await creationInput.fill(projectName + " must not create")
        await creationInput.press("Escape")
        await expect(creationInput).toHaveCount(0)
        await expect(create).toBeFocused()
        await page.waitForTimeout(250)
        expect(posts).toEqual([])
        let insertedProjectId: string | undefined
        try {
          await create.click()
          await expect(creationInput).toBeFocused()
          await creationInput.fill(projectName + " inserted for Add Task")
          const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/projects"
            && response.request().method() === "POST" && response.status() === 201)
          await creationInput.press("Enter")
          insertedProjectId = (await (await created).json()).id
          const inserted = page.locator(`#project-nav-list [data-project-id="${insertedProjectId}"]`).locator("xpath=ancestor::div[contains(@class, 'stree__project')][1]")
          await expect(inserted).toBeVisible()
          await inserted.hover()
          const addTask = inserted.locator("[data-task-add-project]")
          await expect(addTask).toBeVisible()
          await addTask.press("Enter")
          const chooser = page.locator("body > #task-kind-dropdown")
          await expect(chooser).toBeVisible()
          const taskKind = chooser.getByRole("button", { name: "Task", exact: true })
          await expect(taskKind).toBeFocused()
          await taskKind.press("Enter")
          const taskInput = inserted.locator(".stree__inline-input")
          await expect(taskInput).toBeVisible()
          await expect(taskInput).toBeFocused()
          const taskPosts: string[] = []
          page.on("request", request => {
            if (request.method() === "POST" && new URL(request.url()).pathname === "/api/tasks") taskPosts.push(request.url())
          })
          await taskInput.fill("Newly inserted Project task must not create")
          await taskInput.press("Escape")
          await expect(taskInput).toHaveCount(0)
          await expect(addTask).toBeFocused()
          await page.waitForTimeout(250)
          expect(taskPosts).toEqual([])
        } finally {
          if (insertedProjectId) await removeFixtureEntity(request, `/api/projects/${insertedProjectId}`)
        }
        await row.hover()
        await trigger.press("Enter")
        await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
        await page.setViewportSize({ width: 390, height: 1000 })
        await expect(menu).toBeHidden()
        const drawer = page.locator("#menu-toggle")
        await expect(drawer).toBeFocused()
        await expect(drawer).toBeVisible()
        await drawer.click()
        await expect(drawer).toHaveAttribute("aria-expanded", "true")
        await expect(page.locator(`[data-area-toggle="${areaId}"]`)).toBeVisible()
      }
      if (placement === "phone") {
        await trigger.press("Enter")
        await expect(menu.locator("[data-action=\"manage\"]")).toBeFocused()
        await page.setViewportSize({ width: 769, height: 1000 })
        await expect(menu).toBeHidden()
        await expect(trigger).toBeFocused()
        await expect(trigger).toBeVisible()
        const geometryPath = testInfo.outputPath("resize-trigger-geometry.json")
        await writeFile(geometryPath, JSON.stringify(await trigger.evaluate(element => {
            const rect = element.getBoundingClientRect()
            const nodes: Element[] = []
            for (let node: Element | null = element; node; node = node.parentElement) nodes.push(node)
            return {
              viewport: { width: innerWidth, height: innerHeight },
              centerHitsTrigger: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)),
              ancestors: nodes.map(node => {
                const box = node.getBoundingClientRect()
                const style = getComputedStyle(node)
                return { tag: node.tagName, id: node.id, class: node.className,
                  rect: { x: box.x, y: box.y, width: box.width, height: box.height },
                  overflowX: style.overflowX, overflowY: style.overflowY,
                  borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth }
              }),
            }
          }), null, 2))
        await testInfo.attach("resize-trigger-geometry.json", { path: geometryPath, contentType: "application/json" })
        await expect(trigger).toBeInViewport({ ratio: 1 })
        if (await trigger.evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))) {
          await expect(page.locator("#sidebar [data-nav-overflow-more]")).toHaveJSProperty("open", true)
        }
      }
      if (placement === "More") {
        const project = page.locator(`#project-nav-list [data-project-id="${projectId}"]`)
        await expect(project).toBeVisible()
        await project.focus()
        await expect(project).toBeFocused()
        const handoffPath = testInfo.outputPath("ordinary-link-resize-start.json")
        await writeFile(handoffPath, JSON.stringify(await project.evaluate(element => ({
          focused: document.activeElement === element,
          viewport: { width: innerWidth, height: innerHeight },
          insideMore: Boolean(element.closest("[data-nav-overflow-menu]")),
          boardsExpanded: document.querySelector("[data-sidebar-boards-toggle]")?.getAttribute("aria-expanded"),
          areasOpen: (document.querySelector("#sidebar-areas-group") as HTMLDetailsElement | null)?.open,
        })), null, 2))
        await testInfo.attach("ordinary-link-resize-start.json", { path: handoffPath, contentType: "application/json" })
        await page.setViewportSize({ width: 390, height: 1000 })
        await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "true")
        await expect(project).toBeFocused()
        await expect(project).toBeVisible()
        await expect(project).toBeInViewport({ ratio: 1 })
      }
    })

    test("keyboard Unpin preserves the remaining pinned row or the original Project context", async ({ page, request }) => {
      let secondProjectId: string | undefined
      try {
        const headers = await currentBoardWriteHeaders(request, "household", {})
        const second = await request.post("/api/projects", { headers, data: { title: projectName + " second", area_id: areaId } })
        expect(second.status()).toBe(201)
        secondProjectId = (await second.json()).id
        const original = (id: string) => page.locator(`#project-nav-list [data-project-id="${id}"]`)
        const pinned = (id: string) => page.locator(`#project-nav-pinned-list [data-project-id="${id}"]`)
        const unpin = (id: string) => pinned(id).locator("xpath=..").getByRole("button", { name: "Unpin project", exact: true })
        const refresh = async () => {
          await page.reload()
          if (placement === "More") {
            // A genuinely crowded navbar keeps this action in More even when its row receives focus.
            await page.addStyleTag({ content: "#sidebar [data-nav-overflow=\"sidebar\"] { max-width: 180px; }" })
          }
          await expect(page.locator(`[data-project-task-count="${projectId}"]`)).toHaveAttribute("data-loaded", "true")
          await expect(page.locator(`[data-project-task-count="${secondProjectId}"]`)).toHaveAttribute("data-loaded", "true")
          await openHierarchy(page, placement)
        }
        await refresh()
        await original(projectId).click({ button: "right" })
        await expect(pinned(projectId)).toBeVisible()
        await refresh()
        expect(await pinned(projectId).evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))).toBe(placement === "More")
        await expect(pinned(projectId).locator("button")).toHaveCount(0)
        await expect(unpin(projectId)).toBeVisible()
        await pinned(projectId).focus()
        await page.keyboard.press("Tab")
        await expect(unpin(projectId)).toBeFocused()
        expect(await unpin(projectId).evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))).toBe(placement === "More")
        await page.keyboard.press("Enter")
        await expect(pinned(projectId)).toHaveCount(0)
        await expect(original(projectId)).toBeFocused()
        await expect(original(projectId)).toBeVisible()

        await original(projectId).click({ button: "right" })
        await original(secondProjectId!).click({ button: "right" })
        await expect(pinned(projectId)).toBeVisible()
        await expect(pinned(secondProjectId!)).toBeVisible()
        await refresh()
        await pinned(secondProjectId!).focus()
        await page.keyboard.press("Tab")
        await expect(unpin(secondProjectId!)).toBeFocused()
        expect(await unpin(secondProjectId!).evaluate(element => Boolean(element.closest("[data-nav-overflow-menu]")))).toBe(placement === "More")
        await page.keyboard.press("Enter")
        await expect(pinned(secondProjectId!)).toHaveCount(0)
        await expect(unpin(projectId)).toBeFocused()
        await expect(unpin(projectId)).toBeVisible()
        await original(secondProjectId!).click({ button: "right" })
        await expect(pinned(secondProjectId!)).toBeVisible()
        await unpin(projectId).press("Enter")
        await expect(pinned(projectId)).toHaveCount(0)
        await expect(unpin(secondProjectId!)).toBeFocused()
        await expect(unpin(secondProjectId!)).toBeVisible()
        await unpin(secondProjectId!).press("Enter")
        await expect(pinned(secondProjectId!)).toHaveCount(0)
        await expect(original(secondProjectId!)).toBeFocused()
        await expect(original(secondProjectId!)).toBeVisible()
      } finally {
        if (secondProjectId) await removeFixtureEntity(request, `/api/projects/${secondProjectId}`)
      }
    })
  })
}
