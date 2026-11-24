import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { openHouseholdAreas, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

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
