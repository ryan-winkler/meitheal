import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildQuickCapturePayload,
  mapQuickCapturePriority,
  SHOPPING_CATEGORIES,
} from "./pwa-capture-builder"

describe("pwa-capture-builder", () => {
  it("maps textual and numeric priority values cleanly", () => {
    assert.equal(mapQuickCapturePriority("urgent"), 1)
    assert.equal(mapQuickCapturePriority("high"), 2)
    assert.equal(mapQuickCapturePriority("medium"), 3)
    assert.equal(mapQuickCapturePriority("low"), 4)
    assert.equal(mapQuickCapturePriority("none"), 5)
    assert.equal(mapQuickCapturePriority("2"), 2)
    assert.equal(mapQuickCapturePriority(undefined), 3)
    assert.equal(mapQuickCapturePriority("unknown"), 3)
  })

  it("serializes shopping_item with custom_fields.items and checklists without board_id", () => {
    const payload = buildQuickCapturePayload({
      title: "  Weekly Groceries  ",
      kind: "shopping_item",
      description: "Organic where possible",
      priority: "high",
      dueDate: "2026-12-01",
      shoppingItems: [
        { id: "1", name: "Oat Milk", qty: "2", category: "dairy", done: false },
        { id: "2", name: "   ", qty: "1", category: "other", done: false },
        { id: "3", name: "Dish Soap", qty: "1", category: "household", done: true },
      ],
    })

    assert.equal(payload.title, "Weekly Groceries")
    assert.equal(payload.task_kind, "shopping_item")
    assert.equal(payload.priority, 2)
    assert.equal(payload.description, "Organic where possible")
    assert.equal(payload.due_date, "2026-12-01")
    assert.equal("board_id" in payload, false)
    assert.equal("item_kind" in payload, false)

    const cf = payload.custom_fields as { items: Array<{ name: string; qty: string; category: string; checked: boolean }> }
    assert.equal(cf.items.length, 2)
    assert.deepEqual(cf.items[0], { name: "Oat Milk", qty: "2", category: "dairy", checked: false })
    assert.deepEqual(cf.items[1], { name: "Dish Soap", qty: "1", category: "household", checked: true })

    const cl = payload.checklists as Array<{ text: string; done: boolean }>
    assert.equal(cl.length, 2)
    assert.equal(cl[0]?.text, "Oat Milk (2)")
    assert.equal(cl[1]?.text, "Dish Soap")
    assert.equal(cl[1]?.done, true)
  })

  it("serializes checklist steps cleanly and skips blank entries", () => {
    const payload = buildQuickCapturePayload({
      title: "Evening Closeout",
      kind: "checklist",
      priority: "medium",
      checklistSteps: [
        { id: "c1", text: "Lock back door", done: false },
        { id: "c2", text: "   ", done: false },
        { id: "c3", text: "Start dishwasher", done: true },
      ],
    })

    assert.equal(payload.task_kind, "checklist")
    assert.equal(payload.priority, 3)
    assert.equal("custom_fields" in payload, false)
    const cl = payload.checklists as Array<{ id: string; text: string; done: boolean }>
    assert.deepEqual(cl, [
      { id: "c1", text: "Lock back door", done: false },
      { id: "c3", text: "Start dishwasher", done: true },
    ])
  })

  it("exposes standard shopping categories", () => {
    assert.ok(SHOPPING_CATEGORIES.some((c) => c.value === "produce"))
    assert.ok(SHOPPING_CATEGORIES.some((c) => c.value === "dairy"))
    assert.ok(SHOPPING_CATEGORIES.some((c) => c.value === "household"))
  })
})
