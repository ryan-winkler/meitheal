export interface ScoringRuleSummary {
  id?: string
  name?: string
  taskTypes?: unknown
  lensIds?: unknown
  ruleType?: unknown
}

export interface ScoringFrameworkEntry {
  id: string
}

const KNOWN_RULE_TASK_TYPES = new Set(["epic", "story", "task", "documentation"])

export function normalizeRuleTaskType(taskType: unknown): string {
  if (typeof taskType !== "string") return "task"
  const normalized = taskType.trim().toLowerCase()
  if (!normalized) return "task"
  if (normalized === "doc" || normalized === "docs") return "documentation"
  return KNOWN_RULE_TASK_TYPES.has(normalized) ? normalized : "task"
}

/**
 * Resolve which framework IDs are enabled for a given task type from /api/rules.
 *
 * Returns `null` when rules could not be loaded (caller falls back to all frameworks).
 * Returns a `Set<string>` (possibly empty, e.g., Simple preset) when rules are present.
 */
export function resolveEnabledFrameworkIds(
  rules: readonly ScoringRuleSummary[] | null | undefined,
  taskType: unknown,
): Set<string> | null {
  if (!Array.isArray(rules)) return null
  const strategicRules = rules.filter(
    (rule) => !rule.ruleType || rule.ruleType === "strategic-lens",
  )
  // If rules API returned an empty array, no frameworks are configured.
  if (strategicRules.length === 0) return new Set()

  const normalizedType = normalizeRuleTaskType(taskType)
  const matchingRules = strategicRules.filter((rule) => {
    if (!Array.isArray(rule.taskTypes)) return false
    return rule.taskTypes.some(
      (entry: unknown) => normalizeRuleTaskType(entry) === normalizedType,
    )
  })

  if (matchingRules.length === 0) return new Set()

  const enabled = new Set<string>()
  for (const rule of matchingRules) {
    if (!Array.isArray(rule.lensIds)) continue
    for (const lensId of rule.lensIds) {
      if (typeof lensId === "string" && lensId.trim()) {
        enabled.add(lensId.trim().toLowerCase())
      }
    }
  }
  return enabled
}

/**
 * Filter available frameworks by /api/rules for a specific task type.
 * Preserves the caller's framework order and removes disabled frameworks (e.g., RICE under Simple preset).
 */
export function resolveEnabledFrameworksForTask<T extends ScoringFrameworkEntry>(
  rules: readonly ScoringRuleSummary[] | null | undefined,
  taskType: unknown,
  availableFrameworks: readonly T[],
): T[] {
  const enabledIds = resolveEnabledFrameworkIds(rules, taskType)
  if (enabledIds === null) return [...availableFrameworks]
  if (enabledIds.size === 0) return []
  return availableFrameworks.filter((fw) =>
    enabledIds.has(fw.id.trim().toLowerCase()),
  )
}
