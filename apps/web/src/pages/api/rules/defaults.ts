/**
 * Rules Defaults API — POST: restore all rules to the "Strategic" preset
 *
 * Atomically replaces all existing rules and framework overrides with
 * the default 3-rule Strategic preset. Used by the "Restore Defaults"
 * button in Settings. Also accessible by HA LLM API and AI agents.
 *
 * @domain strategy
 */
import type { APIRoute } from "astro"
import { ensureSchema } from "@domains/tasks/persistence/store"
import { replaceRules } from "@domains/strategy/rule-repository"
import { logApiError } from "../../../lib/api-logger"
import type { TaskRule } from "@meitheal/domain-strategy"
import { DEFAULT_AI_SCOPE } from "@meitheal/domain-strategy"

/** The "Strategic" preset — default out-of-box configuration */
const DEFAULT_RULES: Array<Omit<TaskRule, "createdAt" | "updatedAt">> = [
  {
    id: crypto.randomUUID(),
    name: "Epic Default",
    description: "Full strategic scoring for epics — RICE + DDD lenses, AI can auto-score and suggest labels",
    ruleType: "strategic-lens",
    taskTypes: ["epic"],
    tags: [],
    lensIds: ["rice", "ddd"],
    aiScope: { ...DEFAULT_AI_SCOPE, canAutoScore: true, canSuggestLabels: true },
    constraints: "",
    priority: 100,
    enabled: true,
  },
  {
    id: crypto.randomUUID(),
    name: "Story Default",
    description: "Knowledge-centered scoring for stories — RICE + KCS lenses, AI can auto-score and suggest labels",
    ruleType: "strategic-lens",
    taskTypes: ["story"],
    tags: [],
    lensIds: ["rice", "kcs"],
    aiScope: { ...DEFAULT_AI_SCOPE, canAutoScore: true, canSuggestLabels: true },
    constraints: "",
    priority: 100,
    enabled: true,
  },
  {
    id: crypto.randomUUID(),
    name: "Task Default",
    description: "Minimal guardrails for simple tasks — no frameworks, AI stays hands-off",
    ruleType: "strategic-lens",
    taskTypes: ["task"],
    tags: [],
    lensIds: [],
    aiScope: { ...DEFAULT_AI_SCOPE },
    constraints: "",
    priority: 100,
    enabled: true,
  },
]

export const POST: APIRoute = async () => {
  try {
    await ensureSchema()

    const created = await replaceRules(DEFAULT_RULES.map((rule) => ({
      ...rule,
      id: crypto.randomUUID(),
      createdAt: "",
      updatedAt: "",
    })), undefined, true)

    return new Response(
      JSON.stringify({
        ok: true,
        message: "Defaults restored — Strategic preset applied, all framework overrides cleared",
        data: created,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )
  } catch (error) {
    logApiError("rules-defaults", "Failed to restore defaults", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RESTORE_FAILED", message: "Failed to restore defaults" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    )
  }
}
