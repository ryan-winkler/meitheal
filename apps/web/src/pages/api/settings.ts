import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { apiError, apiJson } from "../../lib/api-response"
import { createLogger, defaultRedactionPatterns } from "@meitheal/domain-observability"

const logger = createLogger({
  service: "meitheal-web",
  env: process.env.NODE_ENV ?? "development",
  minLevel: "info",
  enabledCategories: ["tasks", "audit", "observability"],
  redactPatterns: defaultRedactionPatterns,
  auditEnabled: true,
})

const isSensitiveKey = (key: string): boolean => /(?:token|password|secret|api_key|license_key)$/i.test(key)

/**
 * Settings API — persists user preferences (framework scoring config, etc.)
 * Stores key-value pairs in a `settings` table.
 * Per user request: PM frameworks should be configurable (enable/disable/editable).
 */

export const GET: APIRoute = async ({ url }) => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const key = url.searchParams.get("key")
    if (key) {
      const setting = await repo.getByKey(key)
      if (!setting) {
        return apiJson({ key, value: null })
      }
      return apiJson(isSensitiveKey(key) ? { key, value: null, configured: Boolean(setting.value) } : setting)
    }

    // P3.1: Return all settings (filter sensitive keys from bulk response)
    const rows = await repo.getAll()
    const settings: Record<string, unknown> = {}
    for (const row of rows) {
      const k = String(row.key)
      if (isSensitiveKey(k)) {
        settings[k] = null
        settings[`${k}_configured`] = Boolean(row.value && row.value !== "null" && row.value !== '""')
        continue
      }
      try {
        settings[k] = JSON.parse(String(row.value))
      } catch {
        settings[k] = String(row.value)
      }
    }
    return apiJson(settings)
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

export const PUT: APIRoute = async ({ request }) => {
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const key = typeof body.key === "string" ? body.key.trim() : ""
    if (!key || key.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(key)) {
      return apiError("key must be 1-100 alphanumeric/hyphen/underscore characters", 400)
    }

    const value = JSON.stringify(body.value ?? null)
    const maxSize = key === "custom_theme_css" ? 65536 : 10240
    if (value.length > maxSize) {
      return apiError(`value exceeds ${maxSize > 10240 ? "64KB" : "10KB"} limit`, 400)
    }

    await repo.upsert(key, value)
    return apiJson({ key, value: isSensitiveKey(key) ? null : body.value, updated_at: Date.now() })
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

export const DELETE: APIRoute = async ({ url }) => {
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
