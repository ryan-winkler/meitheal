/**
 * Webserver Domain — Pure Configuration, Validation & Endpoint Resolution
 *
 * Models Meitheal's webserver settings (inspired by Music Assistant's Webserver
 * settings) as pure domain value objects and deterministic validators:
 *   - Configurable Port(s): single port, comma/space list (array), or range
 *     (delegated to canonical `scripts/port-spec.mjs` for zero drift with `serve.mjs`)
 *   - Internal, External, and Home Assistant URLs/Domains
 *   - Live MCP Server URL + Home Assistant integration deep-link resolution
 *   - Linear-time (ReDoS-free) TLS & Bind interface validation
 *   - Home Assistant Add-on Options & Supervisor Services projection
 *
 * @domain webserver
 * @bounded-context configuration
 */
import {
  DEFAULT_WEBSERVER_PORT,
  formatPortSummary,
  MAX_RESOLVED_PORTS,
  parsePortSpec,
  type ParsedPortSpec,
  type PortSpecError,
  type PortSpecMode,
  type PortSpecResult,
} from "../../../scripts/port-spec.mjs"

export {
  DEFAULT_WEBSERVER_PORT,
  formatPortSummary,
  MAX_RESOLVED_PORTS,
  parsePortSpec,
}

export type {
  ParsedPortSpec,
  PortSpecError,
  PortSpecMode,
  PortSpecResult,
}

export const DEFAULT_BIND_ADDRESS = "0.0.0.0"

export const WEBSERVER_SETTING_KEYS = [
  "webserver_server_name",
  "webserver_internal_url",
  "webserver_external_url",
  "webserver_home_assistant_url",
  "webserver_ports",
  "webserver_bind_address",
  "webserver_tls_enabled",
  "webserver_ssl_certificate",
  "webserver_ssl_private_key",
  "webserver_sync_ha_options",
] as const

export type WebserverSettingKey = (typeof WEBSERVER_SETTING_KEYS)[number]

export interface WebserverConfig {
  serverName: string
  internalUrl: string
  externalUrl: string
  homeAssistantUrl: string
  portsSpec: string
  ports: number[]
  bindAddress: string
  tlsEnabled: boolean
  sslCertificate: string
  sslPrivateKeyConfigured: boolean
  syncHaOptions: boolean
}

export interface WebserverConfigInput {
  serverName?: string | undefined
  internalUrl?: string | undefined
  externalUrl?: string | undefined
  homeAssistantUrl?: string | undefined
  portsSpec?: string | number | number[] | undefined
  bindAddress?: string | undefined
  tlsEnabled?: boolean | undefined
  sslCertificate?: string | undefined
  sslPrivateKey?: string | null | undefined
  syncHaOptions?: boolean | undefined
}

export interface McpEndpointInfo {
  mcpServerUrl: string
  mcpManifestUrl: string
  baseUrl: string
  source: "external" | "internal" | "current_origin" | "port_fallback"
  homeAssistantUrl: string | null
  homeAssistantAiUrl: string | null
  homeAssistantMcpIntegrationUrl: string | null
  homeAssistantIntegrationsUrl: string | null
  homeAssistantConnected: boolean
}

export type WebserverFieldSource = "database" | "supervisor" | "process_env" | "dotenv" | "default"

export interface WebserverFieldProvenance {
  source: WebserverFieldSource
  envVar: string | null
}

export interface WebserverConfigProvenance {
  serverName: WebserverFieldProvenance
  internalUrl: WebserverFieldProvenance
  externalUrl: WebserverFieldProvenance
  homeAssistantUrl: WebserverFieldProvenance
  portsSpec: WebserverFieldProvenance
  bindAddress: WebserverFieldProvenance
}

export interface WebserverActiveRuntime {
  listeningPorts: number[]
  listeningPortsSpec: string
  listeningHost: string
  dotenvFound: boolean
  dotenvLabel: string | null
  dotenvKeys: string[]
  restartRequired: boolean
  resolvedAt: string
}

export interface WebserverRuntimeEnv {
  ports: string
  bindAddress: string
  internalUrl: string
  externalUrl: string
  homeAssistantUrl: string
  serverName: string
  timezone: string
  nodeEnv: string
  sources: {
    ports: string
    bindAddress: string
    externalUrl: string
    homeAssistantUrl: string
  }
}

