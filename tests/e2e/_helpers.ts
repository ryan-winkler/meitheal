import { expect, type Page } from "@playwright/test"

export function shouldSkipBrowserSpecs(): boolean {
  return !process.env.E2E_BASE_URL;
}

export function readScopedNavigation(page: Page) {
  return page.evaluate(() => {
    const scope = document.documentElement.dataset.workspaceScope
    if (!scope) throw new Error("Expected an account-scoped workspace")
    return JSON.parse(sessionStorage.getItem("meitheal-navigation-state:" + scope) ?? "null")
  })
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

export async function openHouseholdAreas(page: Page) {
  const boards = page.locator("[data-sidebar-boards-toggle]")
  if (await boards.getAttribute("aria-expanded") !== "true") await boards.press("Enter")
  const household = page.locator('[data-named-board-shortcut="household"]')
  const areas = household.getByRole("button", { name: "Areas in Household" })
  if (await areas.getAttribute("aria-expanded") !== "true") await areas.press("Enter")
  await expect(areas).toHaveAttribute("aria-expanded", "true")
  return household
}
