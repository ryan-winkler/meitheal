import { randomUUID } from "node:crypto"

import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal fixture")

test("Table groups and pager expose keyboard controls and pass scoped accessibility rules", async ({ page, request }) => {
  const tasks: string[] = []
  const prefix = `Table accessibility ${randomUUID()}`
  const custom = "waiting_on_delivery"
  try {
    for (let index = 0; index < 51; index++) {
      const response = await request.post("/api/tasks", {
        data: {
          title: `${prefix} ${index}`, status: index === 0 ? custom : "pending",
          priority: index % 2 + 2,
        },
      })
      expect(response.status(), await response.text()).toBe(201)
      tasks.push((await response.json()).id)
    }

    await page.setViewportSize({ width: 320, height: 780 })
    await page.addInitScript(() => {
      if (!localStorage.getItem("meitheal-theme")) localStorage.setItem("meitheal-theme", "dark")
    })
    const params = new URLSearchParams({ view: "table", search: prefix, groupBy: "status", subGroupBy: "priority" })
    await page.goto("/tasks?" + params + "#table")
    const table = page.getByRole("table")
    const pager = page.getByRole("navigation", { name: "Task pages" })
    const next = pager.getByRole("link", { name: "Next" })
    const group = table.getByRole("button", { name: "Toggle group Todo" })
    const priority = table.getByRole("button", { name: "Toggle sub-group High" })
    await expect(group).toHaveAttribute("aria-expanded", "true")
    await expect(table.getByRole("rowheader", { name: "Todo", exact: true })).toBeVisible()
    await expect(priority).toBeVisible()

    const relationship = await table.evaluate(node => {
      const toggle = node.querySelector(".group-toggle")
      const controlled = toggle?.getAttribute("aria-controls")?.split(" ") ?? []
      const firstTitle = node.querySelector(".table-row .col-title")
      const headers = firstTitle?.getAttribute("headers")?.split(" ") ?? []
      return {
        controls: controlled.map(id => document.getElementById(id)?.tagName),
        headers: headers.map(id => document.getElementById(id)?.tagName),
      }
    })
    expect(relationship.controls).toHaveLength(52)
    expect(relationship.controls.every(tag => tag === "TR")).toBeTruthy()
    expect(relationship.headers).toEqual(["TH", "TH", "TH"])

    await priority.press("Space")
    await expect(priority).toHaveAttribute("aria-expanded", "false")
    await expect(priority).toBeFocused()
    await priority.press("Space")
    await expect(priority).toHaveAttribute("aria-expanded", "true")
    await expect(next).toHaveAccessibleDescription("1–50 of 51 matching tasks")
    expect((await pager.boundingBox())!.y).toBeLessThan((await table.boundingBox())!.y)
    await next.press("Enter")
    const previous = pager.getByRole("link", { name: "Previous" })
    await expect(previous).toBeFocused()
    await expect(previous).toHaveAccessibleDescription("51–51 of 51 matching tasks")
    await expect(table.getByRole("rowheader", { name: custom, exact: true })).toBeVisible()
    await previous.press("Enter")
    await expect(next).toBeFocused()

    for (const theme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
      await page.evaluate(theme => localStorage.setItem("meitheal-theme", theme), theme)
      await page.reload()
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
      await expect(group).toBeVisible()
      const result = await new AxeBuilder({ page }).include("#table-shell").withRules([
        "aria-allowed-attr", "aria-required-children", "aria-required-parent", "color-contrast",
      ]).analyze()
      expect(result.violations, theme).toEqual([])
    }
  } finally {
    for (const id of tasks) await request.delete(`/api/tasks/${id}`)
  }
})
