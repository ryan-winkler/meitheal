/**
 * Single Rule API — get, update, or delete a specific rule.
 *
 * GET /api/rules/:id
 * PUT /api/rules/:id
 * DELETE /api/rules/:id
 */
import type { APIRoute } from "astro"
import { findRuleById, updateRule, deleteRule } from "@domains/strategy/rule-repository"

export const GET: APIRoute = async ({ params }) => {
  try {
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
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_FETCH_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const body = await request.json()
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
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_UPDATE_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
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
    return new Response(
      JSON.stringify({ ok: false, errorCode: "RULE_DELETE_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
