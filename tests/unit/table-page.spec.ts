import { expect, test } from "@playwright/test"

import { getGroupDisplay, readTableFilterParams } from "../../apps/web/src/lib/filter-state"
import { getTablePage, getTableWorkflowColumns } from "../../apps/web/src/lib/table-page"
import type { TaskViewItem } from "../../apps/web/src/lib/task-queries"

function task(id: string, fields: Partial<TaskViewItem> = {}): TaskViewItem {
  return {
    id, title: id, description: null, status: "pending", priority: 3, due_date: null,
    labels: [], rice: null, calendar_sync_state: null, area_id: "default", project_id: null,
    custom_fields: {}, start_date: null, end_date: null, progress: 0, color: null, is_favorite: false,
    task_type: "task", task_kind: null, parent_id: null, ticket_number: null, assigned_to: null,
    checklists: null, created_at: "", updated_at: "", deferred_at: null, is_overdue: false,
    is_done: false, framework_payload: {}, urgency: 0, importance: 0, eisenhower_quadrant: "",
    eisenhower_override: false, effort_minutes: null, effort_type: null, blocked_by: null, ...fields,
  }
}

test("creation date filtering covers inclusive DST days and legacy timestamps", () => {
  const tasks = [
    task("before spring", { created_at: "2024-03-30T23:59:59.999Z" }),
    task("spring start", { created_at: String(Date.parse("2024-03-31T00:00:00Z")), parent_id: "before spring" }),
    task("spring end", { created_at: "2024-03-31 22:59:59.999" }),
    task("after spring", { created_at: "2024-04-01T00:00:00+01:00" }),
    task("before autumn", { created_at: "2024-10-26T22:59:59.999Z" }),
    task("autumn start", { created_at: "2024-10-27T00:00:00+01:00" }),
    task("autumn end", { created_at: "2024-10-27T23:59:59.999Z" }),
    task("after autumn", { created_at: "2024-10-28T00:00:00Z" }),
    task("invalid", { created_at: "2024-02-31T00:00:00Z" }),
    task("empty"),
    task("epoch", { created_at: "0" }),
    task("before common era", { created_at: "0000-03-31T00:00:00Z" }),
    task("legacy first year", { created_at: "0001-03-31 00:00:00Z" }),
    task("iso end of day", { created_at: "2024-03-31T24:00:00Z" }),
    task("legacy spaced timestamp", { created_at: " 2024-03-31  12:00:00.001234567890z " }),
    task("invalid repeated separator", { created_at: "2024-03-31TT12:00:00Z" }),
  ]
  const sameDay = (day: string, zone?: string) =>
    getTablePage(tasks, { createdFrom: day, createdThrough: day }, null, [], zone)
  const ids = (page: ReturnType<typeof getTablePage>) => page.rows.map(row => row.task.id)
  expect(ids(sameDay("2024-03-31", "Europe/Dublin"))).toEqual(["spring start", "spring end", "legacy spaced timestamp"])
  expect(ids(sameDay("2024-03-31", "invalid-zone"))).toEqual(["spring start", "spring end", "legacy spaced timestamp"])
  expect(ids(sameDay("2024-03-31", "America/New_York"))).toEqual(["spring end", "after spring", "iso end of day", "legacy spaced timestamp"])
  expect(ids(sameDay("2024-10-27"))).toEqual(["autumn start", "autumn end"])
  expect(ids(sameDay("1970-01-01", "UTC"))).toEqual(["epoch"])
  expect(ids(sameDay("0001-03-31", "UTC"))).toEqual(["legacy first year"])
  expect(getTablePage(tasks, {}, null).stats.total.count).toBe(tasks.length)
  const later = getTablePage(tasks, { createdFrom: "2024-10-27", search: "autumn" }, "2")
  expect(later.page).toBe(1)
  expect(ids(later)).toEqual(["autumn start", "autumn end", "after autumn"])
})

