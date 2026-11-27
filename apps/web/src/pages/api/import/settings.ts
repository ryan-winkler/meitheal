import { organizationLegacyFeatureWrite } from "@lib/organization-legacy-feature-write"
import type { APIRoute } from "astro"
import { restoreCustomFramework } from "@domains/strategy/custom-framework-repository"
import { saveOverrides } from "@domains/strategy/framework-repository"
import { parseRuleInput, RuleInputError } from "@domains/strategy/rule-input"
import { replaceRules } from "@domains/strategy/rule-repository"
import { isPrivateWorkSetting } from "@domains/tasks/integration-destinations"
import {
  ensureSchema,
  getPersistenceClient,
  SettingsRepository,
  isWorkIntegrationSetting,
  sameWorkIntegrationSetting
} from "@domains/tasks"
import {
  sanitizeLegacyFrameworkOverrides,
  validateFrameworkConfig,
  validateFrameworkOverrides,
  type FrameworkConfig,
  type FrameworkOverrides,
  type TaskRule
} from "@meitheal/domain-strategy"
import { normalizeCustomFieldDefs } from "../../../lib/custom-field-defs"
import { validateGrocyBaseUrl } from "@meitheal/integration-core"
import { logApiError, logApiWarn } from "../../../lib/api-logger"
import { readWithinLimit } from "../../../lib/bounded-body"
import { currentSettingsAccess } from "../../../lib/current-settings-access"
import { FEATURE_DEFAULTS } from "../../../lib/feature-flags"
import {
  isLegacySupervisorIngressUrl,
  resolveSupervisorGrocyAddon
} from "../../../lib/grocy-client"
import { validateSafeId } from "../../../lib/sanitize-id"
import { isSecretSetting } from "../../../lib/settings-security"
import { isThemeMode } from "../../../lib/theme-mode"

/** Known safe setting keys — only these will be imported.
 * IMPORTANT: Update this set when adding new saveSetting() calls.
 */
const ALLOWED_KEYS = new Set([
  // ── Home Assistant / Connectivity ──
  "ha-url",
  "ha-token",
  "ha_url",
  "ha_token",
  "vikunja-url",
  "vikunja-token",
  "calendar-entity",
  "calendar-entities",
  "calendar_entity",
  "cal_entity",
  "calendar_entities",
  "caldav_url",
  "calendar_sync_enabled",
  "calendar_write_back",
  "calendar_write_ticket_details",
  "calendar_sync_interval_ms",
  "calendar_sync_mode",
  "calendar_sync_modes",
  // ── UI Preferences ──
  "default-area",
  "theme",
  "default-view",
  "wip-limit",
  "show-description",
  "column-order",
  "locale",
  "sidebar-collapsed",
  "sidebar_config",
  "user_profile",
  "timezone",
  "week_start",
  "date_format",
  "kanban-group-by",
  "task-detail-width",
  "backlog_mode",
  "completed_auto_hide_days",
  "shopping_categories",
  // ── Notifications ──
  "enable-notifications",
  "notification-sound",
  "notification-vibrate",
  "notification_preferences",
  // ── Scoring Frameworks ──
  "rice-scoring-enabled",
  "heart-scoring-enabled",
  "kcs-scoring-enabled",
  "framework_mapping",
  // ── AI & Agent Protocols ──
  "ai-provider",
  "ai-custom-url",
  "ha-agent-id",
  "ha-assist-agent",
  "agent-protocols-a2a-enabled",
  "agent-protocols-webmcp-enabled",
  "agent-protocols-mcp-enabled",
  // ── Webhooks & Integrations ──
  "webhook_endpoint",
  "webhook_secret",
  "webhook_format",
  "n8n_webhook_url",
  "n8n_events",
  "n8n_mode",
  "n8n_api_key",
  "n8n_signing_secret",
  "grocy_url",
  "grocy_api_key",
  "grocy_sync_mode",
  "grocy_sync_enabled",
  "grocy_sync_interval",
  // ── Todo Sync ──
  "todo_sync_enabled",
  "todo_entity",
  "todo_entities",
  "todo_sync_direction",
  // ── Custom Fields ──
  "custom_fields",
  // ── Custom Theme ──
  "custom_theme_css",
  "custom_theme_name",
  "accent-color",
  ...Object.keys(FEATURE_DEFAULTS).map((name) => `feature_${name}`)
])

