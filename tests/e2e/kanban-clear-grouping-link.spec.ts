import { expect, test } from "@playwright/test"
import { shouldSkipBrowserSpecs } from "./_helpers"

test("an explicit No grouping link overrides the receiving browser's saved preference", async ({ page, browser }) => {
  test.skip(shouldSkipBrowserSpecs() || process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")
  const context = await browser.newContext()
  try {
    await page.goto("/tasks?groupBy=type#kanban")
    await expect(page.locator("#kanban-shell")).toHaveAttribute("data-kanban-booted", "true")
    const grouping = page.locator("#kanban-group-by-dropdown")
    await grouping.locator("summary").click()
    await grouping.getByRole("button", { name: "No grouping" }).click()
    await expect(page).toHaveURL(/groupBy=none/)

    const receiver = await context.newPage()
    await receiver.addInitScript(() => {
      localStorage.setItem("meitheal-kanban-group-by", "type")
    })
    await receiver.goto(page.url())
    const board = receiver.locator("#kanban-board")
    await expect(board).toHaveAttribute("data-group-by", "none")
    await receiver.getByRole("textbox", { name: "Filter by text" }).fill("Shared flat board")
    await expect(receiver).toHaveURL(/search=Shared\+flat\+board/)
    expect(new URL(receiver.url()).searchParams.get("groupBy")).toBe("none")
    await receiver.reload()
    await expect(board).toHaveAttribute("data-group-by", "none")
  } finally {
    await context.close()
  }
})
