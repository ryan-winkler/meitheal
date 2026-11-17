import { expect, test } from "@playwright/test"

import {
  isTaskVisible,
  normalizeSavedFilter,
  readTableFilterParams,
  tableNeedsWorkflowColumns,
  writeTableFilterParams,
} from "../../apps/web/src/lib/filter-state"
import { taskViewUrl } from "../../apps/web/src/lib/task-view-route"

test("saved and URL filters preserve literal values, hierarchy and presentation", () => {
  const rules = {
    id: "root",
    logic: "OR",
    conditions: [
      { id: "one", field: "title", operator: "contains", value: "100% done" },
      {
        id: "nested",
        logic: "AND",
        conditions: [{ id: "two", field: "labels", operator: "equals", value: "fruit, veg" }],
      },
    ],
  }
  const saved = normalizeSavedFilter(JSON.stringify({
    search: true,
    area: "",
    area_id: "older-area",
    priority: 2,
    types: ["quick_capture", "calendar_event"],
    task_type: "epic",
    sort: "due_asc",
    groupBy: "board",
    labels: ["fruit, veg", "[winter]"],
    advancedFilter: rules,
    columns: ["status", "fake-column"],
    open: "task-1",
  }))
  expect(saved).toMatchObject({
    search: "true",
    area: "",
    priority: "2",
    types: ["quick_capture", "calendar_event"],
    task_type: "epic",
    sort: "due_date-asc",
    groupBy: "area",
    labels: ["fruit, veg", "[winter]"],
    advancedFilter: rules,
    columns: ["title", "status"],
  })
  expect(saved).not.toHaveProperty("open")
  const params = new URLSearchParams()
  writeTableFilterParams(params, saved!)
  expect(params.getAll("label")).toEqual(["fruit, veg", "[winter]"])
  expect(params.get("area")).toBe("")
  expect(readTableFilterParams(params)).toEqual(saved)
})

test("legacy arrays and percent escapes are read, while invalid roots are skipped", () => {
  expect(normalizeSavedFilter("null")).toBeNull()
  expect(normalizeSavedFilter("[]")).toBeNull()
  expect(normalizeSavedFilter("oops")).toBeNull()
  expect(normalizeSavedFilter({ area_id: "kitchen", labels: '["fruit, veg"]' })).toMatchObject({
    area: "kitchen",
    labels: ["fruit, veg"],
  })
  const group = { id: "root", logic: "AND", conditions: [{ id: "one", field: "title", operator: "contains", value: "%20" }] }
  const params = new URLSearchParams({ labels: "older,labels", advancedFilter: encodeURIComponent(JSON.stringify(group)) })
  params.set("label", "fruit, veg")
  expect(readTableFilterParams(params)).toMatchObject({ labels: ["fruit, veg"], advancedFilter: group })
})

test("Table URLs resolve one explicit Area and rewrite aliases canonically", () => {
  const params = new URLSearchParams({ area_id: "route", area: "table", board: "legacy" })
  expect(readTableFilterParams(params).area).toBe("route")
  params.set("area_id", "")
  expect(readTableFilterParams(params).area).toBe("")
  writeTableFilterParams(params, readTableFilterParams(params))
  expect(params.toString()).toBe("area=")
  expect(readTableFilterParams(new URLSearchParams({ board: "legacy" })).area).toBe("legacy")
  expect(readTableFilterParams(new URLSearchParams()).area).toBeUndefined()
})

test("Table creation dates preserve valid bounds and reject malformed ranges", () => {
  const dates = { createdFrom: "2024-02-29", createdThrough: "2024-03-31" }
  const saved = normalizeSavedFilter({ ...dates, search: "renovation" })!
  expect(saved).toMatchObject(dates)
  const params = new URLSearchParams({ view: "table", tp: "2", createdFrom: "invalid" })
  writeTableFilterParams(params, saved)
  expect(params.getAll("createdFrom")).toEqual(["2024-02-29"])
  expect(params.get("tp")).toBe("2")
  expect(readTableFilterParams(params)).toEqual(saved)
  params.append("createdFrom", "2024-02-28")
  expect(readTableFilterParams(params)).toEqual({ search: "renovation", area: "" })
  expect(readTableFilterParams(new URLSearchParams({ createdFrom: "", createdThrough: "2024-10-27" })))
    .toEqual({ createdThrough: "2024-10-27" })
  expect(normalizeSavedFilter({ createdFrom: "2023-02-29" })).toBeNull()
  expect(normalizeSavedFilter({ createdFrom: "0000-12-31" })).toBeNull()
  expect(normalizeSavedFilter({ createdThrough: null })).toBeNull()
  expect(normalizeSavedFilter({ createdFrom: dates.createdThrough, createdThrough: dates.createdFrom })).toBeNull()
  expect(normalizeSavedFilter({ search: "legacy" })).toEqual({ search: "legacy", area: "" })
})

test("hierarchy and kind intersect and compound rules see real label arrays", () => {
  const epic = { dataset: { taskType: "epic", taskKind: "quick_capture", labels: '[{"name":"fruit, veg"}]' } }
  const state = normalizeSavedFilter({
    task_type: "epic",
    types: ["quick_capture"],
    advancedFilter: {
      id: "root",
      logic: "AND",
      conditions: [{ id: "one", field: "labels", operator: "equals", value: "fruit, veg" }],
    },
  })!
  expect(isTaskVisible(epic, state)).toBe(true)
  expect(isTaskVisible({ dataset: { ...epic.dataset, taskType: "task" } }, state)).toBe(false)
  expect(isTaskVisible({ dataset: { ...epic.dataset, taskKind: "standard_action" } }, state)).toBe(false)
  expect(isTaskVisible({ dataset: { ...epic.dataset, labels: "[]" } }, state)).toBe(false)
})


test("Table workflow grouping round-trips and leaves other task views with compatible groups", () => {
  const url = new URL("http://localhost/tasks?view=table&area=kitchen#table")
  const saved = normalizeSavedFilter({ area: "kitchen", groupBy: "workflow", subGroupBy: "status" })!
  writeTableFilterParams(url.searchParams, saved)
  expect(readTableFilterParams(url.searchParams)).toEqual(saved)
  expect(tableNeedsWorkflowColumns(saved)).toBe(true)
  for (const view of ["kanban", "calendar", "timeline"] as const) {
    const otherView = taskViewUrl(url, view)
    expect(otherView.searchParams.get("area")).toBe("kitchen")
    expect(otherView.searchParams.has("groupBy")).toBe(false)
    expect(otherView.searchParams.has("subGroupBy")).toBe(false)
  }

  writeTableFilterParams(url.searchParams, { groupBy: "area", subGroupBy: "workflow" })
  expect(tableNeedsWorkflowColumns(readTableFilterParams(url.searchParams))).toBe(true)
  const kanban = taskViewUrl(url, "kanban")
  expect(kanban.searchParams.get("groupBy")).toBe("area")
  expect(kanban.searchParams.has("subGroupBy")).toBe(false)

  const repeated = new URL("http://localhost/tasks?view=table&groupBy=area&groupBy=workflow")
  expect(readTableFilterParams(repeated.searchParams).groupBy).toBe("workflow")
  expect(taskViewUrl(repeated, "kanban").searchParams.has("groupBy")).toBe(false)

  writeTableFilterParams(url.searchParams, { subGroupBy: "workflow" })
  expect(tableNeedsWorkflowColumns(readTableFilterParams(url.searchParams))).toBe(false)
  expect(normalizeSavedFilter({ groupBy: "workflow", subGroupBy: "workflow" })).toEqual({ area: "", groupBy: "workflow" })
})