export interface WebserverSecurityNotice {
  level: "warning" | "info" | "success"
  code: string
  title: string
  message: string
}

export interface WebserverCheckItem {
  id: string
  label: string
  status: "pass" | "warn" | "fail"
  detail: string
}

export interface HaAddonOptionsPayload {
  server_name: string
  ports: number[]
  ports_spec: string
  internal_url: string
  external_url: string
  home_assistant_url: string
  bind_address: string
  tls_enabled: boolean
  mcp_server_url: string
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isValidIpv4(host: string): boolean {
  const parts = host.split(".")
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (!part || part.length > 3) return false
    for (let i = 0; i < part.length; i++) {
      const code = part.charCodeAt(i)
      if (code < 48 || code > 57) return false
    }
    if (part.length > 1 && part[0] === "0") return false
    const num = Number(part)
    if (num < 0 || num > 255) return false
  }
  return true
}

function isHexGroup(group: string): boolean {
  if (group.length < 1 || group.length > 4) return false
  for (let i = 0; i < group.length; i++) {
    const c = group.charCodeAt(i)
    const isDigit = c >= 48 && c <= 57
    const isUpper = c >= 65 && c <= 70
    const isLower = c >= 97 && c <= 102
    if (!isDigit && !isUpper && !isLower) return false
  }
  return true
}

function isValidIpv6(host: string): boolean {
  if (!host.includes(":") || host.length > 45) return false
  const doubleColonParts = host.split("::")
  if (doubleColonParts.length > 2) return false
  const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : []
  const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : []
  const groups = [...left, ...right]
  if (doubleColonParts.length === 1 && groups.length !== 8) return false
  if (doubleColonParts.length === 2 && groups.length > 7) return false
  return groups.every(isHexGroup)
}

function isValidPemBlock(text: string, kind: "certificate" | "private_key"): boolean {
  const beginPrefix = "-----BEGIN "
  const endPrefix = "-----END "
  const startIdx = text.indexOf(beginPrefix)
  if (startIdx === -1) return false
  const headerEndIdx = text.indexOf("-----", startIdx + beginPrefix.length)
  if (headerEndIdx === -1) return false
  const label = text.slice(startIdx + beginPrefix.length, headerEndIdx)

  if (kind === "certificate") {
    if (label !== "CERTIFICATE") return false
  } else {
    if (!label.endsWith("PRIVATE KEY") || label.length > 40) return false
    for (let i = 0; i < label.length; i++) {
      const c = label.charCodeAt(i)
      const ok = (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 32
      if (!ok) return false
    }
  }

  const expectedEnd = `${endPrefix}${label}-----`
  const endIdx = text.indexOf(expectedEnd, headerEndIdx + 5)
  if (endIdx === -1) return false
  const body = text.slice(headerEndIdx + 5, endIdx).trim()
  return body.length > 0
}

/** Validate an optional HTTP/HTTPS domain or base URL without credentials, query, or hash. */
export function validateWebserverUrl(
  raw: string | null | undefined,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (!trimmed) return { ok: true, value: "" }

  if (trimmed.length > 2048 || hasControlCharacters(trimmed)) {
    return { ok: false, error: `${label} must be under 2048 characters and contain no control characters.` }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return {
      ok: false,
      error: `${label} must be a full URL starting with http:// or https:// (for example https://tasks.home.arpa).`,
    }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `${label} must use http:// or https://.` }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: `${label} cannot include a username or password.` }
  }

  if (parsed.search || parsed.hash) {
    return { ok: false, error: `${label} should be a base domain or path without query parameters or #fragments.` }
  }

  if (!parsed.hostname) {
    return { ok: false, error: `${label} must include a hostname or IP address.` }
  }

  const cleanPath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")
  return { ok: true, value: `${parsed.origin}${cleanPath}` }
}

/** Validate the bind IP / interface address using strict linear IPv4/IPv6 checks. */
export function validateBindAddress(
  raw: string | null | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (!trimmed) return { ok: true, value: DEFAULT_BIND_ADDRESS }

  if (isValidIpv4(trimmed) || isValidIpv6(trimmed)) {
    return { ok: true, value: trimmed }
  }

  return {
    ok: false,
    error: `Bind address "${trimmed}" must be a valid IPv4 or IPv6 address (such as 0.0.0.0, 127.0.0.1, or ::).`,
  }
}

