import test from "node:test"
import assert from "node:assert/strict"
import {
  createDefaultTaskDetailLayoutConfig,
  isTaskDetailLayoutEqual,
  normalizeTaskDetailLayoutConfig,
  resolveEffectiveTaskDetailLayout,
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
