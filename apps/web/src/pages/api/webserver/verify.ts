/**
 * Webserver Configuration Verification API
 *
 * Thin HTTP adapter delegating verification to `@domains/webserver`.
 *
 * @domain webserver
 * @bounded-context configuration
 */
import type { APIRoute } from "astro"
import { verifyWebserverConfiguration, type WebserverConfigInput } from "@domains/webserver"
import { apiError, apiJson, apiProblem } from "../../../lib/api-response"
import { readWithinLimit } from "../../../lib/bounded-body"
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"

const NO_STORE = { "Cache-Control": "private, no-store" }
const MAX_WEBSERVER_BODY_BYTES = 64 * 1024

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  try {
    const rawBytes = await readWithinLimit(request.body, MAX_WEBSERVER_BODY_BYTES, request.signal)
    if (!rawBytes) {
      return apiProblem({
        status: 413,
        title: "Payload Too Large",
        detail: "Webserver verification payload exceeds 64 KB.",
        extraHeaders: NO_STORE,
      })
    }
    let payload: unknown = null
    try { payload = JSON.parse(new TextDecoder().decode(rawBytes)) } catch { payload = null }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return apiProblem({
        status: 400,
        title: "Invalid Request",
        detail: "Send a JSON object containing webserver settings to verify.",
        extraHeaders: NO_STORE,
      })
    }

    const result = await verifyWebserverConfiguration(request, payload as WebserverConfigInput)
    const body = result.ok
      ? { ok: true, ...result.view, checks: result.checks }
      : { ok: false, error: result.error, field: result.field, checks: result.checks }

    const res = apiJson(body, 200)
    res.headers.set("Cache-Control", "private, no-store")
    return res
  } catch {
    return apiError("Failed to verify webserver settings", 500)
  }
}