export const POST: APIRoute = async ({ request, locals }) => {
  if (!locals.hassIsAdmin || locals.agentToken) {
    return new Response(JSON.stringify({ error: "Admin access required for settings import" }), {
      status: 403,
      headers: { "Content-Type": "application/json" }
    })
  }
  const access = await currentSettingsAccess(request, locals, true)
  if (access instanceof Response) return access
  try {
    // Guard against oversized payloads (200KB max — increased for rules+frameworks)
    const contentLength = Number(request.headers.get("content-length") ?? 0)
    if (contentLength > 204800) {
      return new Response(JSON.stringify({ error: "Import payload too large (max 200KB)" }), {
        status: 413,
        headers: { "Content-Type": "application/json" }
      })
    }

    let data: unknown
    try {
      const bytes = await readWithinLimit(request.body, 204800, request.signal)
      if (!bytes)
        return new Response(JSON.stringify({ error: "Import payload too large (max 200KB)" }), {
          status: 413,
          headers: { "Content-Type": "application/json" }
        })
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    } catch {
      return new Response(JSON.stringify({ error: "Malformed JSON in request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      })
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return new Response(
        JSON.stringify({ error: "Invalid settings payload format. Expected a key-value object." }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const payload = data as Record<string, unknown>
    const isV2 = payload._version === 2
    const legacyEncoded =
      isV2 && payload._settingsEncoding === undefined && typeof payload._exportedAt === "string"
    const invalid = (error: string) =>
      new Response(JSON.stringify({ error }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      })
    if (payload._settingsEncoding !== undefined && payload._settingsEncoding !== "json-values")
      return invalid("Unsupported settings encoding")
    let rules: TaskRule[] | undefined
    let frameworks: Array<{ frameworkId: string; overrides: FrameworkOverrides }> | undefined
    const customFrameworks: FrameworkConfig[] = []
    const settingsData = isV2 ? (payload.settings ?? {}) : payload
    if (!settingsData || typeof settingsData !== "object" || Array.isArray(settingsData))
      return invalid("settings must be an object")
    const policyDenied = await organizationLegacyFeatureWrite(
      request,
      locals,
      Object.keys(settingsData)
    )
    if (policyDenied) return policyDenied
    try {
      if (isV2 && payload.rules !== undefined) {
        if (!Array.isArray(payload.rules) || payload.rules.length > 1000)
          return invalid("rules must contain at most 1000 rules")
        rules = payload.rules.map(parseRuleInput)
      }
      if (isV2 && payload.frameworkOverrides !== undefined) {
        if (!Array.isArray(payload.frameworkOverrides) || payload.frameworkOverrides.length > 1000)
          return invalid("frameworkOverrides must contain at most 1000 entries")
        frameworks = []
        const seen = new Set<string>()
        for (const entry of payload.frameworkOverrides) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return invalid("Each framework override must be an object")
          const frameworkId = entry.frameworkId ?? entry.framework_id
          if (typeof frameworkId !== "string" || seen.has(frameworkId))
            return invalid("Framework overrides require unique framework IDs")
          const { getBuiltInFramework } = await import("@domains/strategy/framework-catalog")
          const base = await getBuiltInFramework(frameworkId)
          if (!base) return invalid("Framework override requires a known built-in framework ID")
          const cleanedOverrides = sanitizeLegacyFrameworkOverrides(entry.overrides)
          const errors = validateFrameworkOverrides(
            cleanedOverrides,
            base.fields.map((field) => field.key),
            { preserveLegacyFormula: true }
          )
          if (errors) return invalid(errors.join(". "))
          seen.add(frameworkId)
          frameworks.push({ frameworkId, overrides: cleanedOverrides as FrameworkOverrides })
        }
      }
      if (isV2 && payload.customFrameworks !== undefined) {
        if (!Array.isArray(payload.customFrameworks) || payload.customFrameworks.length > 1000)
          return invalid("customFrameworks must contain at most 1000 entries")
        const { listBuiltInFrameworks } = await import("@domains/strategy/framework-catalog")
        const builtInIds = new Set((await listBuiltInFrameworks()).map((framework) => framework.id))
        const seen = new Set<string>()
        for (const entry of payload.customFrameworks) {
          const config = entry as FrameworkConfig
          const errors = validateFrameworkConfig(config, { preserveLegacyScoring: true })
          if (errors) return invalid(errors.join(". "))
          const idError = validateSafeId(config.id, "framework_id")
          if (idError) return invalid(idError)
          if (seen.has(config.id) || builtInIds.has(config.id))
            return invalid("Custom frameworks require unique IDs distinct from built-in frameworks")
          if (
            config.source !== undefined &&
            config.source !== "user" &&
            config.source !== "imported"
          )
            return invalid("Invalid custom framework source")
          seen.add(config.id)
          customFrameworks.push({
            ...config,
            source: config.source ?? "user",
            version: config.version ?? "1.0.0"
          })
        }
      }
    } catch (error) {
      if (!(error instanceof RuleInputError)) throw error
      return invalid(error instanceof Error ? error.message : "Invalid rules")
    }

    // ── Import settings (v1 and v2 compatible) ──
    const entries: Array<{ key: string; value: string }> = []
    for (const [key, value] of Object.entries(settingsData)) {
      if (value === undefined) {
        continue
      }
      if (key === "ai-custom-url-approved" || isSecretSetting(key) || isPrivateWorkSetting(key)) continue
      if (!ALLOWED_KEYS.has(key)) {
        logApiWarn("import-settings", `Rejected unknown key: ${key}`)
        continue
      }

      let decoded = value
      // Historical native exports contain serialized database values. Typed API
      // payloads and explicitly marked exports retain literal JSON-looking strings.
      if (legacyEncoded && typeof value === "string") {
        try {
          decoded = JSON.parse(value)
        } catch {
          /* Preserve legacy plain text. */
        }
      }
      if (key === "theme" && !isThemeMode(decoded)) decoded = "dark"
      if (key === "custom_fields") {
        decoded = normalizeCustomFieldDefs(decoded)
      }
      if (key === "grocy_url" && decoded !== null && decoded !== "") {
        if (typeof decoded !== "string") {
          return invalid("Invalid grocy_url: must be a string")
        }
        const trimmedGrocyUrl = decoded.trim()
        if (!trimmedGrocyUrl) {
          decoded = ""
        } else if (isLegacySupervisorIngressUrl(trimmedGrocyUrl)) {
          const detected = await resolveSupervisorGrocyAddon(trimmedGrocyUrl)
          if (!detected) {
            logApiWarn(
              "import-settings",
              "Skipped unresolvable legacy Supervisor Grocy URL during import"
            )
            continue
          }
          decoded = detected.url
        } else {
          const urlCheck = validateGrocyBaseUrl(trimmedGrocyUrl)
          if (!urlCheck.ok) {
            return invalid(`Invalid grocy_url: ${urlCheck.error}`)
          }
          decoded = urlCheck.normalizedUrl
        }
      }
      entries.push({ key, value: JSON.stringify(decoded) })
    }

    await ensureSchema()
    // Provider retargeting needs an explicit destination review. Reject the whole
    // import before changing settings, rules or frameworks, including on fresh installs.
    const profilesUnchanged = async (
      reader: Pick<ReturnType<typeof getPersistenceClient>, "execute">
    ) => {
      for (const entry of entries.filter((entry) => isWorkIntegrationSetting(entry.key))) {
        const {
          rows: [saved]
        } = await reader.execute({
          sql: "SELECT value FROM settings WHERE key=?",
          args: [entry.key]
        })
        if (
          !sameWorkIntegrationSetting(
            typeof saved?.value === "string" ? saved.value : undefined,
            entry.value
          )
        )
          return false
      }
      return true
    }
    const profileReviewRequired = () =>
      new Response(
        JSON.stringify({
          error:
            "This import changes an integration profile. Review and save its Board destinations in Settings first, then retry the import. Nothing was imported."
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        }
      )
    if (!(await profilesUnchanged(getPersistenceClient()))) return profileReviewRequired()

    const importsAiHandoff = entries.some(
      ({ key }) => key === "ai-provider" || key === "ai-custom-url"
    )

    await ensureSchema()
    const transaction = await getPersistenceClient().transaction("write")
    let settingsCount = 0
    const rulesCount = rules?.length ?? 0
    const frameworkCount = frameworks?.length ?? 0
    try {
      if (!(await profilesUnchanged(transaction))) {
        await transaction.rollback()
        return profileReviewRequired()
      }
      const repo = new SettingsRepository(transaction)
      await repo.ensureSettingsTable()
      settingsCount = await repo.importBatch(
        entries.filter((entry) => !isWorkIntegrationSetting(entry.key))
      )
      if (importsAiHandoff) await repo.deleteByKeys(["ai-custom-url-approved"])
      if (rules) await replaceRules(rules, undefined, false, transaction)
      for (const framework of customFrameworks) await restoreCustomFramework(transaction, framework)
      if (frameworks) {
        await transaction.execute("DELETE FROM framework_configs")
        for (const framework of frameworks)
          await saveOverrides(framework.frameworkId, framework.overrides, transaction, {
            preserveLegacyFormula: true
          })
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
    if (customFrameworks.length > 0) parts.push(`${customFrameworks.length} custom frameworks`)

    return new Response(
      JSON.stringify({
        success: true,
        message: `${parts.join(", ")} imported successfully.`
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    )
  } catch (error) {
    logApiError("import-settings", "Failed to import settings", error)
    return new Response(
      JSON.stringify({ error: "Import failed: payload could not be processed." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}
