/**
 * Plugins Catalog, Runtime Bundle, ZIP Install & Safe Mode API
 *
 * - GET /api/plugins            (admin): full catalog + safeMode state
 * - GET /api/plugins?runtime=1  (session): active runtime bundles only (no secrets)
 * - POST /api/plugins           (admin): upload ZIP archive, toggle Safe Mode, or remove all uploaded
 *
 * @domain plugins
 * @bounded-context plugins
 */
import type { APIRoute } from "astro"
import { getPluginService, MAX_ZIP_COMPRESSED_BYTES } from "@domains/plugins"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiError, apiJson, apiProblem } from "../../../lib/api-response"
import { readWithinLimit } from "../../../lib/bounded-body"
import { canManageSystemSettings, requireSystemSettingsAdmin } from "../../../lib/settings-security"

const NO_STORE = { "Cache-Control": "private, no-store" }
const MAX_BASE64_ZIP_CHARS = Math.ceil((MAX_ZIP_COMPRESSED_BYTES * 4) / 3) + 16

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

function canReadPluginRuntime(request: Request, locals: App.Locals): boolean {
  if (locals.agentToken) return false
  if (locals.behindIngress && locals.hassUserId) return true
  return canManageSystemSettings(request, locals)
}

export const GET: APIRoute = async ({ request, locals, url }) => {
  const service = getPluginService()
  const runtimeOnly = url.searchParams.get("runtime") === "1"

  if (runtimeOnly) {
    if (!canReadPluginRuntime(request, locals)) {
      return apiProblem({
        status: 403,
        title: "Forbidden",
        detail: "Plugin runtime bundles require an active browser session.",
        extraHeaders: NO_STORE,
      })
    }
    try {
      const runtime = await service.getRuntimeBundles()
      return pluginJson(runtime)
    } catch {
      return apiError("Failed to load plugin runtime bundles", 500)
    }
  }

  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  try {
    const state = await service.listPlugins()
    return pluginJson({
      ...state,
      limits: {
        maxCompressedBytes: MAX_ZIP_COMPRESSED_BYTES,
      },
    })
  } catch {
    return apiError("Failed to load plugins", 500)
  }
}

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied

  const service = getPluginService()
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""

  try {
    // 1. Multipart form-data ZIP upload (pre-check Content-Length before buffering multipart body)
    if (contentType.includes("multipart/form-data")) {
      const multipartLen = Number(request.headers.get("content-length") ?? 0)
      if (Number.isFinite(multipartLen) && multipartLen > MAX_ZIP_COMPRESSED_BYTES + 65_536) {
        return apiProblem({
          status: 413,
          title: "Archive Too Large",
          detail: "Plugin ZIP archive exceeds the 2 MB compressed size limit.",
          extraHeaders: NO_STORE,
        })
      }
      const formData = await request.formData()
      const file = formData.get("file")
      if (!(file instanceof File)) {
        return apiProblem({
          status: 400,
          title: "Missing File",
          detail: 'Upload a .zip file in the "file" form field.',
          extraHeaders: NO_STORE,
        })
      }
      if (file.size > MAX_ZIP_COMPRESSED_BYTES) {
        return apiProblem({
          status: 413,
          title: "Archive Too Large",
          detail: "Plugin ZIP archive exceeds the 2 MB compressed size limit.",
          extraHeaders: NO_STORE,
        })
      }
      const zipBuffer = Buffer.from(await file.arrayBuffer())
      const result = await service.installFromZip(zipBuffer)
      if (!result.ok) {
        return apiProblem({
          status: result.status ?? 400,
          title: result.errorCode,
          detail: result.error,
          extraHeaders: NO_STORE,
        })
      }
      logger.audit({
        event: "audit.plugins.installed",
        domain: "audit",
        component: "plugins-api",
        request_id: crypto.randomUUID(),
        message: "Uploaded plugin archive installed",
        metadata: {
          plugin_id: result.data.id,
          version: result.data.manifest.version,
          type: result.data.manifest.type,
          needs_reconsent: result.data.needsReconsent,
        },
      })
      return pluginJson({ installed: true, plugin: result.data }, 201)
    }

    // 2. Raw application/zip upload (stream-bounded before allocation)
    if (contentType.includes("application/zip") || contentType.includes("application/octet-stream")) {
      const contentLen = Number(request.headers.get("content-length") ?? 0)
      if (Number.isFinite(contentLen) && contentLen > MAX_ZIP_COMPRESSED_BYTES) {
        return apiProblem({
          status: 413,
          title: "Archive Too Large",
          detail: "Plugin ZIP archive exceeds the 2 MB compressed size limit.",
          extraHeaders: NO_STORE,
        })
      }
      const bounded = await readWithinLimit(request.body, MAX_ZIP_COMPRESSED_BYTES, request.signal)
      if (!bounded) {
        return apiProblem({
          status: 413,
          title: "Archive Too Large",
          detail: "Plugin ZIP archive exceeds the 2 MB compressed size limit.",
          extraHeaders: NO_STORE,
        })
      }
      const rawBuf = Buffer.from(bounded)
      const result = await service.installFromZip(rawBuf)
      if (!result.ok) {
        return apiProblem({
          status: result.status ?? 400,
          title: result.errorCode,
          detail: result.error,
          extraHeaders: NO_STORE,
        })
      }
      logger.audit({
        event: "audit.plugins.installed",
        domain: "audit",
        component: "plugins-api",
        request_id: crypto.randomUUID(),
        message: "Uploaded raw plugin ZIP installed",
        metadata: {
          plugin_id: result.data.id,
          version: result.data.manifest.version,
        },
      })
      return pluginJson({ installed: true, plugin: result.data }, 201)
    }

    // 3. JSON administrative actions (Safe Mode, remove all uploaded, AI bundle, base64 ZIP)
    const maxJsonBytes = MAX_BASE64_ZIP_CHARS + 4096
    const jsonContentLen = Number(request.headers.get("content-length") ?? 0)
    if (Number.isFinite(jsonContentLen) && jsonContentLen > maxJsonBytes) {
      return apiProblem({
        status: 413,
        title: "Payload Too Large",
        detail: "Plugin JSON payload exceeds the maximum allowed size.",
        extraHeaders: NO_STORE,
      })
    }
    const rawJsonBytes = await readWithinLimit(request.body, maxJsonBytes, request.signal)
    if (!rawJsonBytes) {
      return apiProblem({
        status: 413,
        title: "Payload Too Large",
        detail: "Plugin JSON payload exceeds the maximum allowed size.",
        extraHeaders: NO_STORE,
      })
    }
    let parsedBody: unknown = null
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(rawJsonBytes))
    } catch {
      parsedBody = null
    }
    const body = parsedBody as Record<string, unknown> | null
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return apiProblem({
        status: 400,
        title: "Invalid Request",
        detail: "Send multipart/form-data (.zip) or a valid JSON action.",
        extraHeaders: NO_STORE,
      })
    }

    if (body.action === "set_safe_mode") {
      if (typeof body.safeMode !== "boolean") {
        return apiProblem({
          status: 400,
          title: "Invalid Request",
          detail: "safeMode must be a boolean.",
          extraHeaders: NO_STORE,
        })
      }
      const next = await service.setSafeMode(body.safeMode)
      logger.audit({
        event: "audit.plugins.safe_mode",
        domain: "audit",
        component: "plugins-api",
        request_id: crypto.randomUUID(),
        message: "Plugin Safe Mode updated",
        metadata: { safe_mode: next.safeMode },
      })
      return pluginJson(next)
    }

    if (body.action === "remove_all_uploaded") {
      const removed = await service.removeAllUploadedPlugins()
      logger.audit({
        event: "audit.plugins.remove_all_uploaded",
        domain: "audit",
        component: "plugins-api",
        request_id: crypto.randomUUID(),
        message: "All uploaded plugins removed",
        metadata: { removed_count: removed.removedCount },
      })
      return pluginJson(removed)
    }

    if (body.action === "install_bundle") {
      const bundle = body.bundle as {
        manifest: unknown
        pluginJs?: string
        indexHtml?: string
        iconSvg?: string
      }
      const result = await service.installFromBundle(bundle)
      if (!result.ok) {
        return apiProblem({
          status: result.status ?? 400,
          title: result.errorCode,
          detail: result.error,
          extraHeaders: NO_STORE,
        })
      }
      logger.audit({
        event: "audit.plugins.installed",
        domain: "audit",
        component: "plugins-api",
        request_id: crypto.randomUUID(),
        message: "Plugin bundle installed from AI builder",
        metadata: {
          plugin_id: result.data.id,
          version: result.data.manifest.version,
          type: result.data.manifest.type,
          via: "ai_bundle",
          needs_reconsent: result.data.needsReconsent,
        },
      })
      return pluginJson({ installed: true, plugin: result.data }, 201)
    }

    if (body.action === "install_base64" && typeof body.zipBase64 === "string") {
      if (body.zipBase64.length > MAX_BASE64_ZIP_CHARS) {
        return apiProblem({
          status: 413,
          title: "Archive Too Large",
          detail: "Encoded plugin ZIP exceeds the 2 MB compressed size limit.",
          extraHeaders: NO_STORE,
        })
      }
      const zipBuffer = Buffer.from(body.zipBase64, "base64")
      const result = await service.installFromZip(zipBuffer)
      if (!result.ok) {
        return apiProblem({
          status: result.status ?? 400,
          title: result.errorCode,
          detail: result.error,
          extraHeaders: NO_STORE,
        })
      }
      logger.audit({
        event: "audit.plugins.installed",
        domain: "audit",
        component: "plugins-api",
        request_id: crypto.randomUUID(),
        message: "Base64 plugin ZIP installed",
        metadata: {
          plugin_id: result.data.id,
          version: result.data.manifest.version,
          via: "base64",
        },
      })
      return pluginJson({ installed: true, plugin: result.data }, 201)
    }

    return apiProblem({
      status: 400,
      title: "Unsupported Action",
      detail: "Use multipart ZIP upload, install_bundle, set_safe_mode, or remove_all_uploaded.",
      extraHeaders: NO_STORE,
    })
  } catch {
    return apiError("Plugin operation failed", 500)
  }
}
