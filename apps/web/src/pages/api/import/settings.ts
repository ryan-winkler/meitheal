import type { APIRoute } from "astro"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { replaceRules } from "@domains/strategy/rule-repository"
import { saveOverrides } from "@domains/strategy/framework-repository"
import { isSecretSetting } from "../../../lib/settings-security"
import { logApiError, logApiWarn } from "../../../lib/api-logger"
import type { TaskRule, FrameworkOverrides } from "@meitheal/domain-strategy"
import { validateFrameworkOverrides } from "@meitheal/domain-strategy"
import { parseRuleInput, RuleInputError } from "@domains/strategy/rule-input"
import { readWithinLimit } from "../../../lib/bounded-body"

/** Known safe setting keys — only these will be imported.
 * IMPORTANT: Update this set when adding new saveSetting() calls.
 * Last audited: 2026-03-16 (Rules Engine) */
const ALLOWED_KEYS = new Set([
    // ── Home Assistant / Connectivity ──
    "ha-url", "ha-token", "ha_url", "ha_token",
    "vikunja-url", "vikunja-token",
    "calendar-entity", "calendar_entity", "cal_entity", "calendar_entities", "caldav_url", "calendar_sync_enabled", "calendar_write_back", "calendar_sync_interval_ms",
    // ── UI Preferences ──
    "default-area", "theme", "default-view", "wip-limit",
    "show-description", "column-order", "locale",
    "sidebar-collapsed", "sidebar_config",
    "timezone", "week_start", "date_format",
    "kanban-group-by", "task-detail-width",
    // ── Notifications ──
    "enable-notifications", "notification-sound", "notification-vibrate",
    // ── Scoring Frameworks ──
    "rice-scoring-enabled", "heart-scoring-enabled", "kcs-scoring-enabled",
    "framework_mapping",
    // ── AI & Agent Protocols ──
    "ai-provider", "ai-custom-url",
    "agent-protocols-a2a-enabled", "agent-protocols-webmcp-enabled", "agent-protocols-mcp-enabled",
    // ── Webhooks & Integrations ──
    "webhook_endpoint", "webhook_secret", "webhook_format",
    "n8n_webhook_url", "n8n_events", "n8n_mode", "n8n_api_key", "n8n_signing_secret",
    "grocy_url", "grocy_api_key", "grocy_sync_mode",
    // ── Todo Sync ──
    "todo_sync_enabled", "todo_entity", "todo_sync_direction",
    // ── Custom Fields ──
    "custom_fields",
    // ── Custom Theme ──
    "custom_theme_css", "custom_theme_name", "accent-color",
])

