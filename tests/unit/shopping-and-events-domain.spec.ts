import { expect, test } from "@playwright/test"
import {
  effectiveTaskScheduledDate,
  normalizeShoppingItems,
  SHOPPING_CATEGORIES,
} from "../../packages/domain-tasks/src/domain-model"
import { resolveAgentRouteAccess, resolveAgentRouteScope } from "../../packages/domain-auth/src/agent-route-policy"
import { agentBoardOperations } from "../../apps/web/src/domains/tasks/agent-board-authority"
import { routinePeriod } from "../../apps/web/src/domains/tasks/routine-period"
import { taskChecklistsJson, taskJsonObject } from "../../apps/web/src/domains/tasks/task-creation-service"

test("SHOPPING_CATEGORIES and normalizeShoppingItems coerce heterogeneous payloads", () => {
  expect(SHOPPING_CATEGORIES).toEqual([
    "produce",
    "dairy",
    "meat",
    "pantry",
    "frozen",
    "beverages",
    "household",
    "other",
  ])

  const normalized = normalizeShoppingItems([
    "Apples",
    { name: " Oat Milk ", quantity: "2x", aisle: "DAIRY", done: true },
    { text: "Coffee", qty: "500g", category: "beverages", checked: false },
    { name: "   " },
    { name: "Bread", category: "unknown-aisle" },
  ])
  expect(normalized).toEqual([
    { name: "Apples" },
    { name: "Oat Milk", qty: "2x", category: "dairy", checked: true },
    { name: "Coffee", qty: "500g", category: "beverages", checked: false },
    { name: "Bread" },
  ])
  expect(normalizeShoppingItems("{bad json")).toEqual([])
})

test("effectiveTaskScheduledDate projects calendar_event start_date/due_date/end_date cleanly", () => {
  expect(effectiveTaskScheduledDate({ task_kind: "calendar_event", start_date: "2026-11-24T09:00", due_date: null })).toBe("2026-11-24T09:00")
  expect(effectiveTaskScheduledDate({ task_kind: "calendar_event", start_date: "", due_date: null, end_date: "2026-11-25" })).toBe("2026-11-25")
  expect(effectiveTaskScheduledDate({ task_kind: "standard_action", start_date: "2026-11-24", due_date: null })).toBeNull()
  expect(effectiveTaskScheduledDate({ task_kind: "standard_action", start_date: "2026-11-24", due_date: "2026-11-26" })).toBe("2026-11-26")
})

test("routinePeriod preserves UTC default and computes household-timezone daily/weekly periods", () => {
  // 2026-11-24T01:30:00Z is still 2026-11-23 in America/Los_Angeles (Monday) and already 2026-11-24 in Pacific/Auckland (Tuesday)
  const instant = new Date("2026-11-24T01:30:00.000Z")
  expect(routinePeriod("daily", instant)).toBe("2026-11-24")
  expect(routinePeriod("daily", instant, "America/Los_Angeles")).toBe("2026-11-23")
  expect(routinePeriod("daily", instant, "Pacific/Auckland")).toBe("2026-11-24")

  // 2026-11-23T01:00:00Z is Sunday Nov 22 in Los Angeles -> weekly Monday is 2026-11-16; UTC is Monday 2026-11-23
  const boundary = new Date("2026-11-23T01:00:00.000Z")
  expect(routinePeriod("weekly", boundary)).toBe("2026-11-23")
  expect(routinePeriod("weekly", boundary, "America/Los_Angeles")).toBe("2026-11-16")
})

test("agent routine routes and board authority allow scoped routines while blocking tasks:write:assigned", () => {
  expect(resolveAgentRouteScope("/api/habits", "GET")).toBe("tasks:read")
  expect(resolveAgentRouteScope("/api/habits", "POST")).toBe("tasks:write")
  expect(resolveAgentRouteScope("/api/boards/routines", "GET")).toBe("tasks:read")

  expect(resolveAgentRouteAccess("/api/habits", "POST", ["tasks:write"])).toMatchObject({ allowed: true })
  expect(resolveAgentRouteAccess("/api/habits", "POST", ["tasks:delete"])).toMatchObject({ allowed: true })
  expect(resolveAgentRouteAccess("/api/habits", "POST", ["tasks:write:assigned"])).toMatchObject({ allowed: false })

  const fullWriteOps = agentBoardOperations(["tasks:read", "tasks:write", "tasks:delete"])
  expect(fullWriteOps).toContainEqual({ resource: "routine", action: "read" })
  expect(fullWriteOps).toContainEqual({ resource: "routine", action: "create" })
  expect(fullWriteOps).toContainEqual({ resource: "routine", action: "edit" })
  expect(fullWriteOps).toContainEqual({ resource: "routine", action: "delete" })

  const assignedOnlyOps = agentBoardOperations(["tasks:read", "tasks:write:assigned"])
  expect(assignedOnlyOps).toContainEqual({ resource: "routine", action: "read" })
  expect(assignedOnlyOps).not.toContainEqual({ resource: "routine", action: "create" })
  expect(assignedOnlyOps).not.toContainEqual({ resource: "routine", action: "edit" })
})

test("taskJsonObject and taskChecklistsJson accept both native JSON structures and encoded strings", () => {
  const cfObj = taskJsonObject({ items: [{ name: "Milk", qty: "2L" }] }, "custom_fields")
  expect(cfObj.ok).toBe(true)
  if (cfObj.ok) expect(JSON.parse(cfObj.json)).toEqual({ items: [{ name: "Milk", qty: "2L" }] })

  const cfStr = taskJsonObject('{"location":"Clinic"}', "custom_fields")
  expect(cfStr.ok).toBe(true)

  const clArr = taskChecklistsJson([{ text: "Eggs", done: false }], true)
  expect(clArr.ok).toBe(true)

  const badCl = taskChecklistsJson([{ text: "No done bool" }], true)
  expect(badCl.ok).toBe(false)
})
