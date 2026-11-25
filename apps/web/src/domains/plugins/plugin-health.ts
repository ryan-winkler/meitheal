/**
 * Plugin readiness and configuration checks. The catalog evaluates stored
 * records without starting plugins, contacting endpoints, or certifying code.
 *
 * @domain plugins
 */
import { PLUGIN_PERMISSION_CATALOG } from "./plugin-permissions"
import type {
  PluginComplianceCheck,
  PluginConnectorField,
  PluginFleetHealthSummary,
  PluginHealthReport,
  PluginHealthTone,
  PluginOperationalState,
  PluginRecord,
  PluginSecretStatus,
} from "./types"

const SHA256_HEX_RE = /^[a-f0-9]{64}$/i

export interface PluginHealthEvaluationInput {
  record: PluginRecord
  secrets: PluginSecretStatus[]
  safeMode: boolean
  runtimeError?: string | null
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  const url = URL.parse(value)
  return Boolean(url && (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password)
}

function isConfigured(field: PluginConnectorField, value: unknown): boolean {
  if (field.type === "url") return isHttpUrl(value)
  if (field.type === "boolean") return typeof value === "boolean" || value === "true" || value === "false"
  if (field.type === "number") {
    if (typeof value === "number") return Number.isFinite(value)
    return typeof value === "string" && Boolean(value.trim()) && Number.isFinite(Number(value))
  }
  return typeof value === "string" && Boolean(value.trim())
}

export function evaluatePluginHealth(input: PluginHealthEvaluationInput): PluginHealthReport {
  const { record, secrets, safeMode, runtimeError } = input
  const { manifest } = record
  const checks: PluginComplianceCheck[] = []
  const permissions = new Set(manifest.permissions)
  const unknownPermissions = manifest.permissions.some(permission => !Object.hasOwn(PLUGIN_PERMISSION_CATALOG, permission))
  const hasEntry = Boolean(record.files.entryJs?.trim())
  const hasPanel = Boolean(manifest.sidePanel && record.files.iframeHtml?.trim() && permissions.has("ui:side-panel"))
  const missingUi = Boolean(manifest.entry && !hasEntry || manifest.sidePanel && !hasPanel)
  const builtInConnector = record.source === "builtin" && manifest.type === "connector"
  const missingExecutable = missingUi || (!hasEntry && !hasPanel && !builtInConnector)
  checks.push({
    id: "sandbox_isolation",
    label: "Execution Boundary",
    category: "goldfish",
    status: missingExecutable ? "fail" : "pass",
    detail: missingExecutable
      ? "A declared script or panel is missing, or the panel permission is absent."
      : hasEntry || hasPanel
        ? "The host mounts plugin code in opaque-origin frames with browser network restrictions."
        : "This built-in connector uses server-side actions and has no browser code to sandbox.",
  })

  checks.push({
    id: "permission_consent",
    label: "Permissions & Re-Consent",
    category: "elephant",
    status: record.needsReconsent || unknownPermissions ? "fail" : "pass",
    detail: record.needsReconsent
      ? "New permissions or outbound hosts need administrator approval before the plugin can be enabled."
      : unknownPermissions
        ? "The package declares a permission this app does not recognize."
        : `The manifest requests ${permissions.size} supported permissions. There is no pending upgrade approval.`,
  })

  const declaredHosts = manifest.allowedHosts
  const destinationHosts = new Set(manifest.dataSharing.destinations.map(destination => destination.host))
  const inconsistentOutbound = declaredHosts.length > 0 && (
    !manifest.dataSharing.outbound || !permissions.has("http:outbound") || declaredHosts.some(host => !destinationHosts.has(host))
  )
  const missingAllowlist = declaredHosts.length === 0 && (manifest.dataSharing.outbound || destinationHosts.size > 0)
  const usesUserServer = declaredHosts.includes("$userServer")
  const missingServer = usesUserServer && !isHttpUrl(record.approvedUserServer)
  checks.push({
    id: "network_ssrf",
    label: "Outbound Configuration",
    category: "goldfish",
    status: inconsistentOutbound ? "fail" : missingServer || missingAllowlist ? "warn" : "pass",
    detail: inconsistentOutbound
      ? "Allowed hosts require an outbound permission and a matching data-sharing disclosure."
      : missingAllowlist
        ? "The manifest declares outbound use but the gateway allowlist is empty."
        : missingServer
          ? "An administrator needs to configure a valid HTTP or HTTPS server URL."
          : declaredHosts.length > 0
            ? "The allowlist is configured. The gateway checks destinations and redirects when a request runs."
            : "No outbound hosts are allowlisted for this plugin.",
  })

  const configFields = manifest.connector?.configFields ?? []
  const secretFields = configFields.filter(field => field.type === "secret")
  const canUseSecrets = permissions.has("secrets:use")
  const invalidSecretConfiguration = secretFields.some(field => !field.secretKey) || (secretFields.length > 0 && !canUseSecrets)
  const configuredSecrets = new Set(secrets.filter(secret => secret.configured).map(secret => secret.key))
  const requiredSecrets = secretFields.filter(field => field.required)
  const missingSecrets = requiredSecrets.filter(field => !field.secretKey || !configuredSecrets.has(field.secretKey))
  checks.push({
    id: "secret_hygiene",
    label: "Secret Configuration",
    category: "elephant",
    status: invalidSecretConfiguration ? "fail" : missingSecrets.length > 0 ? "warn" : "pass",
    detail: invalidSecretConfiguration
      ? "Secret fields require a valid secret key and the secrets:use permission."
      : missingSecrets.length > 0
        ? `Required secret values need configuration (${missingSecrets.map(field => field.label).join(", ")}).`
        : requiredSecrets.length > 0
          ? "Required secret values are configured. The catalog returns configuration status only."
          : canUseSecrets
            ? "The manifest can use saved secrets and declares no required secret fields."
            : "The manifest does not request access to saved secrets.",
  })

  const validDigest = SHA256_HEX_RE.test(record.sha256)
  const uploaded = record.source === "uploaded"
  const uploadedOutbound = uploaded && (manifest.dataSharing.outbound || declaredHosts.length > 0)
  checks.push({
    id: "provenance_integrity",
    label: "Package Digest",
    category: "elephant",
    status: !validDigest ? "fail" : uploadedOutbound ? "warn" : "pass",
    detail: !validDigest
      ? "The recorded SHA-256 digest is missing or malformed."
      : uploadedOutbound
        ? `Upload SHA-256 digest ${record.sha256.slice(0, 12)} is recorded. Review the disclosed destinations for outbound access.`
        : uploaded
          ? `Upload SHA-256 digest ${record.sha256.slice(0, 12)} is recorded. It identifies the original archive.`
          : `Built-in SHA-256 digest ${record.sha256.slice(0, 12)} is recorded.`,
  })

  const passedChecks = checks.filter(check => check.status === "pass").length
  const failedChecks = checks.filter(check => check.status === "fail").length
  const securityTone: PluginHealthTone = failedChecks > 0 ? "critical" : passedChecks < checks.length ? "warning" : "healthy"
  const securityLabel = failedChecks > 0
    ? `Checks failed (${failedChecks}/${checks.length})`
    : passedChecks < checks.length
      ? `Needs review (${passedChecks}/${checks.length} passed)`
      : `Checks passed (${passedChecks}/${checks.length})`

  const missingConfig = configFields.filter(field => field.required && field.type !== "secret" && !isConfigured(field, record.config[field.key]))
  const needsConfig = missingConfig.length > 0 || missingSecrets.length > 0 || missingServer
  const runtimeIssue = runtimeError?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 180)
  let operationalState: PluginOperationalState = "disabled"
  let operationalLabel = "Disabled"
  let remediation: string | undefined

