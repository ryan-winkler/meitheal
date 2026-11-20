import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { openHouseholdAreas, shouldSkipBrowserSpecs } from "./_helpers"

test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs")

test("empty area hints stay readable in both themes", async ({ browser, request, baseURL }) => {
  const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
  const area = await request.post("/api/areas", { headers, data: { name: "Empty area contrast fixture" } })
  expect(area.status()).toBe(201)
  const { id } = await area.json()
  const selector = `[data-board-projects="${id}"] > [data-board-group-status]`

  try {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "reduce" })
      try {
        const page = await context.newPage()
        await page.addInitScript(value => localStorage.setItem("meitheal-theme", value), theme)
        await page.goto(new URL("/today", baseURL!).href)
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
        const household = await openHouseholdAreas(page)
        const projects = page.waitForResponse(response => {
          const url = new URL(response.url())
          return response.request().method() === "GET" && url.pathname === "/api/boards/household" &&
            url.searchParams.get("view") === "groups" && url.searchParams.get("area") === id
        })
        await household.getByRole("button", { name: "Projects in Empty area contrast fixture" }).press("Enter")
        expect((await projects).status(), "Load Projects for the fixture Area").toBe(200)
        await expect(page.locator(selector)).toBeVisible()
        await expect(page.locator(selector)).toHaveText("No Projects yet")
        const { violations } = await new AxeBuilder({ page }).include(selector).withRules(["color-contrast"]).analyze()
        expect(violations.map(({ id }) => id), theme).toEqual([])
      } finally {
        await context.close()
      }
    }
  } finally {
    await request.delete(`/api/areas/${id}`, { headers, data: {} })
  }
})
