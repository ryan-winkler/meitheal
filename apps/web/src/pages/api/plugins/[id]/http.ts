/**
 * SSRF-Hardened Outbound HTTP Gateway Route for Plugins
 *
 * Delegates strictly to `PluginService.proxyHttpRequest()`, enforcing:
 *   - Active browser session (no agentToken)
 *   - Plugin enabled + Safe Mode off + `http:outbound` permission
 *   - Exact `allowedHosts` / admin-approved `$userServer` matching
 *   - DNS + IPv4/IPv6 CIDR blocking & redirect blocking
 *   - Server-side `{{secret:key}}` header template injection
 *
 * @domain plugins
 * @bounded-context plugins
 */
import type { APIRoute } from "astro"
import { getPluginService } from "@domains/plugins"
import { apiJson, apiProblem } from "../../../../lib/api-response"
import { readWithinLimit } from "../../../../lib/bounded-body"
import { canManageSystemSettings } from "../../../../lib/settings-security"

const NO_STORE = { "Cache-Control": "private, no-store" }
const MAX_HTTP_BODY_BYTES = 600 * 1024

function pluginJson(data: unknown, status = 200): Response {
  const res = apiJson(data, status)
  res.headers.set("Cache-Control", "private, no-store")
  return res
}

function canUseGateway(request: Request, locals: App.Locals): boolean {
  if (locals.agentToken) return false
  if (locals.behindIngress && locals.hassUserId) return true
  return canManageSystemSettings(request, locals)
}

export const POST: APIRoute = async ({ params, request, locals }) => {
  if (!canUseGateway(request, locals)) {
    return apiProblem({
      status: 403,
      title: "Forbidden",
      detail: "Plugin HTTP gateway requires an active browser session.",
      extraHeaders: NO_STORE,
    })
  }

  const id = params.id ?? ""
  const rawBytes = await readWithinLimit(request.body, MAX_HTTP_BODY_BYTES, request.signal)
  if (!rawBytes) {
    return apiProblem({
      status: 413,
      title: "Payload Too Large",
      detail: "Plugin HTTP gateway request exceeds 600 KB.",
      extraHeaders: NO_STORE,
    })
  }
  let body: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch { body = null }
  if (!body || typeof body.url !== "string") {
    return apiProblem({
      status: 400,
      title: "Invalid Request",
      detail: "Provide method and url in JSON request body.",
      extraHeaders: NO_STORE,
    })
  }

  const headers: Record<string, string> = {}
  if (body.headers && typeof body.headers === "object" && !Array.isArray(body.headers)) {
    for (const [k, v] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v
    }
  }

  const result = await getPluginService().proxyHttpRequest(id, {
    method: typeof body.method === "string" ? body.method : "GET",
    url: body.url,
    headers,
    body: body.body,
    timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
  })

  if (!result.ok) {
    return apiProblem({
      status: result.status ?? 403,
      title: result.errorCode,
      detail: result.error,
      extraHeaders: NO_STORE,
    })
  }

  return pluginJson(result.data)
}
