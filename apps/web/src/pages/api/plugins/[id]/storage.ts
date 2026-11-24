/**
 * Isolated Per-Plugin Key-Value Storage API
 *
 * Enforces browser session auth, active plugin state, Safe Mode off,
 * `storage:local` permission, and 256 KB per-plugin quota.
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
const MAX_STORAGE_BODY_BYTES = 300 * 1024

function pluginJson(data: unknown, status = 200): Response {
  const res = apiJson(data, status)
  res.headers.set("Cache-Control", "private, no-store")
  return res
}

function canUsePluginRuntime(request: Request, locals: App.Locals): boolean {
  if (locals.agentToken) return false
  if (locals.behindIngress && locals.hassUserId) return true
  return canManageSystemSettings(request, locals)
}

export const GET: APIRoute = async ({ params, request, locals, url }) => {
  if (!canUsePluginRuntime(request, locals)) {
    return apiProblem({ status: 403, title: "Forbidden", detail: "Active browser session required.", extraHeaders: NO_STORE })
  }
  const id = params.id ?? ""
  const key = url.searchParams.get("key") ?? undefined
  const result = await getPluginService().readStorage(id, key)
  if (!result.ok) {
    return apiProblem({ status: result.status ?? 400, title: result.errorCode, detail: result.error, extraHeaders: NO_STORE })
  }
  return pluginJson(key ? { key, value: result.data } : { values: result.data })
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
  if (!canUsePluginRuntime(request, locals)) {
    return apiProblem({ status: 403, title: "Forbidden", detail: "Active browser session required.", extraHeaders: NO_STORE })
  }
  const id = params.id ?? ""
  const rawBytes = await readWithinLimit(request.body, MAX_STORAGE_BODY_BYTES, request.signal)
  if (!rawBytes) {
    return apiProblem({ status: 413, title: "Payload Too Large", detail: "Storage payload exceeds 300 KB.", extraHeaders: NO_STORE })
  }
  let body: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(rawBytes))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
  } catch { body = null }
  if (!body || typeof body.key !== "string") {
    return apiProblem({ status: 400, title: "Invalid Request", detail: "Provide key and value in JSON body.", extraHeaders: NO_STORE })
  }
  const result = await getPluginService().writeStorage(id, body.key, body.value ?? null)
  if (!result.ok) {
    return apiProblem({ status: result.status ?? 400, title: result.errorCode, detail: result.error, extraHeaders: NO_STORE })
  }
  return pluginJson(result.data)
}

export const DELETE: APIRoute = async ({ params, request, locals, url }) => {
  if (!canUsePluginRuntime(request, locals)) {
    return apiProblem({ status: 403, title: "Forbidden", detail: "Active browser session required.", extraHeaders: NO_STORE })
  }
  const id = params.id ?? ""
  const key = url.searchParams.get("key") ?? ""
  const result = await getPluginService().deleteStorage(id, key)
  if (!result.ok) {
    return apiProblem({ status: result.status ?? 400, title: result.errorCode, detail: result.error, extraHeaders: NO_STORE })
  }
  return pluginJson(result.data)
}
