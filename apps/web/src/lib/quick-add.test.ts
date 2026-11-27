import test from "node:test"
import assert from "node:assert/strict"
import { quickAddPayload, resolveQuickAddAssignee } from "./quick-add"

test("resolveQuickAddAssignee matches exact id, username, first-name token, and prefix", () => {
  const users = [
    { id: "ha-user-1", name: "Alex Murphy", username: "amurphy" },
    { id: "ha-user-2", displayName: "Niamh Kelly", username: "niamh" },
  ]
  assert.equal(resolveQuickAddAssignee("@alex", users).matchedId, "ha-user-1")
  assert.equal(resolveQuickAddAssignee("amurphy", users).matchedId, "ha-user-1")
  assert.equal(resolveQuickAddAssignee("niam", users).matchedId, "ha-user-2")
  assert.equal(resolveQuickAddAssignee("@unknown", users).matchedId, null)
})

test("quickAddPayload omits unmatched @mention assignees instead of sending invalid IDs", () => {
  const users = [{ id: "ha-user-1", name: "Ryan", username: "ryan" }]
  const res = quickAddPayload("Call dentist tomorrow !! #health @alex", null, { users })
  assert.equal(res.payload.assigned_to, undefined)
  assert.equal(res.unresolvedAssignee, "alex")
  assert.equal(res.payload.priority, 1)
  assert.deepEqual(JSON.parse(String(res.payload.labels ?? "[]")), ["health"])
})

test("quickAddPayload parses shopping list shorthand into structured items with unit", () => {
  const res = quickAddPayload("shopping: 2x milk, eggs, sourdough")
  assert.equal(res.payload.task_kind, "shopping_item")
  const cf = JSON.parse(String(res.payload.custom_fields ?? "{}")) as { items: Array<{ name: string; qty: number; unit: string }> }
  assert.equal(cf.items.length, 3)
  assert.deepEqual(cf.items[0], { name: "milk", qty: 2, unit: "pcs", category: "" })
  assert.deepEqual(cf.items[1], { name: "eggs", qty: 1, unit: "pcs", category: "" })
})
