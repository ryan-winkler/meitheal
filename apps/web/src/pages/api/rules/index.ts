/**
 * Rules API — list all rules and create new rules.
 *
 * GET /api/rules — list rules (optional ?taskType= and ?tag= filters)
 * POST /api/rules — create a new rule
 */
import type { APIRoute } from "astro"
import { findAllRules, createRule } from "@domains/strategy/rule-repository"
import { createTaskRule } from "@meitheal/domain-strategy"
import type { TaskType } from "@meitheal/domain-strategy"

export const GET: APIRoute = async ({ url }) => {
  try {
    const taskType = url.searchParams.get("taskType") as TaskType | null
    const tag = url.searchParams.get("tag")
    const rules = await findAllRules({
      taskType: taskType ?? undefined,
      tag: tag ?? undefined,
    })
    return new Response(JSON.stringify({ ok: true, data: rules }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULES_FETCH_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json()

    // Validate required fields
    if (!body.name || typeof body.name !== "string") {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "VALIDATION_ERROR", message: "name is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const rule = createTaskRule({
      name: body.name,
      description: body.description ?? "",
      ruleType: body.ruleType ?? "strategic-lens",
      taskTypes: Array.isArray(body.taskTypes) ? body.taskTypes : [],
      tags: Array.isArray(body.tags) ? body.tags : [],
      lensIds: Array.isArray(body.lensIds) ? body.lensIds : [],
      aiScope: body.aiScope ?? undefined,
      constraints: body.constraints ?? "",
      priority: typeof body.priority === "number" ? body.priority : 100,
      enabled: body.enabled !== false,
    })

    const created = await createRule(rule)
    return new Response(JSON.stringify({ ok: true, data: created }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_CREATE_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
