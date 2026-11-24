/**
 * Single Plugin Management API
 *
 * - GET    /api/plugins/:id  (admin): inspect manifest, config, secret status
 * - PATCH  /api/plugins/:id  (admin): toggle enabled, approve re-consent, save config/userServer
 * - DELETE /api/plugins/:id  (admin): uninstall uploaded plugin + wipe its storage & secrets
 *
 * @domain plugins
 * @bounded-context plugins
 */
import type { APIRoute } from "astro"
import { getPluginService } from "@domains/plugins"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiError, apiJson, apiProblem } from "../../../../lib/api-response"
import { readWithinLimit } from "../../../../lib/bounded-body"
import { requireSystemSettingsAdmin } from "../../../../lib/settings-security"

const NO_STORE = { "Cache-Control": "private, no-store" }
const MAX_PATCH_BODY_BYTES = 64 * 1024

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
  const plugin = await getPluginService().getPlugin(id)
  if (!plugin) {
    return apiProblem({
      status: 404,
      title: "Not Found",
      detail: `Plugin "${id}" was not found.`,
      extraHeaders: NO_STORE,
    })
  }
  return pluginJson({ plugin })
}

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  const id = params.id ?? ""
  const rawBytes = await readWithinLimit(request.body, MAX_PATCH_BODY_BYTES, request.signal)
  if (!rawBytes) {
    return apiProblem({ status: 413, title: "Payload Too Large", detail: "Plugin update payload exceeds 64 KB.", extraHeaders: NO_STORE })
  }
  let body: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch { body = null }
  if (!body) {
    return apiProblem({
      status: 400,
      title: "Invalid Request",
      detail: "Send a JSON object with enabled, approveReconsent, config, or approvedUserServer.",
      extraHeaders: NO_STORE,
    })
  }

  try {
    const result = await getPluginService().updatePlugin(id, {
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(body.approveReconsent === true ? { approveReconsent: true } : {}),
      ...(body.config && typeof body.config === "object" && !Array.isArray(body.config)
        ? { config: body.config as Record<string, unknown> }
        : {}),
      ...(body.approvedUserServer === null || typeof body.approvedUserServer === "string"
        ? { approvedUserServer: body.approvedUserServer }
        : {}),
    })
    if (!result.ok) {
      return apiProblem({
        status: result.status ?? 400,
        title: result.errorCode,
        detail: result.error,
        extraHeaders: NO_STORE,
      })
    }

    logger.audit({
      event: "audit.plugins.updated",
      domain: "audit",
      component: "plugins-api",
      request_id: crypto.randomUUID(),
      message: "Plugin configuration updated",
      metadata: {
        plugin_id: id,
        enabled: result.data.enabled,
        needs_reconsent: result.data.needsReconsent,
      },
    })
    return pluginJson({ plugin: result.data })
  } catch {
    return apiError("Failed to update plugin", 500)
  }
}

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  const id = params.id ?? ""
  try {
    const result = await getPluginService().uninstallPlugin(id)
    if (!result.ok) {
      return apiProblem({
        status: result.status ?? 400,
        title: result.errorCode,
        detail: result.error,
        extraHeaders: NO_STORE,
      })
    }
    logger.audit({
      event: "audit.plugins.uninstalled",
      domain: "audit",
      component: "plugins-api",
      request_id: crypto.randomUUID(),
      message: "Uploaded plugin uninstalled",
      metadata: { plugin_id: id },
    })
    return pluginJson(result.data)
  } catch {
    return apiError("Failed to uninstall plugin", 500)
  }
}
