/**
 * Grocy Settings API — Persist Grocy Integration Config
 *
 * GET  /api/grocy/settings — load saved Grocy config
 * PUT  /api/grocy/settings — save URL, API key, sync mode, interval
 *
 * @domain grocy
 * @bounded-context integration
 */
import type { APIRoute } from "astro"
import { validateGrocyBaseUrl } from "@meitheal/integration-core"
import { requireSystemSettingsAdmin } from "../../../lib/settings-security"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { logApiError } from "../../../lib/api-logger"

const GROCY_SETTINGS_KEYS = [
  "grocy_url",
  "grocy_api_key",
  "grocy_sync_mode",
  "grocy_sync_interval",
  "grocy_sync_enabled",
] as const

/**
 * GET /api/grocy/settings — returns all Grocy-related settings
 */
export const GET: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()

    const settings: Record<string, unknown> = {}
    for (const key of GROCY_SETTINGS_KEYS) {
      const result = await repo.getByKey(key)
      if (result) {
        settings[key] = result.value
      }
    }

    // Mask API key for security
    if (settings.grocy_api_key && typeof settings.grocy_api_key === "string") {
      settings.grocy_api_key_masked =
        settings.grocy_api_key.length > 4
          ? "••••" + settings.grocy_api_key.slice(-4)
          : "••••"
      settings.grocy_api_key_set = true
      delete settings.grocy_api_key
    } else {
      settings.grocy_api_key_set = false
    }

    return new Response(JSON.stringify({ ok: true, settings }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  } catch (err) {
    logApiError("grocy-settings", "GET failed", err)
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}

/**
 * PUT /api/grocy/settings
 * Body: { grocy_url?, grocy_api_key?, grocy_sync_mode?, grocy_sync_interval?, grocy_sync_enabled? }
 */
export const PUT: APIRoute = async ({ locals, request }) => {
  const denied = requireSystemSettingsAdmin(request, locals)
  if (denied) return denied
  try {
    let body: Record<string, unknown>

    try {
      body = await request.json()
    } catch {
      return new Response(JSON.stringify({ ok: false, error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    await ensureSchema()
    const repo = new SettingsRepository(getPersistenceClient())
    await repo.ensureSettingsTable()
    const saved: string[] = []

    for (const settingKey of GROCY_SETTINGS_KEYS) {
      if (body[settingKey] !== undefined) {
        let value = JSON.stringify(body[settingKey])

        // Validate
        if (settingKey === "grocy_url" && typeof body[settingKey] === "string") {
          const urlStr = body[settingKey] as string
          const trimmedUrl = urlStr.trim()
          if (trimmedUrl) {
            const urlCheck = validateGrocyBaseUrl(trimmedUrl)
            if (!urlCheck.ok) {
              return new Response(
                JSON.stringify({ ok: false, error: urlCheck.error }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              )
            }
            value = JSON.stringify(urlCheck.normalizedUrl)
          } else if (urlStr.length > 0) {
            return new Response(
              JSON.stringify({ ok: false, error: "Invalid URL format" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            )
          }
        }

        if (settingKey === "grocy_sync_mode") {
          const mode = body[settingKey] as string
          if (!["import", "export", "bidirectional"].includes(mode)) {
            return new Response(
              JSON.stringify({ ok: false, error: "sync_mode must be import, export, or bidirectional" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            )
          }
        }

        await repo.upsert(settingKey, value)
        saved.push(settingKey)
      }
    }

    return new Response(
      JSON.stringify({ ok: true, saved, message: `Saved ${saved.length} setting(s)` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  } catch (err) {
    logApiError("grocy-settings", "PUT failed", err)
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
}
