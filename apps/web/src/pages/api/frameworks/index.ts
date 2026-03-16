/**
 * Frameworks API — list all framework configs (YAML defaults + overrides).
 *
 * GET /api/frameworks — list all available frameworks with merged configs
 */
import type { APIRoute } from "astro"
import { getAllOverrides } from "@domains/strategy/framework-repository"
import { parseFrameworkConfig, mergeFrameworkConfig } from "@meitheal/domain-strategy"

/**
 * Known built-in framework IDs and their basic metadata.
 * The actual YAML configs are loaded by StrategicEvaluator on the client —
 * this endpoint provides the merged config for API consumers (AI agents, MCP, etc.)
 */
const FRAMEWORK_META: Record<string, { name: string, archetype: string }> = {
  rice: { name: "RICE", archetype: "formula" },
  drice: { name: "DRICE", archetype: "formula" },
  heart: { name: "HEART", archetype: "matrix" },
  ddd: { name: "DDD", archetype: "taxonomy" },
  kcs: { name: "KCS", archetype: "workflow" },
}

export const GET: APIRoute = async () => {
  try {
    const overrides = await getAllOverrides()
    const overrideMap = new Map(overrides.map((o) => [o.frameworkId, o.overrides]))

    const frameworks = Object.entries(FRAMEWORK_META).map(([id, meta]) => {
      const base = parseFrameworkConfig(id, {
        name: meta.name,
        archetype: meta.archetype,
        fields: [],
        badge_thresholds: [],
      })
      return mergeFrameworkConfig(base, overrideMap.get(id) ?? null)
    })

    return new Response(JSON.stringify({ ok: true, data: frameworks }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ ok: false, errorCode: "FRAMEWORKS_FETCH_FAILED", message: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    )
  }
}