/** Validate a TLS certificate or private key value (absolute path or inline PEM). */
export function validateTlsMaterial(
  raw: string | null | undefined,
  kind: "certificate" | "private_key",
): { ok: true; value: string; format: "empty" | "path" | "pem" } | { ok: false; error: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (!trimmed) return { ok: true, value: "", format: "empty" }

  if (trimmed.length > 32_768) {
    return { ok: false, error: `SSL ${kind === "certificate" ? "certificate" : "private key"} exceeds the 32 KB limit.` }
  }

  if (trimmed.includes("\0")) {
    return { ok: false, error: `SSL ${kind === "certificate" ? "certificate" : "private key"} contains invalid characters.` }
  }

  if (trimmed.includes("-----BEGIN ")) {
    if (!isValidPemBlock(trimmed, kind)) {
      return {
        ok: false,
        error: kind === "certificate"
          ? "SSL certificate PEM must include valid BEGIN/END CERTIFICATE markers."
          : "SSL private key PEM must include valid BEGIN/END PRIVATE KEY markers.",
      }
    }
    return { ok: true, value: trimmed, format: "pem" }
  }

  if (trimmed.includes("..") || trimmed.includes("\\") || hasControlCharacters(trimmed) || !trimmed.startsWith("/")) {
    return {
      ok: false,
      error: `Enter an absolute certificate file path (for example /ssl/${kind === "certificate" ? "fullchain.pem" : "privkey.pem"}) or paste PEM text.`,
    }
  }

  return { ok: true, value: trimmed, format: "path" }
}

/** Validate server display name. */
export function validateServerName(raw: string | null | undefined): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : ""
  if (!trimmed) return { ok: true, value: "Meitheal" }
  if (trimmed.length > 100 || hasControlCharacters(trimmed)) {
    return { ok: false, error: "Server name must be 100 characters or fewer with no control characters." }
  }
  return { ok: true, value: trimmed }
}

/**
 * Resolve the live MCP Server URL and Home Assistant MCP integration link.
 * Prefers External URL -> Internal URL -> Current Origin -> Local port fallback.
 */
export function resolveMcpEndpoints(params: {
  internalUrl?: string | undefined
  externalUrl?: string | undefined
  homeAssistantUrl?: string | undefined
  detectedHomeAssistantUrl?: string | undefined
  ports?: number[] | undefined
  tlsEnabled?: boolean | undefined
  currentOrigin?: string | undefined
  haConnected?: boolean | undefined
}): McpEndpointInfo {
  const cleanExternal = validateWebserverUrl(params.externalUrl, "External URL")
  const cleanInternal = validateWebserverUrl(params.internalUrl, "Internal URL")
  const cleanHa = validateWebserverUrl(params.homeAssistantUrl, "Home Assistant URL")
  const cleanDetectedHa = validateWebserverUrl(params.detectedHomeAssistantUrl, "Detected Home Assistant URL")
  const cleanOrigin = validateWebserverUrl(params.currentOrigin, "Current origin")

  let baseUrl = ""
  let source: McpEndpointInfo["source"] = "port_fallback"

  if (cleanExternal.ok && cleanExternal.value) {
    baseUrl = cleanExternal.value
    source = "external"
  } else if (cleanInternal.ok && cleanInternal.value) {
    baseUrl = cleanInternal.value
    source = "internal"
  } else if (cleanOrigin.ok && cleanOrigin.value) {
    baseUrl = cleanOrigin.value
    source = "current_origin"
  } else {
    const primaryPort = params.ports?.[0] ?? DEFAULT_WEBSERVER_PORT
    const scheme = params.tlsEnabled ? "https" : "http"
    baseUrl = `${scheme}://localhost:${primaryPort}`
    source = "port_fallback"
  }

  const resolvedHaUrl =
    (cleanHa.ok && cleanHa.value) ||
    (cleanDetectedHa.ok && cleanDetectedHa.value) ||
    null

  const haConnected = Boolean(params.haConnected)

  const haAiUrl = resolvedHaUrl ? `${resolvedHaUrl}/config/ai` : null

  return {
    mcpServerUrl: `${baseUrl}/api/mcp`,
    mcpManifestUrl: `${baseUrl}/.well-known/mcp.json`,
    baseUrl,
    source,
    homeAssistantUrl: resolvedHaUrl,
    homeAssistantAiUrl: haAiUrl,
    homeAssistantMcpIntegrationUrl: haAiUrl,
    homeAssistantIntegrationsUrl: resolvedHaUrl
      ? `${resolvedHaUrl}/config/integrations/dashboard`
      : null,
    homeAssistantConnected: haConnected,
  }
}

