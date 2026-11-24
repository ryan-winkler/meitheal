/**
 * Plugin Operational Health & Elephant-Goldfish Security Compliance Evaluator
 *
 * Pure, deterministic domain module evaluating each plugin across two axes:
 *   1. Operational State (active, paused in Safe Mode, missing config/secrets, blocked, error)
 *   2. Security Compliance based on the Elephant-Goldfish Model (EGM):
 *      - Goldfish checks (stateless execution isolation: opaque-origin sandbox, CSP, SSRF gateway)
 *      - Elephant checks (stateful persistence boundaries: permission re-consent, write-only secrets,
 *        declared outbound destinations, cryptographic package provenance)
 *
 * @domain plugins
 * @bounded-context plugins
 */
import type {
  PluginComplianceCheck,
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

function hasValidApprovedServer(url: string | null): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch {
    return false
  }
}

export function evaluatePluginHealth(input: PluginHealthEvaluationInput): PluginHealthReport {
  const { record, secrets, safeMode, runtimeError } = input
  const { manifest } = record
  const checks: PluginComplianceCheck[] = []

  // 1. Goldfish: Opaque-origin sandbox isolation contract
  const usesOpaqueSandbox = Boolean(record.files.entryJs || record.files.iframeHtml)
  const hasCspEscapeRisk = Boolean(
    record.files.iframeHtml &&
      (/allow-same-origin/i.test(record.files.iframeHtml) ||
        /<meta[^>]*http-equiv\s*=\s*["']?content-security-policy/i.test(record.files.iframeHtml) ||
        /<script\b[^>]*\bsrc\s*=/i.test(record.files.iframeHtml)),
  )
  checks.push({
    id: "sandbox_isolation",
    label: "Opaque-Origin Sandbox",
    category: "goldfish",
    status: hasCspEscapeRisk ? "warn" : "pass",
    detail: hasCspEscapeRisk
      ? "Panel HTML contains a blocked external script or CSP override attempt (stripped by host sandbox)."
      : usesOpaqueSandbox
        ? "Runs in opaque-origin frames (origin: null, connect-src 'none') with zero cookie or HA token access."
        : "Executes strictly through server-validated connector gateway contracts.",
  })

  // 2. Elephant: Permission & upgrade re-consent integrity
  checks.push({
    id: "permission_consent",
    label: "Permission & Re-Consent",
    category: "elephant",
    status: record.needsReconsent ? "fail" : "pass",
    detail: record.needsReconsent
      ? "Upgraded package requested new permissions or hosts and is blocked until admin re-approval."
      : `All ${manifest.permissions.length} declared permission(s) approved and enforced at runtime.`,
  })

  // 3. Goldfish + Elephant: Outbound network & SSRF gateway compliance
  const declaredHosts = manifest.allowedHosts
  const destinationHosts = new Set(manifest.dataSharing.destinations.map((d) => d.host))
  const allHostsDisclosed = declaredHosts.every((h) => destinationHosts.has(h))
  const hasHttpPerm = manifest.permissions.includes("http:outbound")
  const usesUserServer = declaredHosts.includes("$userServer")
  const userServerApproved = hasValidApprovedServer(record.approvedUserServer)

  if (declaredHosts.length === 0) {
    checks.push({
      id: "network_ssrf",
      label: "Outbound Network & SSRF",
      category: "goldfish",
      status: "pass",
      detail: "Local-only isolation: zero external network hosts declared.",
    })
  } else if (!allHostsDisclosed || !hasHttpPerm) {
    checks.push({
      id: "network_ssrf",
      label: "Outbound Network & SSRF",
      category: "goldfish",
      status: "fail",
      detail: "Outbound host list does not match declared permissions or data-sharing destinations.",
    })
  } else if (usesUserServer && !userServerApproved) {
    checks.push({
      id: "network_ssrf",
      label: "Outbound Network & SSRF",
      category: "elephant",
      status: record.enabled ? "warn" : "pass",
      detail: record.enabled
        ? "Requires administrator-approved self-hosted server URL before outbound requests succeed."
        : "Self-hosted server host ($userServer) awaits administrator URL configuration.",
    })
  } else {
    checks.push({
      id: "network_ssrf",
      label: "Outbound Network & SSRF",
      category: "goldfish",
      status: "pass",
      detail: `Gateway-enforced allowlist (${declaredHosts.join(", ")}) with IPv4/IPv6 SSRF & redirect blocking.`,
    })
  }

  // 4. Elephant: Write-only secret hygiene & SQLite export scrubbing
  const secretMap = new Map(secrets.map((s) => [s.key, s.configured]))
  const requiredSecretFields = (manifest.connector?.configFields ?? []).filter(
    (f) => f.type === "secret" && f.required && f.secretKey,
  )
  const missingSecrets = requiredSecretFields.filter((f) => !secretMap.get(f.secretKey!))
  const usesSecrets = manifest.permissions.includes("secrets:use") || requiredSecretFields.length > 0

  if (!usesSecrets) {
    checks.push({
      id: "secret_hygiene",
      label: "Write-Only Secret Hygiene",
      category: "elephant",
      status: "pass",
      detail: "No secrets declared; zero credential exposure surface.",
    })
  } else if (record.enabled && missingSecrets.length > 0) {
    checks.push({
      id: "secret_hygiene",
      label: "Write-Only Secret Hygiene",
      category: "elephant",
      status: "warn",
      detail: `Missing required write-only secret(s): ${missingSecrets.map((f) => f.secretKey).join(", ")}.`,
    })
  } else {
    checks.push({
      id: "secret_hygiene",
      label: "Write-Only Secret Hygiene",
      category: "elephant",
      status: "pass",
      detail: "Secrets stored write-only in plugin_secrets, injected server-side, and scrubbed from SQLite exports.",
    })
  }

  // 5. Elephant: Package integrity & review provenance
  const validDigest = SHA256_HEX_RE.test(record.sha256)
  if (!validDigest) {
    checks.push({
      id: "provenance_integrity",
      label: "Package Integrity & Provenance",
      category: "elephant",
      status: "fail",
      detail: "Package SHA-256 integrity digest is missing or malformed.",
    })
  } else if (record.source === "uploaded" && manifest.dataSharing.outbound) {
    checks.push({
      id: "provenance_integrity",
      label: "Package Integrity & Provenance",
      category: "elephant",
      status: "warn",
      detail: `Unreviewed community ZIP (SHA-256 ${record.sha256.slice(0, 12)}) with outbound access — verify destinations.`,
    })
  } else {
    checks.push({
      id: "provenance_integrity",
      label: "Package Integrity & Provenance",
      category: "elephant",
      status: "pass",
      detail:
        record.source === "builtin"
          ? `First-party verified connector (SHA-256 ${record.sha256.slice(0, 12)}).`
          : `Validated local-only community ZIP (SHA-256 ${record.sha256.slice(0, 12)}).`,
    })
  }

  // Compute missing required non-secret connector config fields
  const missingConfigFields = (manifest.connector?.configFields ?? []).filter((field) => {
    if (!field.required || field.type === "secret") return false
    const val = record.config[field.key]
    return typeof val !== "string" || val.trim().length === 0
  })

  // Determine Security Compliance summary
  const failCount = checks.filter((c) => c.status === "fail").length
  const warnCount = checks.filter((c) => c.status === "warn").length
  const passedChecks = checks.filter((c) => c.status === "pass").length

  let securityTone: PluginHealthTone = "healthy"
  let securityLabel = `Compliant (${passedChecks}/${checks.length})`
  if (failCount > 0) {
    securityTone = "critical"
    securityLabel = record.needsReconsent ? "Blocked — Re-Consent" : `Non-Compliant (${failCount} failed)`
  } else if (warnCount > 0) {
    securityTone = "warning"
    securityLabel = `Review (${passedChecks}/${checks.length})`
  }

  // Determine Operational State
  let operationalState: PluginOperationalState = "disabled"
  let operationalLabel = "Disabled"
  let remediation: string | undefined

  if (record.needsReconsent) {
    operationalState = "blocked_reconsent"
    operationalLabel = "Blocked (Re-Consent)"
    remediation = "Open Details to review and approve the upgraded permissions."
  } else if (!record.enabled) {
    operationalState = "disabled"
    operationalLabel = "Disabled"
  } else if (safeMode) {
    operationalState = "paused_safe_mode"
    operationalLabel = "Paused (Safe Mode)"
    remediation = "Disable Safe Mode to resume plugin execution."
  } else if (runtimeError && runtimeError.trim()) {
    operationalState = "error"
    operationalLabel = "Runtime Error"
    remediation = runtimeError.trim().slice(0, 180)
  } else if (missingConfigFields.length > 0 || missingSecrets.length > 0 || (usesUserServer && !userServerApproved)) {
    operationalState = "needs_config"
    operationalLabel = "Needs Configuration"
    const missingNames = [
      ...missingConfigFields.map((f) => f.label),
      ...missingSecrets.map((f) => f.label),
    ]
    remediation = missingNames.length > 0
      ? `Open Details to configure: ${missingNames.join(", ")}.`
      : "Open Details to approve the server URL."
  } else {
    operationalState = "operational"
    operationalLabel = "Operational"
  }

  // Combine overall traffic-light tone
  let overall: PluginHealthTone = "inactive"
  if (operationalState === "blocked_reconsent" || operationalState === "error" || securityTone === "critical") {
    overall = "critical"
  } else if (!record.enabled) {
    overall = "inactive"
  } else if (
    operationalState === "paused_safe_mode" ||
    operationalState === "needs_config" ||
    securityTone === "warning"
  ) {
    overall = "warning"
  } else {
    overall = "healthy"
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
