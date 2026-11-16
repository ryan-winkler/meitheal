import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

test("recreated sidebar restores pinned links and binds Tasks controls once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto("/tasks")

  const taskMenu = page.locator("#tasks-submenu-toggle")
  const creationMenu = page.locator("#sidebar-task-types [data-task-creation-toggle]")
  const pinnedView = page.locator('[data-task-view-pinned-item="calendar"]')
  const pinnedType = page.locator('#sidebar-task-types [data-task-nav-pinned-item="calendar_event"]')
  await taskMenu.click()
  await page.locator('#tasks-nav-submenu [data-task-view-pin="calendar"]').click()
  await expect(pinnedView).toBeVisible()
  await taskMenu.click()
  await creationMenu.click()
  await page.locator('#sidebar-task-types [data-task-creation-options] [data-task-nav-pin="calendar_event"]').click()
  await expect(pinnedType).toBeVisible()
  await creationMenu.click()

  await page.evaluate(() => Reflect.set(window, "sidebarReplacementProbe", true))
  await page.locator("[data-inactivity-link]").click()
  await expect(page.locator("#sidebar")).toHaveCount(0)
  await page.locator("[data-inactivity-back]").click()

  await expect(pinnedView).toBeVisible()
  await expect(pinnedType).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, "sidebarReplacementProbe"))).toBe(true)
  await taskMenu.click()
  await expect(taskMenu).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator("#tasks-nav-submenu")).toBeVisible()
  await page.keyboard.press("Escape")
  await creationMenu.click()
  await expect(creationMenu).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator("#sidebar-task-types [data-task-creation-options]")).toBeVisible()
  await page.keyboard.press("Escape")

  const edge = page.locator("#sidebar-edge-toggle")
  const top = page.locator("#sidebar-toggle-btn")
  for (const collapsed of [true, false]) {
    await edge.click()
    const label = `${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`
    for (const toggle of [edge, top]) {
      await expect(toggle).toHaveAttribute("aria-expanded", String(!collapsed))
      await expect(toggle).toHaveAttribute("aria-label", label)
      await expect(toggle).toHaveAttribute("title", label)
    }
  }
})
