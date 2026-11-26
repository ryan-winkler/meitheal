import test from "node:test"
import assert from "node:assert/strict"
import { normalizeShoppingItems } from "../../../../packages/domain-tasks/src/domain-model"
import {
  clampShoppingQty,
  formatShoppingItemSummary,
  normalizeShoppingCategories,
  normalizeShoppingUnit,
  parseShoppingCategoriesImport,
} from "./shopping-items"

test("normalizeShoppingItems preserves unit and custom Grocy categories on server payloads", () => {
  const normalized = normalizeShoppingItems([
    { name: "Oat Milk", qty: 2, unit: "carton", category: "dairy-alternatives", checked: false },
    { name: "Apples", qty: 1, unit: "bag", category: "produce", checked: true },
  ])
  assert.deepEqual(normalized, [
    { name: "Oat Milk", qty: 2, unit: "carton", category: "dairy-alternatives", checked: false },
    { name: "Apples", qty: 1, unit: "bag", category: "produce", checked: true },
  ])
})

test("parseShoppingCategoriesImport parses Grocy JSON, CSV with header, and newline lists", () => {
  const fromGrocyJson = parseShoppingCategoriesImport(
    JSON.stringify({ product_groups: [{ id: 1, name: "Organic Produce" }, { id: 2, name: "Bulk Grains" }] }),
  )
  assert.deepEqual(fromGrocyJson, [
    { slug: "organic-produce", label: "Organic Produce" },
    { slug: "bulk-grains", label: "Bulk Grains" },
  ])

  const fromCsv = parseShoppingCategoriesImport("id,name,description\n1,Dairy,Cold\n2,Bakery,Fresh")
  assert.deepEqual(fromCsv, [
    { slug: "dairy", label: "Dairy" },
    { slug: "bakery", label: "Bakery" },
  ])

  const fromLines = parseShoppingCategoriesImport("Snacks\nPet Supplies\nSnacks")
  assert.deepEqual(fromLines, [
    { slug: "snacks", label: "Snacks" },
    { slug: "pet-supplies", label: "Pet Supplies" },
  ])
})

test("clampShoppingQty, normalizeShoppingUnit, and formatShoppingItemSummary handle units cleanly", () => {
  assert.equal(clampShoppingQty(0), 1)
  assert.equal(clampShoppingQty(1200), 999)
  assert.equal(normalizeShoppingUnit("BAG"), "bag")
  assert.equal(normalizeShoppingUnit(""), "pcs")
  assert.equal(formatShoppingItemSummary({ name: "Flour", qty: 2, unit: "bag" }), "2 bag Flour")
  assert.equal(formatShoppingItemSummary({ name: "Eggs", qty: 2, unit: "pcs" }), "2× Eggs")
  assert.equal(formatShoppingItemSummary({ name: "Bread", qty: 1, unit: "pcs" }), "Bread")
  assert.ok(normalizeShoppingCategories("").length > 0)
})
