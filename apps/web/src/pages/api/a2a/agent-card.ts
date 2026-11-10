import type { APIRoute } from "astro"
import { buildAgentCard } from "@meitheal/integration-core"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { apiError, apiJson } from "../../../lib/api-response"

/**
 * Discovery for Meitheal's experimental A2A endpoints. The well-known
 * aliases share this handler so Home Assistant ingress keeps its scope.
 */
export const GET: APIRoute = async ({ locals }) => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    // Check if A2A is enabled in settings
    const a2aSetting = await repo.getByKey("agent-protocols-a2a-enabled")
    const a2aEnabled = a2aSetting ? a2aSetting.value === true : true // Default: enabled

    if (!a2aEnabled) {
      return new Response(
        JSON.stringify({ error: "A2A protocol is disabled" }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    }

    // Check if HA is configured
    const haSetting = await repo.getByKey("ha-url")
    const haConfigured = !!(haSetting?.value)

    return apiJson(buildAgentCard({
      basePath: locals.ingressPath ?? "",
      haConfigured,
    }))
  } catch {
    return apiError("Failed to generate Agent Card", 500)
  }
}
