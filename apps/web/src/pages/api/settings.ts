import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { AI_HANDOFF_SETTING_KEYS, saveAiHandoffSettings, saveLegacyAiHandoffUrl, SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { currentSettingsAccess } from "../../lib/current-settings-access"
import { parseAiHandoffUrl } from "../../lib/ai-handoff-url"
import { apiError, apiJson, apiProblem } from "../../lib/api-response"
import { canManageSystemSettings, isSecretSetting, isSystemSetting, requireSystemSettingsAdmin, REDACTED_SETTING_VALUE } from "../../lib/settings-security"

function settingsJson(data: unknown): Response {
  const response = apiJson(data)
  response.headers.set("Cache-Control", "no-store")
  return response
}

const aiProviders = new Set(["chatgpt", "claude", "gemini", "ollama", "ha_llm", "custom"])
const noStore = { "cache-control": "private, no-store" }
const isCustomAiProvider = (value: unknown) => value === "custom" || value === "ollama"

async function readAiHandoff(request: Request, locals: App.Locals, repo: SettingsRepository): Promise<Response> {
  const access = await currentSettingsAccess(request, locals, false)
  if (access instanceof Response) return access
  const settings = await repo.getByKeys(AI_HANDOFF_SETTING_KEYS)
  const value = settings["ai-provider"] ?? null
  if (value !== null && (typeof value !== "string" || !aiProviders.has(value))) {
    return apiProblem({ status: 409, detail: "Select a valid AI provider in Settings and retry.", extraHeaders: noStore })
  }
  const result = { key: "ai-provider", value, canUseAssist: access.admin }
  if (!isCustomAiProvider(value)) return settingsJson(result)

  const configured = settings["ai-custom-url"]
  if (!access.admin && (typeof configured !== "string" || configured !== settings["ai-custom-url-approved"])) {
    return apiProblem({ status: 403, title: "URL review required", detail: "Ask an administrator to review and share this custom AI URL in Settings.", extraHeaders: noStore })
  }
  const url = parseAiHandoffUrl(configured)
  if (!url && access.admin) return settingsJson({ ...result, urlProblem: "invalid" })
  if (!url) return apiProblem({ status: 409, title: "Invalid AI URL", detail: "Save a valid custom AI URL in Settings.", extraHeaders: noStore })
  return settingsJson({ ...result, url: url.href })
}

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

/**
 * Settings API — persists user preferences (framework scoring config, etc.)
 * Stores key-value pairs in a `settings` table.
 * Per user request: PM frameworks should be configurable (enable/disable/editable).
 */

export const GET: APIRoute = async ({ request, url, locals }) => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const admin = canManageSystemSettings(request, locals)
    const key = url.searchParams.get("key")
    if (key) {
      if (key === "ai-provider" && url.searchParams.get("handoff") === "1") return await readAiHandoff(request, locals, repo)
      if (!admin && isSystemSetting(key)) return requireSystemSettingsAdmin(request, locals)!
      if (AI_HANDOFF_SETTING_KEYS.includes(key)) {
        const access = await currentSettingsAccess(request, locals, true)
        if (access instanceof Response) return access
      }
      const values = await repo.getByKeys([key])
      const value = Object.hasOwn(values, key) ? values[key] : null
      if (isSecretSetting(key)) {
        return settingsJson({ key, value: value ? REDACTED_SETTING_VALUE : null, configured: Boolean(value) })
      }
      return settingsJson({ key, value })
    }

    const rows = await repo.getAll()
    const canReadHandoffSettings = admin && !((await currentSettingsAccess(request, locals, true)) instanceof Response)
    const settings: Record<string, unknown> = Object.create(null)
    for (const row of rows) {
      const k = String(row.key)
      if (!admin && isSystemSetting(k)) continue
      if (!canReadHandoffSettings && AI_HANDOFF_SETTING_KEYS.includes(k)) continue
      if (isSecretSetting(k)) {
        settings[k] = REDACTED_SETTING_VALUE
        continue
      }
      try {
        settings[k] = JSON.parse(String(row.value))
      } catch {
        settings[k] = String(row.value)
      }
    }
    if (admin) settings["ai-handoff-editable"] = canReadHandoffSettings
    return settingsJson(settings)
  } catch (err) {
    logger.log("error", {
      event: "api.settings.get.failed",
      domain: "tasks",
      component: "settings-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    })
    return apiError("Failed to load settings")
  }
}

export const PUT: APIRoute = async ({ request, locals }) => {
  try {
    await ensureSchema()
    const client = getPersistenceClient()
    const repo = new SettingsRepository(client)
    await repo.ensureSettingsTable()

    const payload: unknown = await request.json().catch(() => null)
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return apiProblem({ status: 400, detail: "Expected a JSON object with a key and value." })
    }
    const body = payload as Record<string, unknown>

    const key = typeof body.key === "string" ? body.key.trim() : ""
    if (!key || key.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(key)) {
      return apiError("key must be 1-100 alphanumeric/hyphen/underscore characters", 400)
    }

    const secret = isSecretSetting(key)
    if (key === "theme" && body.value !== "dark" && body.value !== "light" &&
        body.value !== "auto" && body.value !== "custom") {
      return apiProblem({ status: 400, detail: "Choose Dark, Light, Auto, or Custom." })
    }
    if (isSystemSetting(key) || (key === "theme" && body.value === "custom")) {
      const denied = requireSystemSettingsAdmin(request, locals)
      if (denied) return denied
    }
    if (AI_HANDOFF_SETTING_KEYS.includes(key)) {
      const access = await currentSettingsAccess(request, locals, true)
      if (access instanceof Response) return access
    }
    if (key === "ai-custom-url-approved") {
      return apiProblem({ status: 400, detail: "Review and save the custom AI provider and its sharing choice together.", extraHeaders: noStore })
    }
    if (key === "ai-handoff-editable") {
      return apiProblem({ status: 400, detail: "AI handoff edit availability is read-only.", extraHeaders: noStore })
    }
    if (key === "ai-provider" && ["custom_url", "share_custom_url", "previous_provider", "previous_custom_url", "previously_shared"].some(field => Object.hasOwn(body, field))) {
      const { value, custom_url, share_custom_url, previous_provider, previous_custom_url, previously_shared } = body
      if (typeof value !== "string" || !aiProviders.has(value) ||
          (previous_provider !== null && typeof previous_provider !== "string") ||
          (previous_custom_url !== null && typeof previous_custom_url !== "string") ||
          typeof previously_shared !== "boolean") {
        return apiProblem({ status: 400, detail: "Send a valid AI provider and the previously saved provider, URL and sharing state.", extraHeaders: noStore })
      }
      let destination: { url: string; shared: boolean } | undefined
      if (isCustomAiProvider(value)) {
        const url = parseAiHandoffUrl(custom_url)
        if (!url || JSON.stringify(url.href).length > 10240 || typeof share_custom_url !== "boolean") {
          return apiProblem({ status: 400, detail: "Send a valid custom AI URL and its sharing choice.", extraHeaders: noStore })
        }
        destination = { url: url.href, shared: share_custom_url }
      } else if (Object.hasOwn(body, "custom_url") || Object.hasOwn(body, "share_custom_url")) {
        return apiProblem({ status: 400, detail: "Only custom or Ollama providers accept a custom URL.", extraHeaders: noStore })
      }
      const saved = await saveAiHandoffSettings(client,
        { provider: previous_provider, url: previous_custom_url, shared: previously_shared },
        { provider: value, ...(destination ? { destination } : {}) },
      )
      if (!saved) return apiProblem({ status: 409, detail: "The saved AI provider, URL or sharing choice changed. Reload Settings before reviewing and saving it again.", extraHeaders: noStore })
      return settingsJson({ key, value, ...(destination ? { custom_url: destination.url, share_custom_url: destination.shared } : {}) })
    }
    if (secret && body.value === REDACTED_SETTING_VALUE) {
      const configured = Boolean((await repo.getByKeys([key]))[key])
      return settingsJson({ key, value: configured ? REDACTED_SETTING_VALUE : null, configured })
    }

    if (secret && body.value != null && typeof body.value !== "string") {
      return apiProblem({ status: 400, detail: "Use a text value or null for a credential." })
    }

    const value = JSON.stringify(body.value ?? null)
    const maxSize = key === "custom_theme_css" ? 65536 : 10240
    if (value.length > maxSize) {
      return apiError(`value exceeds ${maxSize > 10240 ? "64KB" : "10KB"} limit`, 400)
    }

    if (key === "custom_theme_css" && Object.hasOwn(body, "name")) {
      const { name } = body
      const css = body.value
      if (typeof css !== "string" || typeof name !== "string" || name.length > 255 ||
          ((css !== "" || name !== "") && (!css.trim() || !name.trim()))) {
        return apiProblem({ status: 400, detail: "Send CSS and a filename, or send both empty to remove the theme." })
      }
      const theme = css ? "custom" : "dark"
      await repo.importBatch([
        { key, value },
        { key: "custom_theme_name", value: JSON.stringify(name) },
        { key: "theme", value: JSON.stringify(theme) },
      ])
      return settingsJson({ key, value: css, name, theme })
    }

    if (key === "ai-custom-url") {
      await saveLegacyAiHandoffUrl(client, body.value ?? null)
    } else {
      await repo.upsert(key, value)
    }
    return settingsJson({
      key,
      value: secret ? (body.value ? REDACTED_SETTING_VALUE : null) : body.value,
      updated_at: Date.now(),
    })
  } catch (err) {
    logger.log("error", {
      event: "api.settings.put.failed",
      domain: "tasks",
      component: "settings-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    })
    return apiError("Failed to save setting")
  }
}

export const DELETE: APIRoute = async ({ request, url, locals }) => {
  const access = await currentSettingsAccess(request, locals, true)
  if (access instanceof Response) return access
  try {
    const reset = url.searchParams.get("reset")
    if (reset !== "all") {
      return apiError("Use ?reset=all to confirm reset", 400)
    }
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()
    await repo.deleteAll()

    logger.audit({
      event: "audit.settings.reset",
      domain: "audit",
      component: "settings-api",
      request_id: crypto.randomUUID(),
      message: "All settings reset to defaults",
    })

    return apiJson({ reset: true })
  } catch (err) {
    logger.log("error", {
      event: "api.settings.delete.failed",
      domain: "tasks",
      component: "settings-api",
      request_id: crypto.randomUUID(),
      message: "Internal server error",
    })
    return apiError("Failed to reset settings")
  }
}
