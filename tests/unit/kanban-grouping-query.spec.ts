import { expect, test } from "@playwright/test"

import { updateKanbanFilters } from "../../apps/web/src/lib/kanban-query"

test("Kanban sharing preserves explicit No grouping while omitting the untouched default", () => {
  for (const initial of ["?groupBy=none", "?groupBy=type"]) {
    const url = new URL(`http://localhost/tasks${initial}`)
    updateKanbanFilters(url, { groupBy: "none" })
    expect(url.searchParams.get("groupBy")).toBe("none")
  }
  const defaultUrl = new URL("http://localhost/tasks")
  updateKanbanFilters(defaultUrl, { groupBy: "none" })
  expect(defaultUrl.searchParams.has("groupBy")).toBe(false)
})