test("Table pages a deep hierarchy in depth-first order without overflowing", () => {
  const tasks = Array.from({ length: 10_000 }, (_, index) => task(String(index), {
    parent_id: index > 0 ? String(index - 1) : null,
  }))
  const page = getTablePage(tasks, {}, "200")
  expect(page.stats.total.count).toBe(10_000)
  expect(page.page).toBe(200)
  expect(page.rows.map(row => Number(row.task.id))).toEqual(Array.from({ length: 50 }, (_, index) => 9950 + index))
  expect(page.rows[0]).toMatchObject({ depth: 9950, parentId: "9949", parentOutsidePage: { id: "9949" } })
  expect(page.rows.at(-1)).toMatchObject({ depth: 9999, parentId: "9998", hasChildren: false })

  const root = task("root", { title: "keep root" })
  const hidden = task("middle", { parent_id: "root" })
  const child = task("child", { title: "keep child", parent_id: "middle" })
  const sibling = task("sibling", { title: "keep sibling", parent_id: "root" })
  const filtered = getTablePage([root, hidden, child, sibling], { search: "keep" }, null)
  expect(filtered.rows.map(row => row.task.id)).toEqual(["root", "child", "sibling"])
  expect(filtered.rows[0]).toMatchObject({ hasChildren: true })
  expect(filtered.rows[1]).toMatchObject({ depth: 1, parentId: "root" })

  const cyclic = getTablePage([task("first", { parent_id: "second" }), task("second", { parent_id: "first" })], {}, null)
  expect(cyclic.rows.map(row => row.task.id)).toEqual(["first", "second"])
})

test("Table uses canonical status for filters, groups and row values and keeps custom statuses", () => {
  const tasks = [
    task("older", { status: "todo" }),
    task("current", { status: "pending" }),
    task("working", { status: "in_progress" }),
    task("queue", { status: "backlog" }),
    task("finished", { status: "done", is_overdue: true }),
    task("custom", { status: "Waiting on delivery" }),
  ]
  const groups = getTablePage(tasks, { groupBy: "status" }, null)
  expect(groups.stats.groups.map(([key, stats]) => [key, stats.count])).toEqual([
    ["backlog", 1], ["pending", 2], ["active", 1], ["complete", 1], ["Waiting on delivery", 1],
  ])
  expect(getGroupDisplay("status", groups.stats.groups[1]![0]).label).toBe("Todo")
  expect(groups.rows.map(row => row.task.status)).toEqual([
    "backlog", "pending", "pending", "active", "complete", "Waiting on delivery",
  ])
  expect(groups.rows.find(row => row.task.id === "finished")?.task).toMatchObject({ is_done: true, is_overdue: false })
  expect(groups.active).toBe(1)
  expect(groups.overdue).toBe(0)
  expect(tasks[0]?.status).toBe("todo")

  const filters = readTableFilterParams(new URLSearchParams({
    status: "todo",
    advancedFilter: JSON.stringify({
      logic: "AND", conditions: [{ field: "status", operator: "equals", value: "todo" }],
    }),
  }))
  expect(getTablePage(tasks, filters, null).rows.map(row => row.task.id)).toEqual(["older", "current"])
  const custom = readTableFilterParams(new URLSearchParams({ status: "Waiting on delivery" }))
  expect(getTablePage(tasks, custom, null).rows.map(row => row.task.id)).toEqual(["custom"])
})

test("workflow columns match before Table paging and intersect existing filters", () => {
  const columns = [
    { id: "lane-todo", key: "pending", label: "Todo", includes: ["todo"] },
    { id: "lane-active", key: "active", label: "In Progress", includes: ["active", null, "Waiting"] },
  ]
  const tasks = Array.from({ length: 2_000 }, (_, index) => task(String(index).padStart(4, "0"), {
    status: ["pending", "in_progress", "Waiting", "complete"][index % 4]!,
    assigned_to: index % 8 < 4 ? null : "member",
  })).reverse()
  const filters = readTableFilterParams(new URLSearchParams(
    "lane=lane-todo&lane=lane-active&lane=lane-active&user=__unassigned__&sort=title-asc",
  ))
  expect(filters.laneIds).toEqual(["lane-todo", "lane-active"])
  const page = getTablePage(tasks, filters, "15", columns)
  expect(page.stats.total.count).toBe(750)
  expect(page.rows).toHaveLength(50)
  expect(page.rows.at(-1)?.task.id).toBe("1994")
  expect(getTablePage(tasks, { ...filters, status: "active" }, null, columns).stats.total.count).toBe(250)
  expect(getTablePage(tasks, { laneIds: ["removed"] }, null, columns).rows).toEqual([])
  expect(getTablePage(tasks, { laneIds: ["removed", "lane-todo"] }, null, columns).stats.total.count).toBe(500)
})

