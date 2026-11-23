import { expect, type Page } from "@playwright/test"

/**
 * Commits the Look and Feel draft. Theme, accent and appearance choices only
 * preview until saved. Pass `theme: true` when the draft changes the theme,
 * which is the one choice stored on the server.
 */
export async function saveAppearance(page: Page, { theme = false } = {}): Promise<void> {
  const saved = theme
    ? page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api/settings")
      && response.request().method() === "PUT" && response.request().postDataJSON()?.key === "theme")
    : null
  await page.locator("#appearance-save-btn").click()
  if (saved) expect((await saved).ok()).toBe(true)
  await expect(page.locator("#appearance-dirty-bar")).toBeHidden()
}
