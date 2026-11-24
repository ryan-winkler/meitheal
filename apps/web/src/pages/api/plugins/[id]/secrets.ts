/**
 * Write-Only Plugin Secrets API (Admin-Only)
 *
 * Raw secret values are NEVER returned by GET or any other endpoint.
 * Secrets are injected strictly server-side via `{{secret:key}}` headers
 * inside the SSRF-hardened plugin HTTP gateway.
 *
 * @domain plugins
 * @bounded-context plugins
 */
import type { APIRoute } from "astro"
import { getPluginService } from "@domains/plugins"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiJson, apiProblem } from "../../../../lib/api-response"
import { readWithinLimit } from "../../../../lib/bounded-body"
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"

const NO_STORE = { "Cache-Control": "private, no-store" }
const MAX_SECRET_BODY_BYTES = 32 * 1024

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

function pluginJson(data: unknown, status = 200): Response {
  const res = apiJson(data, status)
  res.headers.set("Cache-Control", "private, no-store")
  return res
}

export const GET: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  const id = params.id ?? ""
  const result = await getPluginService().listSecrets(id)
  if (!result.ok) {
    return apiProblem({ status: result.status ?? 400, title: result.errorCode, detail: result.error, extraHeaders: NO_STORE })
  }
  return pluginJson({ secrets: result.data })
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  const id = params.id ?? ""
  const rawBytes = await readWithinLimit(request.body, MAX_SECRET_BODY_BYTES, request.signal)
  if (!rawBytes) {
    return apiProblem({ status: 413, title: "Payload Too Large", detail: "Secret payload exceeds 32 KB.", extraHeaders: NO_STORE })
  }
  let body: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch { body = null }
  if (!body || typeof body.key !== "string" || typeof body.value !== "string") {
    return apiProblem({
      status: 400,
      title: "Invalid Request",
      detail: "Send JSON containing secret key and value.",
      extraHeaders: NO_STORE,
    })
  }
  const result = await getPluginService().setSecret(id, body.key, body.value)
  if (!result.ok) {
    return apiProblem({ status: result.status ?? 400, title: result.errorCode, detail: result.error, extraHeaders: NO_STORE })
  }

  logger.audit({
    event: "audit.plugins.secret_saved",
    domain: "audit",
    component: "plugins-api",
    request_id: crypto.randomUUID(),
    message: "Plugin write-only secret saved",
    metadata: { plugin_id: id, secret_key: body.key },
  })
  return pluginJson(result.data)
}

export const DELETE: APIRoute = async ({ params, request, locals, url }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  const id = params.id ?? ""
  const key = url.searchParams.get("key") ?? ""
  const result = await getPluginService().deleteSecret(id, key)
  if (!result.ok) {
    return apiProblem({ status: result.status ?? 400, title: result.errorCode, detail: result.error, extraHeaders: NO_STORE })
  }

  logger.audit({
    event: "audit.plugins.secret_deleted",
    domain: "audit",
    component: "plugins-api",
    request_id: crypto.randomUUID(),
    message: "Plugin secret removed",
    metadata: { plugin_id: id, secret_key: key },
  })
  return pluginJson(result.data)
}