test("Table gives workflow columns distinct labels while preserving their identity and order", () => {
  const noWorkflowLabel = "No workflow column"
  const columns = [
    { id: "todo", key: "pending", label: " Re\u0301ady  now ", includes: ["pending"] },
    { id: "working", key: "active", label: "Réady now", includes: ["active"] },
    { id: "named", key: "waiting", label: "Réady now (pending)", includes: ["Waiting"] },
    { id: "done", key: "complete", label: noWorkflowLabel, includes: ["complete"] },
    { id: "queued", key: "backlog", label: "   ", includes: ["backlog"] },
  ]

  expect(getTableWorkflowColumns(columns, noWorkflowLabel)).toEqual([
    { ...columns[0], label: "Réady now (pending) ·" },
    { ...columns[1], label: "Réady now (active)" },
    columns[2],
    { ...columns[3], label: "No workflow column (complete)" },
    { ...columns[4], label: "backlog" },
  ])
})

test("workflow grouping projects each status once and prefers a matching exact column key", () => {
  const columns = [
    { id: "first", key: "mixed", label: "Zebra", includes: ["todo", "in_progress", "Waiting", null] },
    { id: "pending", key: "pending", label: "Todo", includes: ["pending"] },
    { id: "last", key: "other", label: "Alpha", includes: ["active", "Waiting"] },
    { id: "unrelated", key: "active", label: "Does not include active", includes: [] },
  ]
  const tasks = [
    task("finished", { status: "done" }),
    task("queued", { status: "todo" }),
    task("working", { status: "active" }),
    task("delivery", { status: "Waiting" }),
  ]

  const page = getTablePage(tasks, { groupBy: "workflow", sort: "title-asc" }, null, columns)
  expect(page.rows.map(row => [row.task.id, row.workflowColumnId])).toEqual([
    ["delivery", "first"], ["working", "first"], ["queued", "pending"], ["finished", ""],
  ])
  expect(page.stats.groups.map(([key, stats]) => [key, stats.count])).toEqual([
    ["first", 2], ["pending", 1], ["", 1],
  ])
  expect(page.stats.total.count).toBe(tasks.length)

  const selected = getTablePage(tasks, { groupBy: "workflow", laneIds: ["last", "first", "deleted"] }, null, columns)
  expect(selected.rows.map(row => [row.task.id, row.workflowColumnId])).toEqual([
    ["queued", "first"], ["working", "first"], ["delivery", "first"],
  ])
  expect(selected.stats.groups.map(([key, stats]) => [key, stats.count])).toEqual([["first", 3]])
  expect(getTablePage(tasks, { groupBy: "workflow", laneIds: ["deleted"] }, null, columns).stats.total.count).toBe(0)
  expect(getTablePage(tasks, { groupBy: "workflow" }, null).stats.groups).toEqual([
    ["", { count: tasks.length, riceCount: 0, riceSum: 0 }],
  ])
})

test("nested workflow groups sort before paging and retain counts across page boundaries", () => {
  const columns = [
    { id: "working", key: "active", label: "Working", includes: ["active"] },
    { id: "queued", key: "pending", label: "Queued", includes: ["pending"] },
  ]
  const tasks = [
    task("unmatched", { area_id: "area-a", status: "custom" }),
    task("queued first", { area_id: "area-a", status: "pending" }),
    ...Array.from({ length: 51 }, (_, index) => task(String(index).padStart(2, "0"), {
      area_id: "area-a", status: "in_progress", rice: 3,
    })).reverse(),
    task("other area", { area_id: "area-b", status: "active" }),
  ]
  const filters = { groupBy: "area", subGroupBy: "workflow", sort: "title-asc" }
  const first = getTablePage(tasks, filters, null, columns)
  const second = getTablePage(tasks, filters, "2", columns)
  const areaAWorkingKey = JSON.stringify(["area-a", "working"])
  const areaAWorkingStats = { count: 51, riceCount: 51, riceSum: 153 }

  expect(first.rows.map(row => row.task.id)).toEqual(
    Array.from({ length: 50 }, (_, index) => String(index).padStart(2, "0")),
  )
  expect(first.stats.subgroups).toEqual([[areaAWorkingKey, areaAWorkingStats]])
  expect(second.rows.map(row => [row.task.id, row.workflowColumnId])).toEqual([
    ["50", "working"], ["queued first", "queued"], ["unmatched", ""], ["other area", "working"],
  ])
  expect(second.stats.subgroups.map(([key]) => JSON.parse(key))).toEqual([
    ["area-a", "working"], ["area-a", "queued"], ["area-a", ""], ["area-b", "working"],
  ])
  expect(second.stats.subgroups[0]).toEqual([areaAWorkingKey, areaAWorkingStats])
})