  if (record.needsReconsent) {
    operationalState = "blocked_reconsent"
    operationalLabel = "Approval required"
    remediation = "Open Details to review the changed permissions and outbound hosts."
  } else if (record.enabled) {
    if (safeMode) {
      operationalState = "paused_safe_mode"
      operationalLabel = "Paused by Safe Mode"
      remediation = "Turn off Safe Mode to let the plugin run."
    } else if (runtimeIssue) {
      operationalState = "error"
      operationalLabel = "Runtime Error"
      remediation = runtimeIssue
    } else if (needsConfig) {
      operationalState = "needs_config"
      operationalLabel = "Needs Configuration"
      const missingNames = [...missingConfig, ...missingSecrets].map(field => field.label)
      if (missingServer && !missingConfig.some(field => field.bindUserServer)) missingNames.push("approved server URL")
      remediation = `Open Details to configure ${missingNames.join(", ")}.`
    } else {
      operationalState = "operational"
      operationalLabel = "Enabled"
    }
  }

  let overall: PluginHealthTone = "inactive"
  if (operationalState === "blocked_reconsent" || operationalState === "error" || securityTone === "critical") {
    overall = "critical"
  } else if (record.enabled) {
    overall = operationalState === "paused_safe_mode" || needsConfig || securityTone === "warning" ? "warning" : "healthy"
  }

  return {
    pluginId: record.id,
    overall,
    operationalState,
    operationalLabel,
    securityTone,
    securityLabel,
    passedChecks,
    totalChecks: checks.length,
    checks,
    ...(remediation ? { remediation } : {}),
  }
}

export function summarizeFleetHealth(
  reports: readonly PluginHealthReport[],
  safeMode: boolean,
): PluginFleetHealthSummary {
  let activeCount = 0
  let healthyCount = 0
  let warningCount = 0
  let criticalCount = 0
  let inactiveCount = 0

  for (const r of reports) {
    if (r.operationalState === "disabled" && r.overall !== "critical") {
      inactiveCount += 1
      continue
    }
    if (r.operationalState !== "disabled" && r.operationalState !== "blocked_reconsent") {
      activeCount += 1
    }
    if (r.overall === "critical") criticalCount += 1
    else if (r.overall === "warning") warningCount += 1
    else if (r.overall === "healthy") healthyCount += 1
    else inactiveCount += 1
  }

  let overall: PluginHealthTone = "inactive"
  if (criticalCount > 0) overall = "critical"
  else if (safeMode || warningCount > 0) overall = "warning"
  else if (healthyCount > 0) overall = "healthy"

  return {
    activeCount,
    healthyCount,
    warningCount,
    criticalCount,
    inactiveCount,
    safeMode,
    overall,
  }
}
