import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable local Meitheal server")

test("a short first section hands over to a tall section after it leaves the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/?view=dashboard")
  await expect(page.locator("#dashboard-shell")).toHaveAttribute("data-dashboard-booted", "true")
  const [first, second] = await page.locator("#dashboard-shell > [data-dashboard-section]:not([hidden])")
    .evaluateAll(nodes => nodes.slice(0, 2).map(node => node.id))
  // A 430px first section and a 2000px second one keep the second below the observer threshold.
  await page.evaluate(([short, tall]) => {
    Object.assign(document.getElementById(short)!.style, { height: "430px", overflow: "hidden" })
    Object.assign(document.getElementById(tall)!.style, { minHeight: "2000px" })
  }, [first!, second!])
  const tab = (id: string) => page.locator(`#dashboard-bar-tabs [data-unified-bar-section="${id}"]`)
  await expect(tab(first!)).toHaveClass(/is-active/)

  // Leave the top by 1px, then scroll the short section out of view without returning to the top.
  await page.evaluate(() => window.scrollTo(0, 1))
  await expect(tab(first!)).toHaveClass(/is-active/)
  await page.evaluate(id => {
    const bottom = document.getElementById(id)!.getBoundingClientRect().bottom + window.scrollY
    window.scrollTo(0, bottom + 1)
  }, first!)
  await expect(tab(second!)).toHaveClass(/is-active/)
  await expect(tab(first!)).not.toHaveClass(/is-active/)
})
