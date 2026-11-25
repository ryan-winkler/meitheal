import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Requires a disposable App server")
test.use({ serviceWorkers: "block", reducedMotion: "reduce" })

for (const [path, finish] of [["/boards/household#kanban", false], ["/today", true]] as const) {
  test(`Tour ${finish ? "finish" : "skip"} keeps the workspace layout on ${path}`, async ({ page }) => {
    await page.goto(path)
    const workspace = page.locator("main")
    const before = await workspace.boundingBox()
    const utility = page.locator("#nav-utility-trigger")
    async function openTour() {
      await utility.click()
      await page.getByRole("menuitem", { name: "Interactive tour" }).click()
    }

    await openTour()
    const tour = page.locator("[data-tabler-tour-root]").getByRole("dialog")
    await expect(tour).toBeVisible()
    if (finish) {
      for (let step = 0; step < 4; step++) {
        await expect(tour.getByRole("heading")).not.toContainText("profile")
        const next = tour.getByRole("button", { name: "Next", exact: true })
        if (!(await next.isVisible())) break
        await next.click()
      }
      await tour.getByRole("button", { name: "Finish" }).click()
    } else {
      await tour.getByRole("button", { name: "Skip tour" }).click()
    }

    await expect(tour).toHaveCount(0)
    await expect(page.locator("#toast-container").getByText(finish ? "Tour complete" : "Tour dismissed", { exact: true })).toBeVisible()
    await expect(utility).toBeFocused()
    expect(await workspace.boundingBox()).toEqual(before)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("meitheal-function-tour-state:v1")!).status))
      .toBe(finish ? "completed" : "dismissed")

    await page.reload()
    await expect(tour).toHaveCount(0)
    await openTour()
    await expect(tour.getByText(/^Step 1 of [1-4]$/)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(tour).toHaveCount(0)
    await expect(utility).toBeFocused()
  })
}
