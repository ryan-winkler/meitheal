import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test("global N opens canonical capture while the navbar hierarchy is collapsed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("meitheal-appearance", JSON.stringify({ navigation: "navbar" }))
    sessionStorage.setItem("meitheal-boards-collapsed", "true")
  })
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto("/settings#navigation-settings")
  await page.getByRole("checkbox", { name: "Enable letter, number and symbol shortcuts on this device" }).check()
  const boards = page.locator("[data-sidebar-boards-toggle]")
  await expect(boards).toHaveAttribute("aria-expanded", "false")
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press("n")
  const capture = page.locator("#new-task-overlay")
  await expect(capture).toBeVisible()
  await expect(page.locator("#new-task-title-input")).toBeFocused()
  await expect(page.locator("#task-kind-dropdown")).toBeHidden()
  await expect(page.locator(".stree__inline-input")).toHaveCount(0)
  await expect(boards).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("Escape")
  await expect(capture).toBeHidden()
})

