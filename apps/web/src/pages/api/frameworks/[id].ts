/**
 * Single Framework API — get or update config overrides for a specific framework.
 *
 * GET /api/frameworks/:id — get framework config with overrides
 * PUT /api/frameworks/:id — save overrides (weights, descriptions)
 * DELETE /api/frameworks/:id — reset to YAML defaults
 */
import type { APIRoute } from "astro"
import { getOverrides, saveOverrides, resetOverrides } from "@domains/strategy/framework-repository"
import { parseFrameworkConfig, mergeFrameworkConfig } from "@meitheal/domain-strategy"
import type { FrameworkOverrides } from "@meitheal/domain-strategy"

/** Minimal metadata for known frameworks */
const FRAMEWORK_META: Record<string, { name: string, archetype: string }> = {
  rice: { name: "RICE", archetype: "formula" },
  drice: { name: "DRICE", archetype: "formula" },
  heart: { name: "HEART", archetype: "matrix" },
  ddd: { name: "DDD", archetype: "taxonomy" },
  kcs: { name: "KCS", archetype: "workflow" },
}

export const GET: APIRoute = async ({ params }) => {
  try {
    const frameworkId = params.id!
    const meta = FRAMEWORK_META[frameworkId]
    if (!meta) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }

    const base = parseFrameworkConfig(frameworkId, {
      name: meta.name,
      archetype: meta.archetype,
      fields: [],
      badge_thresholds: [],
    })
    const overrideRecord = await getOverrides(frameworkId)
    const config = mergeFrameworkConfig(base, overrideRecord?.overrides ?? null)

    return new Response(JSON.stringify({ ok: true, data: config, hasOverrides: !!overrideRecord }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_FETCH_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const PUT: APIRoute = async ({ params, request }) => {
  try {
    const frameworkId = params.id!
    if (!FRAMEWORK_META[frameworkId]) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }

    const body = (await request.json()) as FrameworkOverrides
    const record = await saveOverrides(frameworkId, body)

    return new Response(JSON.stringify({ ok: true, data: record }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_UPDATE_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}

export const DELETE: APIRoute = async ({ params }) => {
  try {
    const frameworkId = params.id!
    if (!FRAMEWORK_META[frameworkId]) {
      return new Response(
        JSON.stringify({ ok: false, errorCode: "FRAMEWORK_NOT_FOUND" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }

    const deleted = await resetOverrides(frameworkId)
    return new Response(JSON.stringify({ ok: true, wasReset: deleted }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORK_RESET_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
