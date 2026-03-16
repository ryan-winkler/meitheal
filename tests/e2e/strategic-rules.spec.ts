/**
 * Strategic Rules Engine — Domain Tests
 *
 * Tests rule resolution logic and weighted RICE scoring from domain-strategy.
 * These tests run as pure Node.js logic using Playwright's test runner.
 *
 * @domain strategy
 */
import { expect, test } from "@playwright/test"
import { resolveRulesForTask, calculateWeightedRiceScore } from "@meitheal/domain-strategy"
import type { TaskRule } from "@meitheal/domain-strategy"

// ─── Test Data ──────────────────────────────────────────────────────

const epicRule: TaskRule = {
  id: "r-epic",
  name: "Epic Default",
  description: "",
  ruleType: "strategic-lens",
  taskTypes: ["epic"],
  tags: [],
  lensIds: ["rice", "ddd"],
  aiScope: {
    canAutoScore: true,
    canAutoClose: false,
    canChangePriority: false,
    canSuggestLabels: true,
    customInstructions: "",
  },
  constraints: "",
  priority: 100,
  enabled: true,
  createdAt: "",
  updatedAt: "",
}

const storyRule: TaskRule = {
  id: "r-story",
  name: "Story Default",
  description: "",
  ruleType: "strategic-lens",
  taskTypes: ["story"],
  tags: [],
  lensIds: ["rice", "kcs"],
  aiScope: {
    canAutoScore: true,
    canAutoClose: false,
    canChangePriority: false,
    canSuggestLabels: true,
    customInstructions: "",
  },
  constraints: "",
  priority: 100,
  enabled: true,
  createdAt: "",
  updatedAt: "",
}

const taskDefaultRule: TaskRule = {
  id: "r-task",
  name: "Task Default",
  description: "",
  ruleType: "strategic-lens",
  taskTypes: ["task"],
  tags: [],
  lensIds: [],
  aiScope: {
    canAutoScore: false,
    canAutoClose: false,
    canChangePriority: false,
    canSuggestLabels: false,
    customInstructions: "",
  },
  constraints: "",
  priority: 100,
  enabled: true,
  createdAt: "",
  updatedAt: "",
}

const urgentTagRule: TaskRule = {
  id: "r-urgent",
  name: "Urgent Tag Override",
  description: "",
  ruleType: "strategic-lens",
  taskTypes: [],
  tags: ["urgent"],
  lensIds: ["rice"],
  aiScope: {
    canAutoScore: true,
    canAutoClose: true,
    canChangePriority: true,
    canSuggestLabels: true,
    customInstructions: "Treat as urgent",
  },
  constraints: "",
  priority: 50,
  enabled: true,
  createdAt: "",
  updatedAt: "",
}

const allRules = [epicRule, storyRule, taskDefaultRule, urgentTagRule]

// ─── Rule Resolution ────────────────────────────────────────────────
// API: resolveRulesForTask(taskType, labels, allRules) → RuleMatch
// RuleMatch: { matchedRules, applicableLensIds, mergedAIScope, constraints }

test("resolves rules for epic type → RICE + DDD lenses", () => {
  const match = resolveRulesForTask("epic", [], allRules)
  expect(match.applicableLensIds).toEqual(["rice", "ddd"])
  expect(match.mergedAIScope.canAutoScore).toBe(true)
})

test("resolves rules for story type → RICE + KCS lenses", () => {
  const match = resolveRulesForTask("story", [], allRules)
  expect(match.applicableLensIds).toEqual(["rice", "kcs"])
})

test("resolves rules for task type → no lenses, AI off", () => {
  const match = resolveRulesForTask("task", [], allRules)
  expect(match.applicableLensIds).toEqual([])
  expect(match.mergedAIScope.canAutoScore).toBe(false)
})

test("tag-based rule matches when task has matching label", () => {
  const match = resolveRulesForTask("task", ["urgent"], allRules)
  // Urgent rule (priority 50) + task rule (priority 100) both match
  // Urgent rule's lensIds are included
  expect(match.applicableLensIds).toContain("rice")
  expect(match.mergedAIScope.canAutoClose).toBe(true)
})

test("empty rules array returns empty match", () => {
  const match = resolveRulesForTask("epic", [], [])
  expect(match.applicableLensIds).toEqual([])
  expect(match.matchedRules).toEqual([])
})

test("disabled rules are excluded from resolution", () => {
  const disabled: TaskRule = { ...epicRule, id: "r-disabled", enabled: false }
  const match = resolveRulesForTask("epic", [], [disabled])
  expect(match.applicableLensIds).toEqual([])
  expect(match.matchedRules).toHaveLength(0)
})

// ─── Weighted RICE Score ────────────────────────────────────────────
// Formula: (reach × w_r × impact × w_i × (confidence/100) × w_c) / (effort × w_e)

test("calculateWeightedRiceScore with equal unit weights", () => {
  const score = calculateWeightedRiceScore(
    { reach: 10, impact: 3, confidence: 100, effort: 5 },
    { reach: 1, impact: 1, confidence: 1, effort: 1 },
  )
  // (10×1 × 3×1 × (100/100)×1) / (5×1) = 30/5 = 6
  expect(score).toBe(6)
})

test("calculateWeightedRiceScore applies weight multipliers", () => {
  const score = calculateWeightedRiceScore(
    { reach: 10, impact: 3, confidence: 100, effort: 5 },
    { reach: 2, impact: 1, confidence: 1, effort: 1 },
  )
  // (10×2 × 3×1 × (100/100)×1) / (5×1) = 60/5 = 12
  expect(score).toBe(12)
})

test("calculateWeightedRiceScore handles zero effort → returns 0", () => {
  const score = calculateWeightedRiceScore(
    { reach: 10, impact: 3, confidence: 100, effort: 0 },
    { reach: 1, impact: 1, confidence: 1, effort: 1 },
  )
  // Zero effort guard
  expect(score).toBe(0)
})