/** Build human-readable security posture notices (modeled on Music Assistant's amber callout). */
export function evaluateWebserverSecurity(config: WebserverConfig, haAddonMode: boolean): WebserverSecurityNotice[] {
  const notices: WebserverSecurityNotice[] = []

  if (!config.tlsEnabled) {
    notices.push({
      level: "warning",
      code: "unencrypted_http",
      title: "Unencrypted HTTP by default",
      message: haAddonMode
        ? "This webserver uses plain HTTP by default. Never expose it directly to the internet — access Meitheal through Home Assistant Ingress, a reverse proxy with HTTPS, or a VPN, or enable SSL/TLS under Advanced settings."
        : "This webserver uses plain HTTP by default. Never expose it directly to the internet — put it behind a reverse proxy with HTTPS or a VPN, or enable SSL/TLS under Advanced settings.",
    })
  } else if (!config.sslCertificate || !config.sslPrivateKeyConfigured) {
    notices.push({
      level: "warning",
      code: "tls_incomplete",
      title: "SSL/TLS needs both a certificate and private key",
      message: "Provide both the SSL certificate and private key before relying on direct HTTPS connections.",
    })
  } else {
    notices.push({
      level: "success",
      code: "tls_configured",
      title: "SSL/TLS configured",
      message: "Direct HTTPS encryption is configured with a certificate and stored private key.",
    })
  }

  if (config.externalUrl.startsWith("http://")) {
    notices.push({
      level: "warning",
      code: "external_http",
      title: "External URL uses plain HTTP",
      message: "Your External URL starts with http://. Use https:// for external domains so login sessions and MCP tokens stay encrypted in transit.",
    })
  }

  if (config.ports.some((port) => port < 1024)) {
    notices.push({
      level: "info",
      code: "privileged_port",
      title: "Privileged port selected",
      message: "Ports below 1024 typically require elevated network permissions or a reverse proxy mapping on Linux and Home Assistant hosts.",
    })
  }

  return notices
}