test("Epic and workflow grouping order tasks at either level", () => {
  const columns = [
    { id: "ready", key: "pending", label: "Ready", includes: ["pending"] },
    { id: "blocked", key: "active", label: "Blocked", includes: ["active"] },
  ]
  const tasks = [
    task("loft", { title: "Loft", task_type: "epic" }),
    task("yard", { title: "Yard", task_type: "epic" }),
    task("yard-blocked", { title: "fixture yard blocked", parent_id: "yard", status: "active" }),
    task("loft-blocked", { title: "fixture loft blocked", parent_id: "loft", status: "active" }),
    task("yard-ready", { title: "fixture yard ready", parent_id: "yard" }),
    task("loft-ready", { title: "fixture loft ready", parent_id: "loft" }),
  ]
  const byEpic = getTablePage(tasks, { search: "fixture", groupBy: "epic", subGroupBy: "workflow" }, null, columns)
  const byWorkflow = getTablePage(tasks, { search: "fixture", groupBy: "workflow", subGroupBy: "epic" }, null, columns)

  expect(byEpic.rows.map(row => row.task.id)).toEqual(["loft-ready", "loft-blocked", "yard-ready", "yard-blocked"])
  expect(byWorkflow.rows.map(row => row.task.id)).toEqual(["loft-ready", "yard-ready", "loft-blocked", "yard-blocked"])
  expect(byEpic.stats.subgroups.map(([key, stats]) => [JSON.parse(key), stats.count])).toEqual([
    [["epic:loft", "ready"], 1], [["epic:loft", "blocked"], 1],
    [["epic:yard", "ready"], 1], [["epic:yard", "blocked"], 1],
  ])
  expect(byWorkflow.stats.subgroups.map(([key, stats]) => [JSON.parse(key), stats.count])).toEqual([
    [["ready", "epic:loft"], 1], [["ready", "epic:yard"], 1],
    [["blocked", "epic:loft"], 1], [["blocked", "epic:yard"], 1],
  ])
})

test("Epic grouping resolves the complete Household ancestry before Table filters", () => {
  const tasks = [
    task("nested-child", { title: "keep nested", parent_id: "nested", area_id: "kitchen", ticket_number: 101 }),
    task("root-child", { title: "keep root", parent_id: "bridge", area_id: "kitchen" }),
    task("missing-parent", { title: "keep missing", parent_id: "unreadable-epic", area_id: "kitchen" }),
    task("cycle-a", { title: "keep cycle a", parent_id: "cycle-b", area_id: "kitchen" }),
    task("cycle-b", { title: "keep cycle b", parent_id: "cycle-a", area_id: "kitchen" }),
    task("unassigned", { title: "keep unassigned", area_id: "kitchen" }),
    task("root", { title: "Zulu works", task_type: "epic", status: "complete", area_id: "outside", ticket_number: 1 }),
    task("bridge", { title: "Bridge outside filter", parent_id: "root", status: "active", area_id: "outside" }),
    task("nested", { title: "Alpha works", task_type: "epic", parent_id: "root", status: "complete", area_id: "outside", ticket_number: 2 }),
    task("unrepresented", { title: "No matching descendant", task_type: "epic", status: "complete", ticket_number: 3 }),
  ]
  const filters = { groupBy: "epic", search: "keep", status: "pending", area: "kitchen", laneIds: ["pending"], sort: "title-asc" }
  const page = getTablePage(tasks, filters, null, [{ id: "pending", key: "pending", label: "Pending", includes: ["pending"] }])
  expect(page.rows.map(row => [row.task.id, row.epicGroup])).toEqual([
    ["nested-child", "epic:nested"],
    ["root-child", "epic:root"],
    ["cycle-a", "epic:none"],
    ["cycle-b", "epic:none"],
    ["missing-parent", "epic:none"],
    ["unassigned", "epic:none"],
  ])
  expect(page.stats.groups.map(([key, value]) => [key, value.count])).toEqual([
    ["epic:nested", 1], ["epic:root", 1], ["epic:none", 4],
  ])
  expect(page.stats.total.count).toBe(6)
  const labels = new Map(page.stats.epicLabels)
  expect(labels.get("epic:root")).toContain("Zulu works")
  expect(labels.get("epic:nested")).toContain("Alpha works")
  expect(labels.has("epic:unrepresented")).toBe(false)
  expect(labels.has("epic:none")).toBe(false)

  const all = getTablePage(tasks, { groupBy: "epic" }, null)
  expect(all.rows.find(row => row.task.id === "root")?.epicGroup).toBe("epic:root")
  expect(all.rows.find(row => row.task.id === "nested")?.epicGroup).toBe("epic:nested")
})

