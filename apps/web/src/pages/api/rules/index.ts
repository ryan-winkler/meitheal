/**
 * Rules API — list all rules and create new rules.
 *
 * GET /api/rules — list rules (optional ?taskType= and ?tag= filters)
 * POST /api/rules — create a new rule
 */
import type { APIRoute } from "astro"
import { findAllRules, createRule, replaceRules } from "@domains/strategy/rule-repository"
import { parseRuleInput } from "@domains/strategy/rule-input"
import { ensureSchema } from "@domains/tasks/persistence/store"
import { apiJson } from "@lib/api-response"
import type { TaskType } from "@meitheal/domain-strategy"
import { logApiError } from "@lib/api-logger"

export const GET: APIRoute = async ({ url }) => {
  try {
    await ensureSchema()
    const taskTypeParam = url.searchParams.get("taskType") as TaskType | null
    const tagParam = url.searchParams.get("tag")
    const filter: { taskType?: TaskType; tag?: string } = {}
    if (taskTypeParam) filter.taskType = taskTypeParam
    if (tagParam) filter.tag = tagParam
    const rules = await findAllRules(filter)
    return new Response(JSON.stringify({ ok: true, data: rules }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("rules", "Failed to fetch rules", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULES_FETCH_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const body = await request.json()

    let rule
    try { rule = parseRuleInput(body) } catch (error) {
      return apiJson({ ok: false, errorCode: "VALIDATION_ERROR", message: error instanceof Error ? error.message : "Invalid rule" }, 400)
    }

    const created = await createRule(rule)
    return new Response(JSON.stringify({ ok: true, data: created }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("rules", "Failed to create rule", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_CREATE_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

/** Full replacements are explicit; editor saves replace only the displayed defaults. */
export const PUT: APIRoute = async ({ request }) => {
  let rules
  let replaceIds: string[] | undefined
  try {
    const body = await request.json()
    if (!Array.isArray(body.rules) || body.rules.length > 1000) throw new Error("rules must contain at most 1000 rules")
    rules = body.rules.map(parseRuleInput)
    if (body.replaceIds !== undefined) {
      if (!Array.isArray(body.replaceIds) || body.replaceIds.length > 1000 || body.replaceIds.some((id: unknown) => typeof id !== "string" || id.length > 128)) {
        throw new Error("replaceIds must be a list of rule IDs")
      }
      replaceIds = body.replaceIds
    }
  } catch (error) {
    return apiJson({ ok: false, errorCode: "VALIDATION_ERROR", message: error instanceof Error ? error.message : "Invalid rules" }, 400)
  }
  try {
    await ensureSchema()
    return apiJson({ ok: true, data: await replaceRules(rules, replaceIds) })
  } catch (error) {
    logApiError("rules", "Failed to replace rules", error)
    return apiJson({ ok: false, errorCode: "RULES_REPLACE_FAILED", message: "Rules were not replaced. Your previous configuration is unchanged." }, 500)
  }
}
