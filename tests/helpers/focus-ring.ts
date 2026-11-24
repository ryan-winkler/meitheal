import { expect, type Locator } from "@playwright/test"

/**
 * The focus ring follows a readable version of the personal accent, so tests
 * check that it stays visible (WCAG 2.4.11, 3:1 against the page) instead of
 * pinning one palette color.
 */
export async function expectVisibleFocusRing(target: Locator): Promise<void> {
  await expect(target).toHaveCSS("outline-style", "solid")
  const ratio = await target.evaluate(element => {
    const context = document.createElement("canvas").getContext("2d")!
    const luminance = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const [r, g, b] = Array.from(context.getImageData(0, 0, 1, 1).data, value => {
        const fraction = value / 255
        return fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
    }
    const ring = luminance(getComputedStyle(element).outlineColor)
    const page = luminance(getComputedStyle(document.body).backgroundColor)
    return (Math.max(ring, page) + 0.05) / (Math.min(ring, page) + 0.05)
  })
  expect(ratio).toBeGreaterThanOrEqual(3)
}
