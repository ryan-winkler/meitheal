import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")
test.use({ serviceWorkers: "block" })

test("recreated sidebar restores pinned links and binds Tasks controls once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.goto("/tasks")

  const taskMenu = page.locator("#tasks-submenu-toggle")
  const settings = page.locator("#tasks-submenu-config-btn")
  const pinned = page.locator('[data-task-nav-pinned-item="calendar_event"]')
  await settings.click()
  await page.locator('#tasks-nav-config-popover [data-task-nav-pin="calendar_event"]').click()
  await expect(pinned).toBeVisible()
  await expect(page.locator('.nav-item--tasks + [data-task-nav-pinned-item="calendar_event"]')).toBeVisible()
  await settings.click()

  await page.evaluate(() => Reflect.set(window, "sidebarReplacementProbe", true))
  await page.locator("[data-inactivity-link]").click()
  await expect(page.locator("#sidebar")).toHaveCount(0)
  await page.locator("[data-inactivity-back]").click()

  await expect(pinned).toBeVisible()
  expect(await page.evaluate(() => Reflect.get(window, "sidebarReplacementProbe"))).toBe(true)
  await taskMenu.click()
  await expect(taskMenu).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator("#tasks-nav-submenu")).toBeVisible()
  await settings.click()
  await expect(settings).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator("#tasks-nav-config-popover")).toBeVisible()
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
