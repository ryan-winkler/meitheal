import { createTaskRule, DEFAULT_AI_SCOPE, type TaskRule } from "@meitheal/domain-strategy"

export class RuleInputError extends Error {}

/** Validate every rule before a replacement transaction can remove anything. */
export function parseRuleInput(input: unknown): TaskRule {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RuleInputError("Each rule must be an object")
  const value = input as Record<string, unknown>
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 500) {
    throw new RuleInputError("Rule name must contain 1–500 characters")
  }
  for (const key of ["description", "constraints"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].length > 10000)) {
      throw new RuleInputError(`${key} must be text of at most 10000 characters`)
    }
  }
  const ruleType = value.ruleType ?? "strategic-lens"
  if (!["strategic-lens", "ai-scope", "custom"].includes(String(ruleType))) throw new RuleInputError("Invalid rule type")
  for (const key of ["taskTypes", "tags", "lensIds"] as const) {
    const list = value[key]
    if (list !== undefined && (!Array.isArray(list) || list.length > 1000 || list.some((entry) => typeof entry !== "string" || entry.length > 500))) {
      throw new RuleInputError(`${key} must be a list of strings`)
    }
  }
  if ((value.taskTypes as string[] | undefined)?.some((type) => !["epic", "story", "task", "documentation"].includes(type))) {
    throw new RuleInputError("Invalid task type")
  }
  const scope = value.aiScope ?? {}
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) throw new RuleInputError("Invalid AI scope")
  const aiScope = { ...DEFAULT_AI_SCOPE, ...scope }
  for (const key of ["canAutoScore", "canAutoClose", "canChangePriority", "canSuggestLabels"] as const) {
    if (typeof aiScope[key] !== "boolean") throw new RuleInputError(`${key} must be a boolean`)
  }
  if (typeof aiScope.customInstructions !== "string" || aiScope.customInstructions.length > 10000) throw new RuleInputError("Invalid AI instructions")
  if (value.priority !== undefined && (typeof value.priority !== "number" || !Number.isFinite(value.priority))) throw new RuleInputError("Invalid rule priority")
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new RuleInputError("enabled must be a boolean")
  return createTaskRule({
    name: value.name.trim(),
    description: (value.description ?? "") as string,
    constraints: (value.constraints ?? "") as string,
    ruleType: ruleType as TaskRule["ruleType"],
    taskTypes: (value.taskTypes ?? []) as TaskRule["taskTypes"],
    tags: (value.tags ?? []) as string[],
    lensIds: (value.lensIds ?? []) as string[],
    aiScope,
    priority: (value.priority ?? 100) as number,
    enabled: value.enabled !== false,
  })
}