/** Run full validation and construct normalized config + verification checks. */
export function validateWebserverConfigInput(
  input: WebserverConfigInput,
  existingKeyConfigured: boolean,
): { ok: true; config: WebserverConfig; checks: WebserverCheckItem[]; newPrivateKey?: string | null } | { ok: false; error: string; field?: string } {
  const nameResult = validateServerName(input.serverName)
  if (!nameResult.ok) return { ok: false, error: nameResult.error, field: "serverName" }

  const internalResult = validateWebserverUrl(input.internalUrl, "Internal URL")
  if (!internalResult.ok) return { ok: false, error: internalResult.error, field: "internalUrl" }

  const externalResult = validateWebserverUrl(input.externalUrl, "External URL")
  if (!externalResult.ok) return { ok: false, error: externalResult.error, field: "externalUrl" }

  const haResult = validateWebserverUrl(input.homeAssistantUrl, "Home Assistant URL")
  if (!haResult.ok) return { ok: false, error: haResult.error, field: "homeAssistantUrl" }

  const portResult = parsePortSpec(input.portsSpec)
  if (!portResult.ok) return { ok: false, error: portResult.error, field: "portsSpec" }

  const bindResult = validateBindAddress(input.bindAddress)
  if (!bindResult.ok) return { ok: false, error: bindResult.error, field: "bindAddress" }

  const certResult = validateTlsMaterial(input.sslCertificate, "certificate")
  if (!certResult.ok) return { ok: false, error: certResult.error, field: "sslCertificate" }

  let newPrivateKey: string | null | undefined = undefined
  let sslPrivateKeyConfigured = existingKeyConfigured

  if (input.sslPrivateKey !== undefined) {
    if (input.sslPrivateKey === null || input.sslPrivateKey === "") {
      newPrivateKey = null
      sslPrivateKeyConfigured = false
    } else if (input.sslPrivateKey !== "••••••••") {
      const keyResult = validateTlsMaterial(input.sslPrivateKey, "private_key")
      if (!keyResult.ok) return { ok: false, error: keyResult.error, field: "sslPrivateKey" }
      newPrivateKey = keyResult.value
      sslPrivateKeyConfigured = true
    }
  }

  const tlsEnabled = Boolean(input.tlsEnabled)
  if (tlsEnabled && (!certResult.value || !sslPrivateKeyConfigured)) {
    return {
      ok: false,
      error: "Enable SSL/TLS requires both an SSL certificate and an SSL private key.",
      field: !certResult.value ? "sslCertificate" : "sslPrivateKey",
    }
  }

  const config: WebserverConfig = {
    serverName: nameResult.value,
    internalUrl: internalResult.value,
    externalUrl: externalResult.value,
    homeAssistantUrl: haResult.value,
    portsSpec: portResult.normalized,
    ports: portResult.ports,
    bindAddress: bindResult.value,
    tlsEnabled,
    sslCertificate: certResult.value,
    sslPrivateKeyConfigured,
    syncHaOptions: input.syncHaOptions !== false,
  }

  const checks: WebserverCheckItem[] = [
    {
      id: "ports",
      label: "Listening ports",
      status: portResult.hasPrivilegedPorts ? "warn" : "pass",
      detail: portResult.ports.length === 1
        ? `Port ${portResult.primaryPort} is valid${portResult.hasPrivilegedPorts ? " (privileged port < 1024)" : ""}.`
        : `${portResult.ports.length} ports resolved (${portResult.normalized})${portResult.hasPrivilegedPorts ? " — includes privileged port < 1024" : ""}.`,
    },
    {
      id: "domains",
      label: "Internal, External & Home Assistant URLs",
      status: config.externalUrl.startsWith("http://") ? "warn" : "pass",
      detail: config.externalUrl.startsWith("http://")
        ? "URLs are valid, but External URL uses http:// instead of https://."
        : (config.internalUrl || config.externalUrl || config.homeAssistantUrl)
          ? "Configured domains passed format and protocol checks."
          : "No custom domains set — Meitheal will use the current origin and Home Assistant Ingress.",
    },
    {
      id: "bind",
      label: "Bind interface",
      status: "pass",
      detail: config.bindAddress === "0.0.0.0"
        ? "Binding to 0.0.0.0 (all IPv4 interfaces)."
        : `Binding to ${config.bindAddress}.`,
    },
    {
      id: "tls",
      label: "Transport security (SSL/TLS)",
      status: config.tlsEnabled ? "pass" : "warn",
      detail: config.tlsEnabled
        ? `SSL/TLS enabled (${certResult.format === "pem" ? "inline PEM" : "certificate path"} + stored private key).`
        : "Direct SSL/TLS is off. Use Home Assistant Ingress, a reverse proxy, or VPN for remote access.",
    },
  ]

  return { ok: true, config, checks, ...(newPrivateKey !== undefined ? { newPrivateKey } : {}) }
}

/** Build the Home Assistant Add-on options projection for Supervisor / HA Services. */
export function buildHaAddonOptionsPayload(config: WebserverConfig, mcpServerUrl: string): HaAddonOptionsPayload {
  return {
    server_name: config.serverName,
    ports: config.ports,
    ports_spec: config.portsSpec,
    internal_url: config.internalUrl,
    external_url: config.externalUrl,
    home_assistant_url: config.homeAssistantUrl,
    bind_address: config.bindAddress,
    tls_enabled: config.tlsEnabled,
    mcp_server_url: mcpServerUrl,
  }
}

