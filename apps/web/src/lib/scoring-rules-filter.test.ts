import test from "node:test"
import assert from "node:assert/strict"
import {
  normalizeRuleTaskType,
  resolveEnabledFrameworkIds,
  resolveEnabledFrameworksForTask,
} from "./scoring-rules-filter"

test("Simple preset (empty strategic rules) disables RICE and all scoring frameworks", () => {
  const available = [{ id: "rice" }, { id: "eisenhower" }, { id: "wsjf" }]
  const enabled = resolveEnabledFrameworksForTask([], "task", available)
  assert.deepEqual(enabled, [])
})

test("Strategic rules include only frameworks mapped to the current task type", () => {
  const rules = [
    { id: "r1", ruleType: "strategic-lens", taskTypes: ["epic", "story"], lensIds: ["rice", "wsjf"] },
    { id: "r2", ruleType: "strategic-lens", taskTypes: ["task"], lensIds: ["eisenhower"] },
  ]
  const available = [{ id: "rice" }, { id: "eisenhower" }, { id: "wsjf" }]
  assert.deepEqual(
    resolveEnabledFrameworksForTask(rules, "task", available).map(f => f.id),
    ["eisenhower"],
  )
  assert.deepEqual(
    resolveEnabledFrameworksForTask(rules, "epic", available).map(f => f.id),
    ["rice", "wsjf"],
  )
  assert.deepEqual(
    resolveEnabledFrameworksForTask(rules, "documentation", available),
    [],
  )
})

test("normalizeRuleTaskType maps aliases and unknown types safely", () => {
  assert.equal(normalizeRuleTaskType("docs"), "documentation")
  assert.equal(normalizeRuleTaskType("EPIC"), "epic")
  assert.equal(normalizeRuleTaskType("unknown"), "task")
  assert.equal(resolveEnabledFrameworkIds(null, "task"), null)
})
