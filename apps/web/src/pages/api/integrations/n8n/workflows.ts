/**
 * n8n Workflows API — GET /api/integrations/n8n/workflows
 *
 * Fetches the list of active workflows from the configured n8n API.
 * Requires n8n_api_key and n8n_webhook_url to derive the base URL.
 *
 * @domain integrations
 */
import type { APIRoute } from "astro"
import { getPersistenceClient, ensureSchema } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { extractBaseUrl, jsonResponse, n8nFetch } from "../../../../lib/n8n-fetch"
import { logApiError } from "../../../../lib/api-logger"

/** Workflow shape returned by n8n's /api/v1/workflows */
interface N8nWorkflow {
  id: string
  name: string
  active: boolean
  createdAt?: string
  updatedAt?: string
}

export const GET: APIRoute = async () => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const n8nUrlSetting = await repo.getByKey("n8n_webhook_url")
    const n8nKeySetting = await repo.getByKey("n8n_api_key")

    if (!n8nUrlSetting?.value || !n8nKeySetting?.value) {
      return jsonResponse({ success: false, error: "not_configured" })
    }

    const baseUrl = extractBaseUrl(String(n8nUrlSetting.value))
    const workflowsUrl = `${baseUrl}/api/v1/workflows`
    const apiKey = String(n8nKeySetting.value)

    try {
      const res = await n8nFetch(workflowsUrl, {
        timeoutMs: 5000,
        headers: {
          "X-N8N-API-KEY": apiKey,
          "Accept": "application/json",
        },
      })

      if (res.ok) {
        const data = await res.json() as { data?: N8nWorkflow[] }
        const workflows: N8nWorkflow[] = (data.data || []).map((wf) => ({
          id: wf.id,
          name: wf.name,
          active: wf.active,
        }))
        return jsonResponse({ success: true, workflows, count: workflows.length })
      }

      return jsonResponse({ success: false, error: `api_error_${res.status}` })
    } catch {
      return jsonResponse({ success: false, error: "unreachable" })
    }
  } catch (err) {
    logApiError("n8n-workflows", "Failed to fetch n8n workflows", err)
    return jsonResponse({ success: false, error: "internal_error" }, 500)
  }
}
