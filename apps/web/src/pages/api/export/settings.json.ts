import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { currentSettingsAccess } from "../../../lib/current-settings-access"
import { findAllRules } from "@domains/strategy/rule-repository"
import { getAllOverrides } from "@domains/strategy/framework-repository"
import { exportFilename } from "../../../lib/export-filename"
import { logApiError } from "../../../lib/api-logger"
import { apiProblem } from "../../../lib/api-response"
import { isSecretSetting } from "../../../lib/settings-security"

export const GET: APIRoute = async ({ request, locals }) => {
    if (!locals.hassIsAdmin || locals.agentToken) {
        return apiProblem({ status: 403, title: "Admin Required", detail: "Settings export requires admin access" })
    }
    const access = await currentSettingsAccess(request, locals, true)
    if (access instanceof Response) return access
    try {
        await ensureSchema()
        const repo = new SettingsRepository(getPersistenceClient())
        await repo.ensureSettingsTable()

        const rows = await repo.getAll()

        // Credentials and household AI sharing approval are local to the installation.
        const settingsObject: Record<string, unknown> = Object.create(null)
        for (const row of rows) {
            if (row.key && row.key !== "ai-custom-url-approved" && row.value !== null && !isSecretSetting(row.key as string)) {
                try { settingsObject[row.key as string] = JSON.parse(String(row.value)) }
                catch { settingsObject[row.key as string] = row.value }
            }
        }

        // Include rules and framework configs for complete backup
        const rules = await findAllRules()
        const frameworkOverrides = await getAllOverrides()

        const exportPayload = {
            _version: 2,
            _settingsEncoding: "json-values",
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
                "Cache-Control": "no-store",
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

