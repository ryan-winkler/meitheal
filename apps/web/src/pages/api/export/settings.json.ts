import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { findAllRules } from "@domains/strategy/rule-repository"
import { getAllOverrides } from "@domains/strategy/framework-repository"
import { exportFilename } from "../../../lib/export-filename"
import { logApiError } from "../../../lib/api-logger"

export const GET: APIRoute = async () => {
    try {
        await ensureSchema()
        const repo = new SettingsRepository(getPersistenceClient())
        await repo.ensureSettingsTable()

        const rows = await repo.getAll()

        // Secrets that MUST NOT be exported
        const EXCLUDED_KEYS = new Set([
            "caldav_password_enc",
            "ha_token",
            "n8n_api_key",
            "n8n_signing_secret",
            "webhook_secret",
            "grocy_api_key",
        ])

        // Convert array of rows into a key-value object, excluding secrets
        const settingsObject: Record<string, string> = {}
        for (const row of rows) {
            if (row.key && row.value !== null && !EXCLUDED_KEYS.has(row.key as string)) {
                settingsObject[row.key as string] = row.value as string
            }
        }

        // Include rules and framework configs for complete backup
        const rules = await findAllRules()
        const frameworkOverrides = await getAllOverrides()

        const exportPayload = {
            _version: 2,
            _exportedAt: new Date().toISOString(),
            settings: settingsObject,
            rules,
            frameworkOverrides,
        }

        const dataStr = JSON.stringify(exportPayload, null, 2)

        return new Response(dataStr, {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Content-Disposition": `attachment; filename="${exportFilename("Settings", "json")}"`,
            },
        })
    } catch (error) {
        logApiError("export-settings", "Failed to export settings as JSON", error)
        return new Response(JSON.stringify({ error: "Settings Export failed" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        })
    }
}

