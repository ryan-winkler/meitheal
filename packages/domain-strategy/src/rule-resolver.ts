/**
 * Rule Resolver — determines which rules apply to a given task context.
 *
 * Priority ordering: specific type+tag > type-only > tag-only > global
 * AI scope merging: most restrictive for deny actions, union for allows
 */

import type { AIScope, RuleMatch, TaskRule, TaskType } from "./rule-types"
import { DEFAULT_AI_SCOPE } from "./rule-types"

/**
 * Calculate a match specificity score for sorting.
 * Higher = more specific match.
 */
function matchSpecificity(rule: TaskRule, taskType: TaskType, labels: string[]): number {
  let score = 0

  // Type match adds 100 points
  if (rule.taskTypes.length > 0 && rule.taskTypes.includes(taskType)) {
    score += 100
  }

  // Tag match adds 10 points per matching tag
  if (rule.tags.length > 0) {
    const matchingTags = rule.tags.filter((t) => labels.includes(t))
    score += matchingTags.length * 10
  }

  return score
}

/**
 * Check if a rule matches a given task context.
 */
function ruleMatchesTask(rule: TaskRule, taskType: TaskType, labels: string[]): boolean {
  // Rule must be enabled
  if (!rule.enabled) return false

  // Check task type constraint (empty = matches all)
  if (rule.taskTypes.length > 0 && !rule.taskTypes.includes(taskType)) {
    return false
  }

  // Check tag constraint (empty = matches all)
  if (rule.tags.length > 0) {
    const hasMatchingTag = rule.tags.some((t) => labels.includes(t))
    if (!hasMatchingTag) return false
  }

  return true
}

/**
 * Merge AI scopes from multiple rules.
 *
 * Strategy:
 * - Boolean permissions: use OR (any rule allowing = allowed)
 * - Custom instructions: concatenate (each rule adds context)
 */
function mergeAIScopes(scopes: AIScope[]): AIScope {
  if (scopes.length === 0) return { ...DEFAULT_AI_SCOPE }

  return {
    canAutoScore: scopes.some((s) => s.canAutoScore),
    canAutoClose: scopes.some((s) => s.canAutoClose),
    canChangePriority: scopes.some((s) => s.canChangePriority),
    canSuggestLabels: scopes.some((s) => s.canSuggestLabels),
    customInstructions: scopes
      .map((s) => s.customInstructions)
      .filter(Boolean)
      .join("\n"),
  }
}

/**
 * Resolve which rules apply to a task, given its type and labels.
 *
 * @param taskType - The task's type (epic, story, task)
 * @param labels - The task's labels/tags
 * @param allRules - All available rules to match against
 * @returns RuleMatch with matched rules, applicable lenses, merged AI scope, and constraints
 */
export function resolveRulesForTask(
  taskType: TaskType,
  labels: string[],
  allRules: TaskRule[],
): RuleMatch {
  // Find matching rules
  const matchedRules = allRules
    .filter((rule) => ruleMatchesTask(rule, taskType, labels))
    .sort((a, b) => {
      // Sort by priority (lower = higher priority)
      if (a.priority !== b.priority) return a.priority - b.priority
      // Then by specificity (higher = more specific)
      return matchSpecificity(b, taskType, labels) - matchSpecificity(a, taskType, labels)
    })

  // Collect unique lens IDs in priority order
  const lensIdSet = new Set<string>()
  for (const rule of matchedRules) {
    for (const lensId of rule.lensIds) {
      lensIdSet.add(lensId)
    }
  }

  // Merge AI scopes
  const mergedAIScope = mergeAIScopes(matchedRules.map((r) => r.aiScope))

  // Collect constraints
  const constraints = matchedRules
    .map((r) => r.constraints)
    .filter(Boolean)

  return {
    matchedRules,
    applicableLensIds: Array.from(lensIdSet),
    mergedAIScope,
    constraints,
  }
}
