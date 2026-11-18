import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test("the numbered shortcut labels remain reachable in Irish on a short screen", async ({ page, context, baseURL }) => {
  await context.addCookies([{ name: "meitheal-locale", value: "ga", url: baseURL! }])
  await page.setViewportSize({ width: 320, height: 300 })
  await page.goto("/tasks#kanban")
  await expect(page.locator("[data-view-tabs]")).toHaveAttribute("data-switcher-ready", "true")
  await page.keyboard.press("?")
  const dialog = page.getByRole("dialog", { name: "Aicearraí méarchláir", exact: true })
  const close = dialog.getByRole("button", { name: "Dún na haicearraí" })
  const panel = dialog.locator(".shortcut-modal-content")
  await expect(close).toBeFocused()
  await expect(dialog.getByRole("heading", { name: "I ngach áit" })).toBeVisible()
  await expect(dialog.getByRole("heading", { name: "Ar leathanach na dtascanna" })).toBeVisible()
  await expect(dialog.locator("[data-shortcut-scope=global]")).toHaveText([
    "Cuardaigh", "Tasc nua . Cuireann sé leis an gcolún sin nuair atá fócas ar chárta boird", "Deais",
    "Amharc Kanban . Bogann sé suas ar Inniu agus ar an Amlíne", "Amharc tábla", "Amharc Inniu", "Amharc Ag Teacht",
    "Amharc féilire . Laghdaíonn sé na lánaí snámha nuair atá fócas ar chárta boird grúpáilte", "Pailéad orduithe",
    "Taispeáin nó folaigh an barra taoibh . Scáileáin leathana le nascleanúint taoibh", "Taispeáin aicearraí", "Dún an bosca dialóige",
  ])
  await expect(dialog.locator("[data-shortcut-scope=tasks]")).toHaveText([
    "Amharc Kanban", "Amharc tábla", "Amharc féilire", "Amharc amlíne",
  ])
  const bounds = await panel.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + 5, bounds!.y + 5)
  await page.mouse.down()
  try {
    await expect(close).toBeFocused()
  } finally {
    await page.mouse.up()
  }
  const timeline = dialog.getByText("Amharc amlíne")
  await expect(timeline).not.toBeInViewport()
  await page.evaluate(() => document.fonts.ready)
  // Reaching the final pixel can precede native scrolling's completion.
  const endScrollCompleted = panel.evaluate(element => new Promise<void>(resolve => {
    element.addEventListener("scrollend", () => resolve(), { once: true })
  }))
  await page.keyboard.press("End")
  await expect(timeline).toBeInViewport()
  await expect.poll(() => panel.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(1)
  await endScrollCompleted
  const homeScrollCompleted = panel.evaluate(element => new Promise<void>(resolve => {
    element.addEventListener("scrollend", () => resolve(), { once: true })
  }))
  await page.keyboard.press("Home")
  await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBe(0)
  await expect(timeline).not.toBeInViewport()
  await homeScrollCompleted
  await panel.hover()
  await page.mouse.wheel(0, 2000)
  await expect(timeline).toBeInViewport()
})

