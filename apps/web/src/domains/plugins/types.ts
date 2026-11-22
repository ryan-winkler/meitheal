/**
 * Plugin Bounded Context — Core Domain Types
 *
 * Pure data contracts shared across manifest validation, ZIP ingestion,
 * permission enforcement, HTTP gateway, repository, and service layers.
 *
 * @domain plugins
 * @bounded-context plugins
 */

export const PLUGIN_TYPES = ["extension", "connector"] as const
export type PluginType = (typeof PLUGIN_TYPES)[number]

export const PLUGIN_PERMISSIONS = [
  "tasks:read",
  "tasks:write",
  "boards:read",
  "storage:local",
  "ui:header-button",
  "ui:side-panel",
  "ui:toast",
  "http:outbound",
  "secrets:use",
] as const
export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number]

export const PLUGIN_HOOKS = [
  "task.created",
  "task.updated",
  "task.completed",
  "view.changed",
  "board.changed",
] as const
export type PluginHook = (typeof PLUGIN_HOOKS)[number]

export interface PluginDataSharingDestination {
  host: string
  purpose: string
}

export interface PluginDataSharing {
  outbound: boolean
  destinations: PluginDataSharingDestination[]
  dataTypes: string[]
  summary: string
}

export type ConnectorFieldType = "text" | "url" | "secret" | "number" | "boolean"

export interface PluginConnectorField {
  key: string
  label: string
  type: ConnectorFieldType
  required?: boolean
  bindUserServer?: boolean
  secretKey?: string
  placeholder?: string
  help?: string
}

export interface PluginConnectorConfig {
  supportsWriteBack: boolean
  defaultPollMinutes: number
  configFields: PluginConnectorField[]
}

export interface PluginManifest {
  id: string
  name: string
  version: string
  minMeithealVersion: string
  type: PluginType
  description: string
  author: string
  license: string
  icon?: string
  entry?: string
  iFrame?: string
  sidePanel?: boolean
  permissions: PluginPermission[]
  hooks: PluginHook[]
  allowedHosts: string[]
  dataSharing: PluginDataSharing
  connector?: PluginConnectorConfig
}

export interface PluginFiles {
  entryJs?: string
  iframeHtml?: string
  iconSvg?: string
}

export interface PluginSecretStatus {
  key: string
  configured: boolean
  updatedAt?: string
}

export interface PluginRecord {
  id: string
  source: "builtin" | "uploaded"
  enabled: boolean
  needsReconsent: boolean
  manifest: PluginManifest
  files: PluginFiles
  sha256: string
  config: Record<string, unknown>
  approvedUserServer: string | null
  installedAt: string
  updatedAt: string
}

export type PluginHealthTone = "healthy" | "warning" | "critical" | "inactive"

export type PluginOperationalState =
  | "operational"
  | "paused_safe_mode"
  | "needs_config"
  | "blocked_reconsent"
  | "error"
  | "disabled"

export interface PluginComplianceCheck {
  id: string
  label: string
  category: "elephant" | "goldfish"
  status: "pass" | "warn" | "fail"
  detail: string
}

export interface PluginHealthReport {
  pluginId: string
  overall: PluginHealthTone
  operationalState: PluginOperationalState
  operationalLabel: string
  securityTone: PluginHealthTone
  securityLabel: string
  passedChecks: number
  totalChecks: number
  checks: PluginComplianceCheck[]
  remediation?: string
}

export interface PluginFleetHealthSummary {
  activeCount: number
  healthyCount: number
  warningCount: number
  criticalCount: number
  inactiveCount: number
  safeMode: boolean
  overall: PluginHealthTone
}

export interface PluginView {
  id: string
  source: "builtin" | "uploaded"
  enabled: boolean
  needsReconsent: boolean
  manifest: PluginManifest
  iconSvg: string | null
  sha256: string
  config: Record<string, unknown>
  approvedUserServer: string | null
  secrets: PluginSecretStatus[]
  health: PluginHealthReport
  installedAt: string
  updatedAt: string
}

export interface PluginRuntimeBundle {
  id: string
  name: string
  version: string
  type: PluginType
  permissions: PluginPermission[]
  hooks: PluginHook[]
  sidePanel: boolean
  entryJs: string | null
  iframeHtml: string | null
  iconSvg: string | null
  config: Record<string, unknown>
}

export interface PluginHttpRequestInput {
  method: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
}

export interface PluginHttpResponse {
  status: number
  ok: boolean
  headers: Record<string, string>
  json: unknown
  text: string
}

export type PluginResult<T> =
  | { ok: true; data: T }
  | { ok: false; errorCode: string; error: string; status?: number }
