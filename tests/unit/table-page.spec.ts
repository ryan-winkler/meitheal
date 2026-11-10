import { expect, test } from "@playwright/test"

import { getGroupDisplay, readTableFilterParams } from "../../apps/web/src/lib/filter-state"
import { getTablePage } from "../../apps/web/src/lib/table-page"
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
