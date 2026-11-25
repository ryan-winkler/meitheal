import test from "node:test"
import assert from "node:assert/strict"
import {
  createDefaultEntityFormLayoutConfig,
  createDefaultTaskDetailLayoutConfig,
  isTaskDetailLayoutEqual,
  normalizeTaskDetailLayoutConfig,
  resolveEffectiveEntityFormLayout,
  resolveEffectiveTaskDetailLayout,
  resolveEffectiveTaskDetailLayoutForKind,
} from "./task-detail-layout"

test("migrates legacy flat order map into structured TaskDetailLayoutConfig", () => {
  const normalized = normalizeTaskDetailLayoutConfig({
    sections: ["checklists", "description"],
    properties: ["priority", "status"],
  })
  assert.equal(normalized.orders.sections[0], "checklists")
  assert.equal(normalized.orders.sections[1], "description")
  assert.equal(normalized.orders.properties[0], "priority")
  assert.equal(normalized.orders.properties[1], "status")
  assert.deepEqual(normalized.hidden, {})
  assert.deepEqual(normalized.labels, {})
})

test("sanitizes hidden sets and custom labels, dropping unknown IDs and empty labels", () => {
  const normalized = normalizeTaskDetailLayoutConfig({
    hidden: {
      sections: ["activity", "nonexistent", "activity"],
      properties: ["urgency"],
    },
    labels: {
      properties: "  Key Details  ",
      unknown_id: "Ignored",
      scheduling: "   ",
    },
  })
  assert.deepEqual(normalized.hidden.sections, ["activity"])
  assert.deepEqual(normalized.hidden.properties, ["urgency"])
  assert.equal(normalized.labels.properties, "Key Details")
  assert.equal("unknown_id" in normalized.labels, false)
  assert.equal("scheduling" in normalized.labels, false)
})

test("personal override wins over server default, and server default wins over built-in default", () => {
  const builtIn = createDefaultTaskDetailLayoutConfig()
  const serverDefault = normalizeTaskDetailLayoutConfig({
    hidden: { sections: ["activity"] },
    labels: { properties: "Household Fields" },
  })
  const personal = normalizeTaskDetailLayoutConfig({
    hidden: { sections: ["scoring"] },
    labels: { properties: "My Fields" },
  })

  const fromServer = resolveEffectiveTaskDetailLayout(null, serverDefault)
  assert.equal(fromServer.labels.properties, "Household Fields")
  assert.deepEqual(fromServer.hidden.sections, ["activity"])

  const fromPersonal = resolveEffectiveTaskDetailLayout(personal, serverDefault)
  assert.equal(fromPersonal.labels.properties, "My Fields")
  assert.deepEqual(fromPersonal.hidden.sections, ["scoring"])

  const fromBuiltIn = resolveEffectiveTaskDetailLayout(null, null)
  assert.equal(isTaskDetailLayoutEqual(fromBuiltIn, builtIn), true)
})

test("resolves per-task-kind overrides with fallback to default layout", () => {
  const serverDefault = normalizeTaskDetailLayoutConfig({
    labels: { checklists: "Default Steps" },
    kinds: {
      shopping_item: {
        orders: { sections: ["checklists", "description"] },
        hidden: { sections: ["scoring", "relationships"] },
        labels: { checklists: "Grocery List" },
      },
    },
  })

  const personal = normalizeTaskDetailLayoutConfig({
    labels: { checklists: "Personal Steps" },
    kinds: {
      calendar_event: {
        orders: { sections: ["scheduling", "description"] },
        hidden: { sections: ["scoring"] },
        labels: { scheduling: "Event Time" },
      },
    },
  })

  // Personal override for calendar_event wins
  const eventLayout = resolveEffectiveTaskDetailLayoutForKind(personal, serverDefault, "calendar_event")
  assert.equal(eventLayout.orders.sections[0], "scheduling")
  assert.equal(eventLayout.labels.scheduling, "Event Time")
  assert.deepEqual(eventLayout.hidden.sections, ["scoring"])

  // Server kind override for shopping_item wins when personal has no shopping_item override
  const shoppingLayout = resolveEffectiveTaskDetailLayoutForKind(personal, serverDefault, "shopping_item")
  assert.equal(shoppingLayout.orders.sections[0], "checklists")
  assert.equal(shoppingLayout.labels.checklists, "Grocery List")

  // Unconfigured kind falls back to personal default
  const standardLayout = resolveEffectiveTaskDetailLayoutForKind(personal, serverDefault, "standard_action")
  assert.equal(standardLayout.labels.checklists, "Personal Steps")
})

test("normalizes and resolves entity form layouts (routines, pillars, goals)", () => {
  const serverDefault = normalizeTaskDetailLayoutConfig({
    forms: {
      routine_form: {
        order: ["name", "cadence", "description"],
        hidden: ["project", "bogus_field"],
        labels: { cadence: "Repeat Pattern", bogus_field: "Nope" },
      },
    },
  })

  const routineLayout = resolveEffectiveEntityFormLayout(null, serverDefault, "routine_form")
  assert.equal(routineLayout.order[0], "name")
  assert.equal(routineLayout.order[1], "cadence")
  assert.equal(routineLayout.order[2], "description")
  assert.deepEqual(routineLayout.hidden, ["project"])
  assert.equal(routineLayout.labels.cadence, "Repeat Pattern")
  assert.equal("bogus_field" in routineLayout.labels, false)

  const defaultPillar = resolveEffectiveEntityFormLayout(null, serverDefault, "pillar_form")
  assert.deepEqual(defaultPillar, createDefaultEntityFormLayoutConfig("pillar_form"))
})

test("specialized task kinds resolve to curated reality-matching default layouts", () => {
  const quickCapture = resolveEffectiveTaskDetailLayoutForKind(null, null, "quick_capture")
  assert.ok(quickCapture.hidden.sections?.includes("scoring"))
  assert.ok(quickCapture.hidden.sections?.includes("relationships"))
  assert.ok(quickCapture.hidden.properties?.includes("pillar"))
  assert.ok(quickCapture.hidden.scheduling?.includes("recurrence"))

  const shopping = resolveEffectiveTaskDetailLayoutForKind(null, null, "shopping_item")
  assert.equal(shopping.orders.sections[0], "checklists")
  assert.equal(shopping.labels.checklists, "Shopping Items")
  assert.ok(shopping.hidden.sections?.includes("scoring"))

  const event = resolveEffectiveTaskDetailLayoutForKind(null, null, "calendar_event")
  assert.equal(event.orders.sections[0], "scheduling")
  assert.equal(event.labels.scheduling, "Date & Recurrence")
  assert.ok(event.hidden.sections?.includes("checklists"))

  const routine = resolveEffectiveTaskDetailLayoutForKind(null, null, "routine_instance")
  assert.equal(routine.orders.sections[0], "scheduling")
  assert.equal(routine.orders.scheduling[0], "recurrence")
})
