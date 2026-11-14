import type { APIRoute } from "astro"
import { apiJson } from "@lib/api-response"
import { currentSettingsAccess } from "@lib/current-settings-access"
import { collectRuntimeVitals } from "@lib/runtime-vitals"

/**
 * GET /api/diagnostics — Administrator-only runtime vitals & telemetry snapshot.
 * Intentionally omitted from resolveAgentRouteScope so Bearer mth_... agent tokens
 * fail closed with HTTP 403.
 */
export const GET: APIRoute = async ({ request, locals }) => {
  const access = await currentSettingsAccess(request, locals, true)
  if (access instanceof Response) return access
  const response = apiJson(collectRuntimeVitals(), 200)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
