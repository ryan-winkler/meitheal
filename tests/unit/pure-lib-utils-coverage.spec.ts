import { expect, test } from "@playwright/test"

import { sanitizeTodoTitle } from "../../apps/web/src/lib/cleanup-corrupt-titles"
import { calendarDaysFromToday, calendarToday, formatRegionalDate } from "../../apps/web/src/lib/date"
import { evaluateFilterGroup, extractDataFromElement, passesAdvancedFilter, type FilterGroup } from "../../apps/web/src/lib/filter-engine"

test("date helpers format calendar-only dates and zoned timestamps across all formats", () => {
  const ref = new Date("2026-11-14T12:00:00Z")
  expect(calendarToday("Europe/Dublin", ref)).toBe("2026-11-14")
  expect(calendarDaysFromToday("2026-11-16", "Europe/Dublin", ref)).toBe(2)
  expect(calendarDaysFromToday("not-a-date", "Europe/Dublin", ref)).toBeNull()

  expect(formatRegionalDate(null)).toBe("")
  expect(formatRegionalDate("not-a-date")).toBe("not-a-date")
  expect(formatRegionalDate("2026-11-14", { format: "absolute-iso", timezone: "Europe/Dublin" })).toBe("2026-11-14")
  expect(formatRegionalDate("2026-11-14", { format: "absolute-eu", timezone: "Europe/Dublin" })).toBe("14/11/2026")
  expect(formatRegionalDate("2026-11-14", { format: "absolute-us", timezone: "Europe/Dublin" })).toBe("11/14/2026")
  expect(typeof formatRegionalDate("2026-11-14", { format: "relative", timezone: "Europe/Dublin" })).toBe("string")
  expect(typeof formatRegionalDate(new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), { format: "relative", timezone: "Europe/Dublin" })).toBe("string")
  expect(typeof formatRegionalDate(new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10), { format: "relative", timezone: "Europe/Dublin" })).toBe("string")

  expect(formatRegionalDate(ref, { format: "absolute-iso", timezone: "Europe/Dublin" })).toBe("2026-11-14")
  expect(formatRegionalDate(ref, { format: "absolute-eu", timezone: "Europe/Dublin" })).toBe("14/11/2026")
  expect(formatRegionalDate(ref, { format: "absolute-us", timezone: "Europe/Dublin" })).toBe("11/14/2026")
  const pastDate = new Date(Date.now() - 2 * 3_600_000)
  expect(formatRegionalDate(pastDate, { format: "relative", timezone: "Europe/Dublin" })).toContain("ago")
  expect(formatRegionalDate(ref, { timezone: "Europe/Dublin", fallbackFormat: "yyyy/MM" })).toBe("2026/11")
  expect(formatRegionalDate(ref, { format: "absolute-iso", timezone: "Invalid/Zone" })).toBe(String(ref))
})

test("filter-engine evaluates all operators, arrays, nested groups, and element datasets", () => {
  const el = {
    dataset: {
      title: "Fix Heating Pump",
      priority: "2",
      labels: JSON.stringify(["home", { name: "urgent" }]),
      taskType: "chore",
      notes: "",
    },
  } as unknown as HTMLElement

  const data = extractDataFromElement(el)
  expect(data.labels).toEqual(["home", "urgent"])
  expect(data.type).toBe("chore")

  const badEl = { dataset: { labels: "{bad", task_type: "task" } } as unknown as HTMLElement
  expect(extractDataFromElement(badEl).labels).toEqual([])

  const matchingGroup: FilterGroup = {
    id: "g1",
    logic: "AND",
    conditions: [
      { id: "c1", field: "title", operator: "contains", value: "heating" },
      { id: "c2", field: "labels", operator: "equals", value: "urgent" },
      { id: "c3", field: "labels", operator: "notEquals", value: "archived" },
      { id: "c4", field: "labels", operator: "notContains", value: "someday" },
      { id: "c5", field: "priority", operator: "between", value: [1, 3] },
      { id: "c6", field: "notes", operator: "isEmpty", value: null },
      { id: "c7", field: "title", operator: "isNotEmpty", value: null },
      {
        id: "g2",
        logic: "OR",
        conditions: [
          { id: "c8", field: "priority", operator: "greaterThan", value: 10 },
          { id: "c9", field: "priority", operator: "lessThan", value: 5 },
        ],
      },
    ],
  }
  expect(passesAdvancedFilter(el, matchingGroup)).toBe(true)
  expect(passesAdvancedFilter(el, null)).toBe(true)
  expect(evaluateFilterGroup({ id: "empty", logic: "AND", conditions: [] }, data)).toBe(true)
  expect(evaluateFilterGroup({
    id: "g3",
    logic: "AND",
    conditions: [
      { id: "x1", field: "labels", operator: "contains", value: "home" },
      { id: "x2", field: "title", operator: "equals", value: "Fix Heating Pump" },
      { id: "x3", field: "title", operator: "notEquals", value: "Other" },
      { id: "x4", field: "title", operator: "notContains", value: "Missing" },
      { id: "x5", field: "priority", operator: "between", value: [1] },
    ],
  }, data)).toBe(false)
})

test("sanitizeTodoTitle strips recursive MTH prefixes, trailing DUE markers, and notification leaks", () => {
  expect(sanitizeTodoTitle("MTH-82: MTH-81: Bleed radiators — DUE — DUE")).toBe("Bleed radiators")
  expect(sanitizeTodoTitle("MTH-4: MTH-3: Check filter Task MTH-3 is due. Open in Meitheal: /tasks")).toBe("Check filter")
  expect(sanitizeTodoTitle("MTH-1: ")).toBe("MTH-1: ")
})
