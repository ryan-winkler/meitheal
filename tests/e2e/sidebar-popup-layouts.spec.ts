import { expect, test, type APIRequestContext, type Page } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

const configuredOrigin = process.env.E2E_BASE_URL ? new URL(process.env.E2E_BASE_URL) : null
const localFixture = configuredOrigin && ["127.0.0.1", "localhost", "[::1]"].includes(configuredOrigin.hostname)
test.skip(shouldSkipBrowserSpecs() || !localFixture, "Run against a disposable loopback fixture")
test.use({
  serviceWorkers: "block", trace: "retain-on-failure",
  ...(localFixture ? { extraHTTPHeaders: { origin: configuredOrigin.origin } } : {}),
})

type EntityKind = "area" | "project"
let areaId = ""
let projectId = ""
let areaName = ""
let projectName = ""

async function removeFixtureEntity(request: APIRequestContext, path: string) {
  const response = await request.delete(path, { data: {} })
  expect(response.status()).toBe(200)
}

async function openHierarchy(page: Page) {
  const boards = page.locator("[data-sidebar-boards-toggle]")
  if (await boards.getAttribute("aria-expanded") !== "true") await boards.click()
  const areas = page.locator("#sidebar-areas-group")
  if (!(await areas.evaluate(element => (element as HTMLDetailsElement).open))) {
    await areas.locator(":scope > summary").click()
  }
  await expect(boards).toHaveAttribute("aria-expanded", "true")
  await expect(areas).toHaveJSProperty("open", true)
}

async function keyboardOptions(page: Page, kind: EntityKind, id: string) {
  const anchor = page.locator(kind === "area" ? `[data-area-toggle="${id}"]` : `#project-nav-list [data-project-id="${id}"]`)
  const trigger = page.locator(`[data-${kind}-menu="${id}"]`)
  await expect(anchor).toBeVisible()
  await anchor.scrollIntoViewIfNeeded()
  await anchor.focus()
  await expect(anchor).toBeFocused()
  await expect(trigger.locator("xpath=..")).toHaveCSS("opacity", "1")
  await expect(trigger).toBeVisible()
  await trigger.scrollIntoViewIfNeeded()
  await expect(trigger).toBeInViewport({ ratio: 1 })
  await trigger.focus()
  await expect(trigger).toBeFocused()
  await page.keyboard.press("Enter")
  const menu = page.locator(`body > #${kind}-menu-dropdown`)
  await expect(menu).toBeVisible()
  await expect(menu.locator("[data-action=manage]")).toBeFocused()
  return { trigger, menu }
}

test.beforeEach(async ({ request }) => {
  areaId = ""
  projectId = ""
  const suffix = crypto.randomUUID().slice(0, 8)
  areaName = `Popup layout Area ${suffix}`
  projectName = `Popup layout Project ${suffix}`
  const area = await request.post("/api/areas", { data: { name: areaName } })
  expect(area.status()).toBe(201)
  areaId = (await area.json()).id
  const project = await request.post("/api/projects", { data: { title: projectName, area_id: areaId } })
  expect(project.status()).toBe(201)
  projectId = (await project.json()).id
})

test.afterEach(async ({ request }) => {
  if (projectId) await removeFixtureEntity(request, `/api/projects/${projectId}`)
  if (areaId) await removeFixtureEntity(request, `/api/areas/${areaId}`)
})

