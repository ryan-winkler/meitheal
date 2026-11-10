import type { APIRoute } from "astro"
import { z } from "zod"
import { ensureSchema, getPersistenceClient } from "@domains/tasks/persistence/store"
import { SettingsRepository } from "@domains/tasks/persistence/settings-repository"
import { deleteAllRules, createRule } from "@domains/strategy/rule-repository"
import { saveOverrides, resetOverrides, getAllOverrides } from "@domains/strategy/framework-repository"
import { isSecretSetting } from "../../../lib/settings-security"
import { logApiError, logApiWarn } from "../../../lib/api-logger"
import type { TaskRule, FrameworkOverrides } from "@meitheal/domain-strategy"
import { VALID_TASK_TYPES } from "@meitheal/domain-tasks"
import { DEFAULT_AI_SCOPE } from "@meitheal/domain-strategy"

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

const importedRules = z.array(z.looseObject({ taskTypes: z.array(z.enum(VALID_TASK_TYPES)).optional() }))

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
            data = await request.json()
        } catch {
            return new Response(JSON.stringify({ error: "Malformed JSON in request body" }), { status: 400, headers: { "Content-Type": "application/json" } })
        }

        if (!data || typeof data !== "object" || Array.isArray(data)) {
            return new Response(JSON.stringify({ error: "Invalid settings payload format. Expected a key-value object." }), { status: 400, headers: { "Content-Type": "application/json" } })
        }

        const payload = data as Record<string, unknown>
        const isV2 = payload._version === 2
        const rules = isV2 && Array.isArray(payload.rules) ? importedRules.safeParse(payload.rules) : undefined
        if (rules && !rules.success) {
            return new Response(JSON.stringify({ error: "Invalid task types in imported rules" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            })
        }

        await ensureSchema()
        const repo = new SettingsRepository(getPersistenceClient())
        await repo.ensureSettingsTable()
        const settingsData = isV2 ? (payload.settings as Record<string, unknown> ?? {}) : payload

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

            const stringValue = typeof value === "string" ? value : JSON.stringify(value)
            entries.push({ key, value: stringValue })
        }

        let settingsCount = 0
        if (entries.length > 0) {
            settingsCount = await repo.importBatch(entries)
        }

        // ── Import rules (v2 only) ──
        let rulesCount = 0
        if (rules?.success) {
            await deleteAllRules()
            for (const rule of rules.data) {
                const taskRule: TaskRule = {
                    id: crypto.randomUUID(),
                    name: String(rule.name ?? "Imported Rule"),
                    description: String(rule.description ?? ""),
                    ruleType: String(rule.ruleType ?? "strategic-lens") as TaskRule["ruleType"],
                    taskTypes: rule.taskTypes ?? [],
                    tags: Array.isArray(rule.tags) ? rule.tags as string[] : [],
                    lensIds: Array.isArray(rule.lensIds) ? rule.lensIds as string[] : [],
                    aiScope: typeof rule.aiScope === "object" && rule.aiScope !== null
                        ? rule.aiScope as TaskRule["aiScope"]
                        : { ...DEFAULT_AI_SCOPE },
                    constraints: String(rule.constraints ?? ""),
                    priority: Number(rule.priority ?? 100),
                    enabled: rule.enabled !== false,
                    createdAt: "",
                    updatedAt: "",
                }
                await createRule(taskRule)
                rulesCount++
            }
        }

        // ── Import framework overrides (v2 only) ──
        let frameworkCount = 0
        if (isV2 && Array.isArray(payload.frameworkOverrides)) {
            // Clear existing overrides
            const existing = await getAllOverrides()
            for (const override of existing) {
                await resetOverrides(override.frameworkId)
            }
            // Import new overrides
            for (const fw of payload.frameworkOverrides as Array<Record<string, unknown>>) {
                const frameworkId = String(fw.frameworkId ?? fw.framework_id ?? "")
                const overrides = fw.overrides as FrameworkOverrides | undefined
                if (frameworkId && overrides && typeof overrides === "object") {
                    await saveOverrides(frameworkId, overrides)
                    frameworkCount++
                }
            }
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

