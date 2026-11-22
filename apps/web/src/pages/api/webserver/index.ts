/**
 * Webserver Configuration API
 *
 * Thin HTTP adapter delegating to `@domains/webserver` service layer
 * (single source of truth across SQLite DB, process.env, .env, and HA Supervisor).
 *
 * @domain webserver
 * @bounded-context configuration
 */
import type { APIRoute } from "astro"
import {
  getUnifiedWebserverState,
  saveWebserverConfiguration,
  type WebserverConfigInput,
} from "@domains/webserver"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiError, apiJson, apiProblem } from "../../../lib/api-response"
import { readWithinLimit } from "../../../lib/bounded-body"
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"

const NO_STORE = { "Cache-Control": "private, no-store" }
const MAX_WEBSERVER_BODY_BYTES = 64 * 1024

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

function webserverJson(data: unknown, status = 200): Response {
  const res = apiJson(data, status)
  res.headers.set("Cache-Control", "private, no-store")
  return res
}

export const GET: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  try {
    return webserverJson(await getUnifiedWebserverState(request))
  } catch {
    logger.log("error", {
      event: "api.webserver.get.failed",
      domain: "webserver",
      component: "webserver-api",
      request_id: crypto.randomUUID(),
      message: "Failed to load webserver configuration",
    })
    return apiError("Failed to load webserver settings", 500)
  }
}

export const PUT: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  try {
    const rawBytes = await readWithinLimit(request.body, MAX_WEBSERVER_BODY_BYTES, request.signal)
    if (!rawBytes) {
      return apiProblem({
        status: 413,
        title: "Payload Too Large",
        detail: "Webserver configuration payload exceeds 64 KB.",
        extraHeaders: NO_STORE,
      })
    }
    let payload: unknown = null
    try { payload = JSON.parse(new TextDecoder().decode(rawBytes)) } catch { payload = null }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return apiProblem({
        status: 400,
        title: "Invalid Request",
        detail: "Send a JSON object containing webserver configuration fields.",
        extraHeaders: NO_STORE,
      })
    }

    const result = await saveWebserverConfiguration(request, payload as WebserverConfigInput)
    if (!result.ok) {
      return apiProblem({
        status: 400,
        title: "Validation Failed",
        detail: result.error,
        extraHeaders: NO_STORE,
      })
    }

    logger.audit({
      event: "audit.webserver.updated",
      domain: "audit",
      component: "webserver-api",
      request_id: crypto.randomUUID(),
      message: "Webserver settings updated",
      metadata: {
        ports_count: result.view.config.ports.length,
        tls_enabled: result.view.config.tlsEnabled,
        bind_address: result.view.config.bindAddress,
        restart_required: result.view.activeRuntime.restartRequired,
        supervisor_synced: result.supervisorSync.synced,
      },
    })

    return webserverJson({
      saved: true,
      ...result.view,
      checks: result.checks,
      supervisorSync: result.supervisorSync,
    })
  } catch {
    logger.log("error", {
      event: "api.webserver.put.failed",
      domain: "webserver",
      component: "webserver-api",
      request_id: crypto.randomUUID(),
      message: "Failed to save webserver configuration",
    })
    return apiError("Failed to save webserver settings", 500)
  }
}
