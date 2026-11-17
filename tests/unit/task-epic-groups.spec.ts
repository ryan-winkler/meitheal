import { expect, test } from "@playwright/test"

import { resolveTaskEpics, type TaskEpicLink } from "../../apps/web/src/domains/tasks/task-epic-groups"
import { getEpicGroupLabel } from "../../apps/web/src/lib/epic-group-labels"

const task = (id: string, parent_id: string | null = null, epic = false): TaskEpicLink => ({
  id, parent_id, task_type: epic ? "epic" : "task", title: "Shared title", ticket_number: null,
})

test("nearest Epics resolve independently of traversal order and shared ancestors", () => {
  const rows = [task("leaf", "middle"), task("sibling", "middle"), task("middle", "outer"), task("outer", null, true),
    task("inner", "outer", true), task("inner-child", "inner")]
  for (const order of [rows, [...rows].reverse(), [...rows.slice(2), ...rows.slice(0, 2)]]) {
    const resolved = resolveTaskEpics(order)
    for (const id of ["leaf", "sibling", "middle", "outer"]) expect(resolved.get(id)?.id).toBe("outer")
    for (const id of ["inner", "inner-child"]) expect(resolved.get(id)?.id).toBe("inner")
  }
})

test("missing or out-of-scope ancestry and cycles remain ungrouped", () => {
  const rows = [task("missing", "private"), task("root"), task("child", "root"), task("cycle-a", "cycle-b"), task("cycle-b", "cycle-a"), task("cycle-child", "cycle-a")]
  expect(resolveTaskEpics(rows).size).toBe(0)
})

test("Epic labels remove markup and distinguish duplicate or unticketed titles", () => {
  expect(getEpicGroupLabel({ id: "one", title: "<b>Shared</b> &amp; <i>safe</i>", ticket_number: 5 })).toBe("Shared & safe (MTH-5)")
  const labels = [1, 2, null].map(ticket_number => getEpicGroupLabel({ id: "stable-id", title: "Shared", ticket_number }))
  expect(new Set(labels).size).toBe(3)
  expect(labels[2]).toBe("Shared (#stable-id)")
  expect(getEpicGroupLabel({ id: "stable-id", title: "<script>secret()</script>", ticket_number: null })).toBe("#stable-id")
})