export const POST: APIRoute = async ({ request, locals }) => {
    if (!locals.hassIsAdmin || locals.agentToken) {
        return new Response(JSON.stringify({ error: "Admin access required for settings import" }), { status: 403, headers: { "Content-Type": "application/json" } })
    }
    try {
        // Guard against oversized payloads (200KB max — increased for rules+frameworks)
        const contentLength = Number(request.headers.get("content-length") ?? 0)
        if (contentLength > 204800) {
            return new Response(JSON.stringify({ error: "Import payload too large (max 200KB)" }), { status: 413, headers: { "Content-Type": "application/json" } })
        }

        let data: unknown
        try {
            const bytes = await readWithinLimit(request.body, 204800, request.signal)
            if (!bytes) return new Response(JSON.stringify({ error: "Import payload too large (max 200KB)" }), { status: 413, headers: { "Content-Type": "application/json" } })
            data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        } catch {
            return new Response(JSON.stringify({ error: "Malformed JSON in request body" }), { status: 400, headers: { "Content-Type": "application/json" } })
        }

        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return new Response(JSON.stringify({ error: "Invalid settings payload format. Expected a key-value object." }), { status: 400, headers: { "Content-Type": "application/json" } })
        }

        const payload = data as Record<string, unknown>
        const isV2 = payload._version === 2
        const invalid = (error: string) => new Response(JSON.stringify({ error }), { status: 400, headers: { "Content-Type": "application/json" } })
        let rules: TaskRule[] | undefined
        let frameworks: Array<{ frameworkId: string; overrides: FrameworkOverrides }> | undefined
        const settingsData = isV2 ? payload.settings ?? {} : payload
        if (!settingsData || typeof settingsData !== "object" || Array.isArray(settingsData)) return invalid("settings must be an object")
        try {
            if (isV2 && payload.rules !== undefined) {
                if (!Array.isArray(payload.rules) || payload.rules.length > 1000) return invalid("rules must contain at most 1000 rules")
                rules = payload.rules.map(parseRuleInput)
            }
            if (isV2 && payload.frameworkOverrides !== undefined) {
                if (!Array.isArray(payload.frameworkOverrides) || payload.frameworkOverrides.length > 1000) return invalid("frameworkOverrides must contain at most 1000 entries")
                const { getBuiltInFramework } = await import("@domains/strategy/framework-catalog")
                frameworks = []
                const seen = new Set<string>()
                for (const entry of payload.frameworkOverrides) {
                    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid("Each framework override must be an object")
                    const frameworkId = entry.frameworkId ?? entry.framework_id
                    if (typeof frameworkId !== "string" || seen.has(frameworkId)) return invalid("Framework overrides require unique framework IDs")
                    const base = await getBuiltInFramework(frameworkId)
                    if (!base) return invalid("Framework override requires a known built-in framework ID")
                    const errors = validateFrameworkOverrides(entry.overrides, base.fields.map(field => field.key))
                    if (errors) return invalid(errors.join(". "))
                    seen.add(frameworkId)
                    frameworks.push({ frameworkId, overrides: entry.overrides as FrameworkOverrides })
                }
            }
        } catch (error) {
            if (!(error instanceof RuleInputError)) throw error
            return invalid(error instanceof Error ? error.message : "Invalid rules")
        }

        // ── Import settings (v1 and v2 compatible) ──
        const entries: Array<{ key: string; value: string }> = []
        for (const [key, value] of Object.entries(settingsData)) {
            if (typeof key !== "string" || value === null || value === undefined) {
                continue
            }
            if (isSecretSetting(key)) continue
            if (!ALLOWED_KEYS.has(key)) {
                logApiWarn("import-settings", `Rejected unknown key: ${key}`)
                continue
            }

            const stringValue = JSON.stringify(value)
            entries.push({ key, value: stringValue })
        }

        await ensureSchema()
        const transaction = await getPersistenceClient().transaction("write")
        let settingsCount = 0
        const rulesCount = rules?.length ?? 0
        const frameworkCount = frameworks?.length ?? 0
        try {
            const repo = new SettingsRepository(transaction)
            await repo.ensureSettingsTable()
            settingsCount = await repo.importBatch(entries)
            if (rules) await replaceRules(rules, undefined, false, transaction)
            if (frameworks) {
                await transaction.execute("DELETE FROM framework_configs")
                for (const framework of frameworks) await saveOverrides(framework.frameworkId, framework.overrides, transaction)
            }
            await transaction.commit()
        } catch (error) {
            await transaction.rollback()
            throw error
        } finally {
            transaction.close()
        }

        const parts = [`${settingsCount} settings`]
        if (rulesCount > 0) parts.push(`${rulesCount} rules`)
        if (frameworkCount > 0) parts.push(`${frameworkCount} framework configs`)

        return new Response(JSON.stringify({
            success: true,
            message: `${parts.join(", ")} imported successfully.`,
        }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        })
    } catch (error) {
        logApiError("import-settings", "Failed to import settings", error)
        return new Response(JSON.stringify({ error: "Import failed: payload could not be processed." }), { status: 500, headers: { "Content-Type": "application/json" } })
    }
}