test("Epic subgroups order before paging and keep their full counts and labels", () => {
  const tasks = [
    task("outer", { title: "Alpha", task_type: "epic", status: "complete", ticket_number: 1 }),
    task("inner", { title: "Beta", task_type: "epic", parent_id: "outer", status: "complete", ticket_number: 2 }),
    task("loose", { title: "loose", area_id: "area-a", rice: 5 }),
    task("nested match", { title: "nested match", parent_id: "inner", area_id: "area-a", rice: 4 }),
    ...Array.from({ length: 51 }, (_, index) => task(String(index).padStart(2, "0"), {
      parent_id: "outer", area_id: "area-a", rice: 3,
    })).reverse(),
    task("another area", { title: "other match", parent_id: "outer", area_id: "area-b" }),
  ]
  const filters = { groupBy: "area", subGroupBy: "epic", status: "pending", sort: "title-asc" }
  const first = getTablePage(tasks, filters, null)
  const second = getTablePage(tasks, filters, "2")
  const alphaKey = JSON.stringify(["area-a", "epic:outer"])
  const alphaStats = { count: 51, riceCount: 51, riceSum: 153 }

  expect(first.rows.map(row => row.task.id)).toEqual(
    Array.from({ length: 50 }, (_, index) => String(index).padStart(2, "0")),
  )
  expect(first.stats.subgroups).toEqual([[alphaKey, alphaStats]])
  expect(first.stats.epicLabels.map(([key]) => key)).toEqual(["epic:outer"])
  expect(second.rows.map(row => [row.task.id, row.epicGroup])).toEqual([
    ["50", "epic:outer"], ["nested match", "epic:inner"], ["loose", "epic:none"], ["another area", "epic:outer"],
  ])
  expect(second.stats.subgroups[0]).toEqual([alphaKey, alphaStats])
  expect(second.stats.total).toEqual({ count: 54, riceCount: 53, riceSum: 162 })
  expect(second.stats.epicLabels.map(([key]) => key)).toEqual(["epic:outer", "epic:inner"])
  expect(new Map(first.stats.epicLabels).get("epic:outer")).toBe(
    new Map(second.stats.epicLabels).get("epic:outer"),
  )

  const rootFirst = getTablePage(tasks, { groupBy: "epic", status: "pending", sort: "title-asc" }, null)
  const rootSecond = getTablePage(tasks, { groupBy: "epic", status: "pending", sort: "title-asc" }, "2")
  expect(rootFirst.stats.groups).toEqual([["epic:outer", { count: 52, riceCount: 51, riceSum: 153 }]])
  expect(rootSecond.stats.groups.map(([key, value]) => [key, value.count])).toEqual([
    ["epic:outer", 52], ["epic:inner", 1], ["epic:none", 1],
  ])
})

test("Epic identity stays separate for duplicate titles and input order", () => {
  const tasks = [
    task("first", { title: "Same title", task_type: "epic", ticket_number: 1 }),
    task("second", { title: "Same title", task_type: "epic", ticket_number: 2 }),
    task("child", { parent_id: "second" }),
    task("self", { title: "Self reference", task_type: "epic", parent_id: "self", ticket_number: 3 }),
  ]
  const result = getTablePage(tasks, { groupBy: "epic", sort: "title-asc" }, null)
  const reversed = getTablePage([...tasks].reverse(), { groupBy: "epic", sort: "title-asc" }, null)
  expect(result.stats.groups.map(([key, value]) => [key, value.count])).toEqual([
    ["epic:first", 1], ["epic:second", 2], ["epic:self", 1],
  ])
  expect(new Set(result.stats.epicLabels.map(([, value]) => value)).size).toBe(3)
  expect(reversed.rows.map(row => [row.task.id, row.epicGroup])).toEqual(
    result.rows.map(row => [row.task.id, row.epicGroup]),
  )
})
