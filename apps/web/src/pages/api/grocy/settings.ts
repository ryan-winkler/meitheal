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
import { isLegacySupervisorIngressUrl, resolveSupervisorGrocyAddon } from "../../../lib/grocy-client"

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

    if (typeof settings.grocy_url === "string" && isLegacySupervisorIngressUrl(settings.grocy_url)) {
      const detected = await resolveSupervisorGrocyAddon(settings.grocy_url)
      if (detected) {
        settings.grocy_url = detected.url
        await repo.upsert("grocy_url", JSON.stringify(detected.url))
      } else {
        delete settings.grocy_url
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
    let resolvedGrocyUrl: string | undefined

    for (const settingKey of GROCY_SETTINGS_KEYS) {
      if (body[settingKey] !== undefined) {
        let value = JSON.stringify(body[settingKey])

        // Validate
        if (settingKey === "grocy_url") {
          if (typeof body[settingKey] !== "string") {
            return new Response(
              JSON.stringify({ ok: false, error: "Invalid URL format" }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            )
          }
          const urlStr = body[settingKey]
          let trimmedUrl = urlStr.trim()
          if (trimmedUrl && isLegacySupervisorIngressUrl(trimmedUrl)) {
            const detected = await resolveSupervisorGrocyAddon(trimmedUrl)
            if (!detected) {
              return new Response(
                JSON.stringify({ ok: false, error: "Grocy add-on is not running or could not be resolved" }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              )
            }
            trimmedUrl = detected.url
          }
          if (trimmedUrl) {
            const urlCheck = validateGrocyBaseUrl(trimmedUrl)
            if (!urlCheck.ok) {
              return new Response(
                JSON.stringify({ ok: false, error: urlCheck.error }),
                { status: 400, headers: { "Content-Type": "application/json" } },
              )
            }
            resolvedGrocyUrl = urlCheck.normalizedUrl
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

    // Auto-detected UI save may omit grocy_url; populate from running add-on if none saved yet
    if (body.grocy_url === undefined && body.grocy_sync_enabled === true) {
      const existingUrl = await repo.getByKey("grocy_url")
      const existingVal = typeof existingUrl?.value === "string" ? existingUrl.value.trim() : ""
      if (!existingVal || isLegacySupervisorIngressUrl(existingVal)) {
        const detected = existingVal
          ? await resolveSupervisorGrocyAddon(existingVal)
          : await resolveSupervisorGrocyAddon()
        if (detected) {
          resolvedGrocyUrl = detected.url
          await repo.upsert("grocy_url", JSON.stringify(detected.url))
          saved.push("grocy_url")
        }
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        saved,
        ...(resolvedGrocyUrl ? { url: resolvedGrocyUrl } : {}),
        message: `Saved ${saved.length} setting(s)`,
      }),
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