/** Read non-secret runtime defaults from .env / VM / container environment variables. */
export function readWebserverEnvDefaults(
  env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {},
): WebserverRuntimeEnv {
  const meithealPorts = env.MEITHEAL_PORTS?.trim() || ""
  const portEnv = env.PORT?.trim() || ""
  const meithealHost = env.MEITHEAL_HOST?.trim() || ""
  const hostEnv = env.HOST?.trim() || ""
  const internalEnv = env.MEITHEAL_INTERNAL_URL?.trim() || ""
  const externalEnv = env.MEITHEAL_EXTERNAL_URL?.trim() || ""
  const siteUrlEnv = env.SITE_URL?.trim() || ""
  const haBaseEnv = env.HA_BASE_URL?.trim() || ""
  const haUrlEnv = env.HA_URL?.trim() || ""

  return {
    ports: meithealPorts || portEnv || String(DEFAULT_WEBSERVER_PORT),
    bindAddress: meithealHost || hostEnv || DEFAULT_BIND_ADDRESS,
    internalUrl: internalEnv,
    externalUrl: externalEnv || siteUrlEnv,
    homeAssistantUrl: haBaseEnv || haUrlEnv,
    serverName: env.MEITHEAL_SERVER_NAME?.trim() || "",
    timezone: env.TZ?.trim() || "",
    nodeEnv: env.NODE_ENV?.trim() || "production",
    sources: {
      ports: meithealPorts ? "MEITHEAL_PORTS" : portEnv ? "PORT" : "default",
      bindAddress: meithealHost ? "MEITHEAL_HOST" : hostEnv ? "HOST" : "default",
      externalUrl: externalEnv ? "MEITHEAL_EXTERNAL_URL" : siteUrlEnv ? "SITE_URL" : "unset",
      homeAssistantUrl: haBaseEnv ? "HA_BASE_URL" : haUrlEnv ? "HA_URL" : "unset",
    },
  }
}

/** Hydrate a WebserverConfig from flat settings rows unified with .env / VM & HA defaults. */
export function hydrateWebserverConfig(
  settings: Record<string, unknown>,
  defaults: {
    defaultServerName?: string | undefined
    defaultPorts?: string | undefined
    defaultBindAddress?: string | undefined
    detectedHaUrl?: string | undefined
    env?: Record<string, string | undefined> | undefined
  } = {},
): WebserverConfig {
  const envDefaults = readWebserverEnvDefaults(defaults.env)
  const rawPorts = settings.webserver_ports ?? defaults.defaultPorts ?? envDefaults.ports
  const parsedPorts = parsePortSpec(
    typeof rawPorts === "string" || typeof rawPorts === "number" || Array.isArray(rawPorts)
      ? rawPorts
      : DEFAULT_WEBSERVER_PORT,
  )
  const ports = parsedPorts.ok ? parsedPorts.ports : [DEFAULT_WEBSERVER_PORT]
  const portsSpec = parsedPorts.ok ? parsedPorts.normalized : String(DEFAULT_WEBSERVER_PORT)

  const bindCheck = validateBindAddress(
    typeof settings.webserver_bind_address === "string" && settings.webserver_bind_address.trim()
      ? settings.webserver_bind_address
      : (defaults.defaultBindAddress ?? envDefaults.bindAddress),
  )

  const savedInternal = typeof settings.webserver_internal_url === "string" ? settings.webserver_internal_url.trim() : ""
  const savedExternal = typeof settings.webserver_external_url === "string" ? settings.webserver_external_url.trim() : ""
  const savedWsHa = typeof settings.webserver_home_assistant_url === "string" ? settings.webserver_home_assistant_url.trim() : ""
  const savedIntegrationHa = typeof settings.ha_url === "string" ? settings.ha_url.trim() : ""

  const internalCheck = validateWebserverUrl(savedInternal || envDefaults.internalUrl, "Internal URL")
  const externalCheck = validateWebserverUrl(savedExternal || envDefaults.externalUrl, "External URL")
  const haCheck = validateWebserverUrl(
    savedWsHa || savedIntegrationHa || defaults.detectedHaUrl || envDefaults.homeAssistantUrl,
    "Home Assistant URL",
  )

  const serverNameCheck = validateServerName(
    typeof settings.webserver_server_name === "string" && settings.webserver_server_name.trim()
      ? settings.webserver_server_name
      : (envDefaults.serverName || defaults.defaultServerName || "Meitheal"),
  )

  return {
    serverName: serverNameCheck.ok ? serverNameCheck.value : "Meitheal",
    internalUrl: internalCheck.ok ? internalCheck.value : "",
    externalUrl: externalCheck.ok ? externalCheck.value : "",
    homeAssistantUrl: haCheck.ok ? haCheck.value : "",
    portsSpec,
    ports,
    bindAddress: bindCheck.ok ? bindCheck.value : DEFAULT_BIND_ADDRESS,
    tlsEnabled: settings.webserver_tls_enabled === true || settings.webserver_tls_enabled === "true",
    sslCertificate: typeof settings.webserver_ssl_certificate === "string" ? settings.webserver_ssl_certificate : "",
    sslPrivateKeyConfigured: Boolean(settings.webserver_ssl_private_key),
    syncHaOptions: settings.webserver_sync_ha_options !== false && settings.webserver_sync_ha_options !== "false",
  }
}