test("hover sidebar remains expanded for its body popups and collapses when focus leaves them", async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "sidebar", sidebar: "hover" }))
  })
  await page.goto("/tasks")
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  await expect(page.locator(`[data-project-task-count="${projectId}"]`)).toHaveAttribute("data-loaded", "true")
  const body = page.locator("body")
  await expect(body).toHaveClass(/sidebar-collapsed/)
  const boardsLink = page.locator("#sidebar a[data-page=boards]")
  await expect(boardsLink).toBeVisible()
  await boardsLink.focus()
  await expect(body).not.toHaveClass(/sidebar-collapsed/)
  await page.mouse.move(1100, 700)
  await openHierarchy(page)

  for (const [kind, id, name] of [["area", areaId, areaName], ["project", projectId, projectName]] as const) {
    const { trigger, menu } = await keyboardOptions(page, kind, id)
    await page.screenshot({ path: testInfo.outputPath(`hover-${kind}-menu.png`) })
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    await menu.getByRole("button", { name: "Rename", exact: true }).press("Enter")
    const input = page.locator(kind === "area"
      ? `[data-area-group="${id}"] > .stree__area-row > .stree__inline-input`
      : `#project-nav-list .stree__project:has([data-project-id="${id}"]) > .stree__inline-input`)
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()
    await input.fill(name + " must not save")
    await page.keyboard.press("Escape")
    await expect(input).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await expect(body).not.toHaveClass(/sidebar-collapsed/)
    await page.waitForTimeout(250)
    const persisted = await request.get(`/api/${kind === "area" ? "areas" : "projects"}/${id}`)
    expect(persisted.status()).toBe(200)
    expect((await persisted.json())[kind === "area" ? "name" : "title"]).toBe(name)
  }

  const projectLink = page.locator(`#project-nav-list [data-project-id="${projectId}"]`)
  await projectLink.focus()
  const addTask = page.locator(`[data-task-add-project="${projectId}"]`)
  await expect(addTask).toBeVisible()
  await addTask.focus()
  await expect(addTask).toBeFocused()
  await page.keyboard.press("Enter")
  const kinds = page.locator("body > #task-kind-dropdown")
  await expect(kinds).toBeVisible()
  await expect(kinds.getByRole("button", { name: "Task", exact: true })).toBeFocused()
  await expect(body).not.toHaveClass(/sidebar-collapsed/)
  await page.keyboard.press("Escape")
  await expect(kinds).toBeHidden()
  await expect(addTask).toBeFocused()

  const { menu } = await keyboardOptions(page, "project", projectId)
  await menu.getByRole("button", { name: "Color & Icon", exact: true }).press("Enter")
  const popover = page.locator("body > #color-icon-popover")
  await expect(popover).toBeVisible()
  await expect(popover.locator("[data-emoji-tab]").first()).toBeFocused()
  await expect(body).not.toHaveClass(/sidebar-collapsed/)
  const mainText = page.getByRole("textbox", { name: "Filter by text", exact: true })
  await expect(mainText).toBeVisible()
  await mainText.focus()
  await expect(mainText).toBeFocused()
  await expect(body).toHaveClass(/sidebar-collapsed/)
})

test("short phone Color and Icon popovers fit and expose category focus and Save", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 740, height: 320 })
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "sidebar", sidebar: "expanded" }))
  })
  await page.goto("/tasks")
  await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
  const drawer = page.locator("#menu-toggle")
  await drawer.click()
  await expect(drawer).toHaveAttribute("aria-expanded", "true")
  await openHierarchy(page)

  for (const [kind, id] of [["area", areaId], ["project", projectId]] as const) {
    const { trigger, menu } = await keyboardOptions(page, kind, id)
    await menu.getByRole("button", { name: "Color & Icon", exact: true }).press("Enter")
    const popover = page.locator("body > #color-icon-popover")
    await expect(popover).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`short-${kind}-popover.png`) })
    await expect.poll(async () => {
      const rect = await popover.boundingBox()
      const viewport = page.viewportSize()!
      return Boolean(rect && rect.x >= 0 && rect.y >= 0
        && rect.x + rect.width <= viewport.width && rect.y + rect.height <= viewport.height)
    }).toBe(true)
    await expect(popover.locator("[data-emoji-tab]").first()).toBeFocused()
    await expect(popover.locator("[data-emoji-tab]").first()).toBeInViewport({ ratio: 1 })
    const save = popover.locator("#color-icon-save")
    for (let step = 0; step < 96 && !(await save.evaluate(element => document.activeElement === element)); step++) {
      await page.keyboard.press("Tab")
    }
    await expect(save).toBeFocused()
    await expect(save).toBeInViewport({ ratio: 1 })
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === `/api/${kind === "area" ? "areas" : "projects"}/${id}`
      && response.request().method() === "PUT" && response.status() === 200)
    await save.click()
    await saved
    await expect(popover).toBeHidden()

    const reopened = await keyboardOptions(page, kind, id)
    await reopened.menu.getByRole("button", { name: "Color & Icon", exact: true }).press("Enter")
    await expect(popover.locator("[data-emoji-tab]").first()).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(popover).toBeHidden()
    await expect(trigger).toBeFocused()
    await expect(trigger).toBeVisible()
    await expect(drawer).toHaveAttribute("aria-expanded", "true")
  }
})
