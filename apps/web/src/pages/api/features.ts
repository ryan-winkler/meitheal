import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { FEATURE_DEFAULTS, getFeatureFlags } from "../../lib/feature-flags"
import { apiJson, apiError } from "../../lib/api-response"

/**
 * Features API — toggle optional features on/off
 *
 * GET  /api/features  → returns all features with current state + metadata
 * PUT  /api/features  → toggle a feature { feature: "gamification", enabled: false }
 *
 * @domain tasks (cross-cutting)
 * @bounded-context settings
 */

export const GET: APIRoute = async () => {
  try {
    const flags = await getFeatureFlags()
    const features = Object.entries(FEATURE_DEFAULTS).map(([name, def]) => ({
      name,
      enabled: flags[name] ?? def.default,
      ...def,
    }))
    return apiJson({ features })
  } catch {
    return apiError("Failed to load feature flags")
  }
}

export const PUT: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const feature = String(body.feature || "").trim()
    const enabled = Boolean(body.enabled)

    if (!feature || !(feature in FEATURE_DEFAULTS)) {
      return apiError(`Unknown feature: ${feature}. Valid: ${Object.keys(FEATURE_DEFAULTS).join(", ")}`, 400)
    }

    await repo.upsert(`feature_${feature}`, JSON.stringify(enabled))

    return apiJson({
      feature,
      enabled,
      updated_at: Date.now(),
    })
  } catch {
    return apiError("Failed to update feature flag")
  }
}
