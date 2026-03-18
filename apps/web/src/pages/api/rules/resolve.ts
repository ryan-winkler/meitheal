/**
 * Rule Resolution API — resolves which rules apply to a task context.
 *
 * GET /api/rules/resolve?taskType=epic&labels=urgent,high-priority
 *
 * Used by StrategicEvaluator and AI agents to determine applicable
 * frameworks, AI scopes, and constraints for a given task.
 */
import type { APIRoute } from "astro"
import { findAllRules } from "@domains/strategy/rule-repository"
import { resolveRulesForTask } from "@meitheal/domain-strategy"
import type { TaskType } from "@meitheal/domain-strategy"
import { logApiError } from "@lib/api-logger"

export const GET: APIRoute = async ({ url }) => {
  try {
    const taskType = url.searchParams.get("taskType") as TaskType | null
    const labelsParam = url.searchParams.get("labels")
    const labels = labelsParam ? labelsParam.split(",").map((l) => l.trim()) : []

    if (!taskType) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "VALIDATION_ERROR", message: "taskType is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const allRules = await findAllRules()
    const match = resolveRulesForTask(taskType, labels, allRules)

    return new Response(JSON.stringify({ ok: true, data: match }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("rules", "Failed to resolve rules", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_RESOLVE_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
