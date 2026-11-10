/**
 * n8n Health API — GET /api/integrations/n8n/health
 *
 * Pings the configured n8n instance's health endpoint to determine
 * connection status.
 *
 * @domain integrations
 */
import type { APIRoute } from "astro"
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"
import { getPersistenceClient, ensureSchema } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { extractBaseUrl, jsonResponse, n8nFetch } from "../../../../lib/n8n-fetch"
import { logApiError } from "../../../../lib/api-logger"

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const n8nUrlSetting = await repo.getByKey("n8n_webhook_url")
    if (!n8nUrlSetting?.value) {
      return jsonResponse({ status: "unconfigured" })
    }

    const baseUrl = extractBaseUrl(String(n8nUrlSetting.value))
    const healthUrl = `${baseUrl}/healthz`

    try {
      const res = await n8nFetch(healthUrl, { timeoutMs: 5000 })

      await res.body?.cancel().catch(() => undefined)
      if (res.ok) {
        return jsonResponse({ status: "connected" })
      }
      return jsonResponse({ status: "error", code: res.status })
    } catch {
      return jsonResponse({ status: "unreachable" })
    }
  } catch (err) {
    logApiError("n8n-health", "Failed to check n8n health", err)
    return jsonResponse({ status: "error", message: "Internal server error" }, 500)
  }
}
