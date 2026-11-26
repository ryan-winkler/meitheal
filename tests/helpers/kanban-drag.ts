import { expect, type Locator, type Page } from "@playwright/test"

export async function moveCardToLane(page: Page, card: Locator, lane: Locator, checkHover?: () => Promise<void>) {
  await expect(page.locator("#kanban-board")).toHaveAttribute("data-sorting-ready", "true")
  const title = card.locator(".kanban-title-text")
  const list = lane.locator(".kanban-cards")
  await title.scrollIntoViewIfNeeded()
  await list.scrollIntoViewIfNeeded()
  const start = (await title.boundingBox())!
  const target = (await list.boundingBox())!
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  try {
    await page.mouse.move(target.x + target.width / 2, target.y + Math.min(20, target.height / 2), { steps: 18 })
    await expect(lane).toHaveClass(/drag-over/)
    await checkHover?.()
  } finally {
    await page.mouse.up()
  }
}