/**
 * Resolve exact per-field provenance (`database` | `supervisor` | `process_env` | `dotenv` | `default`)
 * and live active listener comparison (`restartRequired`) across DB, process.env, and .env file layers.
 */
export function resolveWebserverRuntimeState(params: {
  config: WebserverConfig
  settings: Record<string, unknown>
  processEnv: Record<string, string | undefined>
  dotenvValues: Record<string, string | undefined>
  dotenvFound: boolean
  dotenvLabel: string | null
  dotenvKeys: string[]
  detectedHaUrl?: string | null | undefined
  now?: Date | undefined
}): { provenance: WebserverConfigProvenance; activeRuntime: WebserverActiveRuntime } {
  const { config, settings, processEnv, dotenvValues } = params

  const hasStr = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0
  const envOrigin = (keys: string[]): WebserverFieldProvenance => {
    for (const k of keys) {
      if (hasStr(processEnv[k])) return { source: "process_env", envVar: k }
    }
    for (const k of keys) {
      if (hasStr(dotenvValues[k])) return { source: "dotenv", envVar: k }
    }
    return { source: "default", envVar: null }
  }

  const provenance: WebserverConfigProvenance = {
    serverName: hasStr(settings.webserver_server_name)
      ? { source: "database", envVar: null }
      : envOrigin(["MEITHEAL_SERVER_NAME"]),
    internalUrl: hasStr(settings.webserver_internal_url)
      ? { source: "database", envVar: null }
      : envOrigin(["MEITHEAL_INTERNAL_URL"]),
    externalUrl: hasStr(settings.webserver_external_url)
      ? { source: "database", envVar: null }
      : envOrigin(["MEITHEAL_EXTERNAL_URL", "SITE_URL"]),
    homeAssistantUrl: hasStr(settings.webserver_home_assistant_url) || hasStr(settings.ha_url)
      ? { source: "database", envVar: null }
      : hasStr(params.detectedHaUrl)
        ? { source: "supervisor", envVar: null }
        : envOrigin(["HA_BASE_URL", "HA_URL"]),
    portsSpec: settings.webserver_ports !== undefined && settings.webserver_ports !== null && String(settings.webserver_ports).trim() !== ""
      ? { source: "database", envVar: null }
      : envOrigin(["MEITHEAL_PORTS", "PORT"]),
    bindAddress: hasStr(settings.webserver_bind_address)
      ? { source: "database", envVar: null }
      : envOrigin(["MEITHEAL_HOST", "HOST"]),
  }

  // Active running HTTP listener reflects live process.env (what serve.mjs / Astro bound at boot)
  const rawActivePorts = processEnv.MEITHEAL_PORTS ?? processEnv.PORT ?? dotenvValues.MEITHEAL_PORTS ?? dotenvValues.PORT ?? DEFAULT_WEBSERVER_PORT
  const parsedActive = parsePortSpec(rawActivePorts)
  const listeningPorts = parsedActive.ok ? parsedActive.ports : [DEFAULT_WEBSERVER_PORT]
  const listeningPortsSpec = parsedActive.ok ? parsedActive.normalized : String(DEFAULT_WEBSERVER_PORT)

  const rawActiveHost = processEnv.MEITHEAL_HOST ?? processEnv.HOST ?? dotenvValues.MEITHEAL_HOST ?? dotenvValues.HOST ?? DEFAULT_BIND_ADDRESS
  const hostCheck = validateBindAddress(rawActiveHost)
  const listeningHost = hostCheck.ok ? hostCheck.value : DEFAULT_BIND_ADDRESS

  const portsDiffer =
    config.ports.length !== listeningPorts.length ||
    config.ports.some((p, i) => p !== listeningPorts[i])
  const hostDiffers = config.bindAddress !== listeningHost

  return {
    provenance,
    activeRuntime: {
      listeningPorts,
      listeningPortsSpec,
      listeningHost,
      dotenvFound: params.dotenvFound,
      dotenvLabel: params.dotenvLabel,
      dotenvKeys: params.dotenvKeys,
      restartRequired: portsDiffer || hostDiffers,
      resolvedAt: (params.now ?? new Date()).toISOString(),
    },
  }
}
