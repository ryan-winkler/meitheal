import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"
import { apiError, apiJson, apiProblem } from "../../lib/api-response"
import { canManageSystemSettings, isSecretSetting, isSystemSetting, requireSystemSettingsAdmin, REDACTED_SETTING_VALUE } from "../../lib/settings-security"

function settingsJson(data: unknown): Response {
  const response = apiJson(data)
  response.headers.set("Cache-Control", "no-store")
  return response
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
      if (!admin && isSystemSetting(key)) return requireSystemSettingsAdmin(request, locals)!
      const values = await repo.getByKeys([key])
      const value = Object.hasOwn(values, key) ? values[key] : null
      if (isSecretSetting(key)) {
        return settingsJson({ key, value: value ? REDACTED_SETTING_VALUE : null, configured: Boolean(value) })
      }
      return settingsJson({ key, value })
    }

    const rows = await repo.getAll()
    const settings: Record<string, unknown> = Object.create(null)
    for (const row of rows) {
      const k = String(row.key)
      if (!admin && isSystemSetting(k)) continue
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
    const repo = new SettingsRepository(getPersistenceClient())
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
    if (isSystemSetting(key)) {
      const denied = requireSystemSettingsAdmin(request, locals)
      if (denied) return denied
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

    await repo.upsert(key, value)
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
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
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
