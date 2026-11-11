import { RuleInputError } from "@domains/strategy/rule-input"
import { apiJson } from "@lib/api-response"
/**
 * Single Rule API — get, update, or delete a specific rule.
 *
 * GET /api/rules/:id
 * PUT /api/rules/:id
 * DELETE /api/rules/:id
 */
import type { APIRoute } from "astro"
import { requireSystemSettingsAdmin } from "@lib/settings-security"
import { findRuleById, updateRule, deleteRule } from "@domains/strategy/rule-repository"
import { logApiError } from "@lib/api-logger"
import { validateSafeId } from "@lib/sanitize-id"

export const GET: APIRoute = async ({ params }) => {
  try {
    const idErr = validateSafeId(params.id, "rule_id")
    if (idErr) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "INVALID_ID", message: idErr }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const rule = await findRuleById(params.id!)
    if (!rule) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "RULE_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ ok: true, data: rule }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("rules", "Failed to fetch rule", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_FETCH_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    const idErr = validateSafeId(params.id, "rule_id")
    if (idErr) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "INVALID_ID", message: idErr }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RuleInputError("Each rule must be an object")
    const updated = await updateRule(params.id!, body)
    if (!updated) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "RULE_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ ok: true, data: updated }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    if (error instanceof RuleInputError) return apiJson({ ok: false, errorCode: "VALIDATION_ERROR", message: error.message }, 400)
    logApiError("rules", "Failed to update rule", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_UPDATE_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    const idErr = validateSafeId(params.id, "rule_id")
    if (idErr) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "INVALID_ID", message: idErr }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      )
    }

    const deleted = await deleteRule(params.id!)
    if (!deleted) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "RULE_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    logApiError("rules", "Failed to delete rule", error)
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_DELETE_FAILED" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
