/**
 * Task Context Rules — Type definitions
 *
 * Rules are structured metadata attached to tasks that:
 * 1. Tell humans what evaluation framework applies and how to use it
 * 2. Tell AI agents what they can/should do with the task
 * 3. Are editable — users configure rules per task type, tag, or custom criteria
 * 4. Progressively load — name/description first, full detail on activation
 *
 */

/** Task types from domain-tasks */
export type TaskType = "epic" | "story" | "task" | "documentation"

/** Rule types that can be assigned to tasks */
export type RuleType = "strategic-lens" | "ai-scope" | "custom"

/** Preset identifiers for zero-config setup */
export type PresetId = "strategic" | "ux-focused" | "simple" | "agile-delivery" | "balanced"

/**
 * AI scope — defines what AI agents can/should do with a task.
 * Machine-parseable guardrails, not automation triggers.
 */
export interface AIScope {
  /** AI may auto-calculate framework scores (RICE, HEART, etc.) */
  canAutoScore: boolean
  /** AI may auto-close/complete the task */
  canAutoClose: boolean
  /** AI may change task priority */
  canChangePriority: boolean
  /** AI may suggest labels/tags */
  canSuggestLabels: boolean
  /** Free-text instructions for AI agents (injected into system prompt context) */
  customInstructions: string
}

/**
 * A single task context rule.
 *
 * Rules are the primary unit of configuration in the guardrails layer.
 * They determine which strategic lenses apply, what AI can do, and
 * any custom constraints — all scoped by task type and/or tags.
 */
export interface TaskRule {
  id: string
  /** Human-readable name (shown in settings, badges, and rule lists) */
  name: string
  /** Short description (progressive disclosure — shown in listings before full detail) */
  description: string
  /** Categorization of the rule */
  ruleType: RuleType
  /** Which task types this rule applies to (empty = all types) */
  taskTypes: TaskType[]
  /** Which tags/labels trigger this rule (empty = no tag filtering) */
  tags: string[]
  /** Framework IDs this rule activates (e.g. ["rice", "ddd"]) */
  lensIds: string[]
  /** AI scope guardrails */
  aiScope: AIScope
  /** Custom constraint notes (human-readable, AI-readable as context) */
  constraints: string
  /** Priority for conflict resolution (lower number = higher priority) */
  priority: number
  /** Whether this rule is active */
  enabled: boolean
  /** ISO timestamp */
  createdAt: string
  /** ISO timestamp */
  updatedAt: string
}

/**
 * Result of rule resolution for a specific task context.
 * Returned by resolveRulesForTask().
 */
export interface RuleMatch {
  /** The rules that matched, in priority order */
  matchedRules: TaskRule[]
  /** Merged set of framework IDs to apply */
  applicableLensIds: string[]
  /** Merged AI scope (most restrictive wins for deny, most permissive for allow) */
  mergedAIScope: AIScope
  /** Combined constraints from all matching rules */
  constraints: string[]
}

/** Default AI scope — conservative (AI suggests, human decides) */
export const DEFAULT_AI_SCOPE: AIScope = {
  canAutoScore: false,
  canAutoClose: false,
  canChangePriority: false,
  canSuggestLabels: false,
  customInstructions: "",
}

/** Create a new TaskRule with sensible defaults */
export function createTaskRule(partial: Partial<TaskRule> & Pick<TaskRule, "name" | "ruleType">): TaskRule {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    description: "",
    taskTypes: [],
    tags: [],
    lensIds: [],
    aiScope: { ...DEFAULT_AI_SCOPE },
    constraints: "",
    priority: 100,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...partial,
  }
}

/**
 * Default preset definitions for zero-config setup.
 * ADHD-first: ship with sensible defaults, customize later.
 */
export const PRESETS: Record<PresetId, { name: string, description: string, rules: Array<Omit<TaskRule, "id" | "createdAt" | "updatedAt">> }> = {
  strategic: {
    name: "Strategic",
    description: "Full strategic evaluation — RICE + DDD for epics, HEART + KCS for stories",
    rules: [
      {
        name: "Epic Strategic Evaluation",
        description: "Epics get RICE scoring and DDD domain classification",
        ruleType: "strategic-lens",
        taskTypes: ["epic"],
        tags: [],
        lensIds: ["rice", "ddd"],
        aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
      {
        name: "Story UX Evaluation",
        description: "Stories get HEART metrics and KCS documentation tracking",
        ruleType: "strategic-lens",
        taskTypes: ["story"],
        tags: [],
        lensIds: ["heart", "kcs"],
        aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
      {
        name: "Task Lightweight",
        description: "Tasks get KCS only — lightweight documentation tracking",
        ruleType: "strategic-lens",
        taskTypes: ["task"],
        tags: [],
        lensIds: ["kcs"],
        aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
    ],
  },
  "ux-focused": {
    name: "UX-Focused",
    description: "HEART metrics everywhere, KCS for documentation",
    rules: [
      {
        name: "All Types UX Evaluation",
        description: "All task types get HEART and KCS evaluation",
        ruleType: "strategic-lens",
        taskTypes: [],
        tags: [],
        lensIds: ["heart", "kcs"],
        aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
    ],
  },
  "agile-delivery": {
    name: "Agile Delivery",
    description: "WSJF for epics, ICE for stories — SAFe-inspired prioritization",
    rules: [
      {
        name: "Epic WSJF Prioritization",
        description: "Epics use Weighted Shortest Job First for backlog ordering",
        ruleType: "strategic-lens",
        taskTypes: ["epic"],
        tags: [],
        lensIds: ["wsjf", "ddd"],
        aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: true, canSuggestLabels: true, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
      {
        name: "Story ICE Scoring",
        description: "Stories use Impact × Confidence × Ease for quick triage",
        ruleType: "strategic-lens",
        taskTypes: ["story"],
        tags: [],
        lensIds: ["ice", "kcs"],
        aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
      {
        name: "Task Tracking",
        description: "Tasks get lightweight KCS documentation tracking",
        ruleType: "strategic-lens",
        taskTypes: ["task"],
        tags: [],
        lensIds: ["kcs"],
        aiScope: { canAutoScore: false, canAutoClose: false, canChangePriority: false, canSuggestLabels: false, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
    ],
  },
  balanced: {
    name: "Balanced",
    description: "MoSCoW for epics, RICE for stories — balanced strategic + tactical",
    rules: [
      {
        name: "Epic MoSCoW Classification",
        description: "Epics use MoSCoW to classify Must/Should/Could/Won't",
        ruleType: "strategic-lens",
        taskTypes: ["epic"],
        tags: [],
        lensIds: ["moscow", "ddd"],
        aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
      {
        name: "Story RICE Scoring",
        description: "Stories use RICE for objective prioritization",
        ruleType: "strategic-lens",
        taskTypes: ["story"],
        tags: [],
        lensIds: ["rice", "kcs"],
        aiScope: { canAutoScore: true, canAutoClose: false, canChangePriority: false, canSuggestLabels: true, customInstructions: "" },
        constraints: "",
        priority: 10,
        enabled: true,
      },
    ],
  },
  simple: {
    name: "Simple",
    description: "No strategic evaluation — tasks are just tasks",
    rules: [],
  },
}

