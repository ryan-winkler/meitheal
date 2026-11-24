/**
 * Webserver Application Service — Single Source of Truth (process.env + .env + SQLite + HA)
 *
 * Unifies:
 *   1. Database-stored webserver & HA settings (`app_settings`: `webserver_*` + `ha_url`)
 *   2. Live `process.env` (VM / Docker / HA container runtime environment)
 *   3. Canonical `.env` file state (strict allowlist, symlink-safe, mtime-cached)
 *   4. Home Assistant Supervisor & Core API auto-discovery
 *
 * Exposes a single orchestration boundary for `/api/webserver`,
 * `/api/webserver/verify`, `/api/ha/services`, and `/api/mcp` origin checks.
 *
 * @domain webserver
 * @bounded-context configuration
 */
import { ensureSchema, getPersistenceClient, SettingsRepository } from "@domains/tasks"
import { readUnifiedEnvSnapshot, type UnifiedEnvSnapshot } from "./env-state"
import {
  readSupervisorWebserverSnapshot,
  syncWebserverOptionsToSupervisor,
  type SupervisorWebserverSnapshot,
} from "./supervisor-webserver"
import {
  buildHaAddonOptionsPayload,
  evaluateWebserverSecurity,
  hydrateWebserverConfig,
  readWebserverEnvDefaults,
  resolveMcpEndpoints,
  resolveWebserverRuntimeState,
  validateWebserverConfigInput,
  WEBSERVER_SETTING_KEYS,
  type HaAddonOptionsPayload,
  type McpEndpointInfo,
  type WebserverActiveRuntime,
  type WebserverCheckItem,
  type WebserverConfig,
  type WebserverConfigInput,
  type WebserverConfigProvenance,
  type WebserverRuntimeEnv,
  type WebserverSecurityNotice,
} from "./webserver-config"

export interface WebserverSnapshotView {
  config: WebserverConfig
  mcp: McpEndpointInfo
  securityNotices: WebserverSecurityNotice[]
  supervisor: SupervisorWebserverSnapshot
  haOptions: HaAddonOptionsPayload
  runtimeEnv: WebserverRuntimeEnv
  provenance: WebserverConfigProvenance
  activeRuntime: WebserverActiveRuntime
}

export interface WebserverSettingsStore {
  getByKeys(keys: string[]): Promise<Record<string, unknown>>
  importBatch(entries: Array<{ key: string; value: string }>): Promise<unknown>
}

export interface WebserverServiceDeps {
  openRepo?: (() => Promise<WebserverSettingsStore>) | undefined
  readEnv?: (() => UnifiedEnvSnapshot) | undefined
  readSupervisor?: (() => Promise<SupervisorWebserverSnapshot>) | undefined
  syncSupervisor?: ((options: HaAddonOptionsPayload) => Promise<{ synced: boolean; detail: string }>) | undefined
}

const SETTINGS_READ_KEYS = [...WEBSERVER_SETTING_KEYS, "ha_url"] as const
const MCP_ORIGINS_TTL_MS = 5_000
let cachedAllowedOrigins: { origins: string[]; expiresAt: number } | null = null

/** Invalidate cached MCP allowed origins after webserver settings mutations. */
export function invalidateWebserverStateCache(): void {
  cachedAllowedOrigins = null
}

/** Safely extract request origin without throwing on malformed URLs. */
export function readRequestOrigin(request: Request): string {
  try {
    return new URL(request.url).origin
  } catch {
    return ""
  }
}

/** Open and initialize the settings repository for webserver reads/writes. */
export async function openWebserverSettingsRepo(): Promise<SettingsRepository> {
  await ensureSchema()
  const repo = new SettingsRepository(getPersistenceClient())
  await repo.ensureSettingsTable()
  return repo
}

/** Project validated config + DB rows + unified env + Supervisor snapshot into full API view. */
export function buildWebserverView(
  config: WebserverConfig,
  supervisor: SupervisorWebserverSnapshot,
  requestOrigin: string,
  envSnapshot: UnifiedEnvSnapshot = readUnifiedEnvSnapshot(),
  rawSettings: Record<string, unknown> = {},
): WebserverSnapshotView {
  const mcp = resolveMcpEndpoints({
    internalUrl: config.internalUrl,
    externalUrl: config.externalUrl,
    homeAssistantUrl: config.homeAssistantUrl,
    detectedHomeAssistantUrl: supervisor.detectedHaUrl ?? undefined,
    ports: config.ports,
    tlsEnabled: config.tlsEnabled,
    currentOrigin: requestOrigin,
    haConnected: supervisor.haConnected,
  })

  const securityNotices = evaluateWebserverSecurity(config, supervisor.mode === "ha-addon")
  const haOptions = buildHaAddonOptionsPayload(config, mcp.mcpServerUrl)
  const runtimeEnv = readWebserverEnvDefaults(envSnapshot.merged)
  const { provenance, activeRuntime } = resolveWebserverRuntimeState({
    config,
    settings: rawSettings,
    processEnv: envSnapshot.processEnv,
    dotenvValues: envSnapshot.dotenv.values,
    dotenvFound: envSnapshot.dotenv.found,
    dotenvLabel: envSnapshot.dotenv.fileLabel,
    dotenvKeys: envSnapshot.dotenv.keys,
    detectedHaUrl: supervisor.detectedHaUrl,
  })

  return {
    config,
    mcp,
    securityNotices,
    supervisor,
    haOptions,
    runtimeEnv,
    provenance,
    activeRuntime,
  }
}

/** Load the real-time unified state across SQLite DB, process.env, .env file, and HA Supervisor. */
export async function loadWebserverSnapshotView(
  request: Request,
  deps: WebserverServiceDeps = {},
): Promise<WebserverSnapshotView> {
  const openRepo = deps.openRepo ?? openWebserverSettingsRepo
  const readEnv = deps.readEnv ?? readUnifiedEnvSnapshot
  const readSupervisor = deps.readSupervisor ?? readSupervisorWebserverSnapshot

  const repo = await openRepo()
  const envSnapshot = readEnv()
  const [rawSettings, supervisor] = await Promise.all([
    repo.getByKeys([...SETTINGS_READ_KEYS]),
    readSupervisor(),
  ])

  const defaultServerName = supervisor.addonHostname
    ? `Meitheal (${supervisor.addonHostname})`
    : "Meitheal"

  const config = hydrateWebserverConfig(rawSettings, {
    defaultServerName,
    detectedHaUrl: supervisor.detectedHaUrl ?? undefined,
    env: envSnapshot.merged,
  })

  return buildWebserverView(config, supervisor, readRequestOrigin(request), envSnapshot, rawSettings)
}

/** Semantic alias for callers requesting the unified real-time webserver state. */
export const getUnifiedWebserverState = loadWebserverSnapshotView

/** Validate proposed webserver settings against real-time env, DB, and Supervisor state. */
export async function verifyWebserverConfiguration(
  request: Request,
  input: WebserverConfigInput,
  deps: WebserverServiceDeps = {},
): Promise<
  | { ok: true; view: WebserverSnapshotView; checks: WebserverCheckItem[] }
  | { ok: false; error: string; field: string | null; checks: WebserverCheckItem[] }
> {
  const openRepo = deps.openRepo ?? openWebserverSettingsRepo
  const readEnv = deps.readEnv ?? readUnifiedEnvSnapshot
  const readSupervisor = deps.readSupervisor ?? readSupervisorWebserverSnapshot

  const repo = await openRepo()
  const envSnapshot = readEnv()
  const existing = await repo.getByKeys([...SETTINGS_READ_KEYS])
  const existingKeyConfigured = Boolean(existing.webserver_ssl_private_key)

  const validation = validateWebserverConfigInput(input, existingKeyConfigured)
  if (!validation.ok) {
    return {
      ok: false,
      error: validation.error,
      field: validation.field ?? null,
      checks: [{
        id: validation.field ?? "validation",
        label: "Configuration check",
        status: "fail",
        detail: validation.error,
      }],
    }
  }

  const { config, checks } = validation
  const supervisor = await readSupervisor()
  const view = buildWebserverView(config, supervisor, readRequestOrigin(request), envSnapshot, existing)

  const haCheck: WebserverCheckItem = supervisor.haConnected
    ? {
        id: "home_assistant",
        label: "Home Assistant & Supervisor",
        status: "pass",
        detail: supervisor.supervisorAvailable
          ? `Connected to Home Assistant${supervisor.haVersion ? ` ${supervisor.haVersion}` : ""} via Supervisor (${supervisor.supervisorServices.length} Supervisor services detected).`
          : `Connected to Home Assistant${supervisor.haVersion ? ` ${supervisor.haVersion}` : ""}.`,
      }
    : {
        id: "home_assistant",
        label: "Home Assistant & Supervisor",
        status: "warn",
        detail: supervisor.mode === "ha-addon"
          ? "Running in add-on mode, but Home Assistant is currently unreachable."
          : "Running in standalone mode. Connect Home Assistant under Connected Services to enable Supervisor sync and live HA links.",
      }

  const mcpCheck: WebserverCheckItem = {
    id: "mcp",
    label: "MCP Server endpoint",
    status: "pass",
    detail: view.mcp.homeAssistantAiUrl
      ? `Ready at ${view.mcp.mcpServerUrl} with Home Assistant AI link (${view.mcp.homeAssistantAiUrl}).`
      : `Ready at ${view.mcp.mcpServerUrl}.`,
  }

  const runtimeCheck: WebserverCheckItem = view.activeRuntime.restartRequired
    ? {
        id: "runtime_sync",
        label: "Active listener alignment",
        status: "warn",
        detail: `Server is currently listening on ${view.activeRuntime.listeningHost}:${view.activeRuntime.listeningPortsSpec}. Restart Meitheal after saving to bind ${config.bindAddress}:${config.portsSpec}.`,
      }
    : {
        id: "runtime_sync",
        label: "Active listener alignment",
        status: "pass",
        detail: `Matches live server listener (${view.activeRuntime.listeningHost}:${view.activeRuntime.listeningPortsSpec}).`,
      }

  return {
    ok: true,
    view,
    checks: [...checks, runtimeCheck, haCheck, mcpCheck],
  }
}

/** Validate, persist to SQLite (with ha_url unification), optionally sync HA Supervisor, and return unified state. */
export async function saveWebserverConfiguration(
  request: Request,
  input: WebserverConfigInput,
  deps: WebserverServiceDeps = {},
): Promise<
  | {
      ok: true
      view: WebserverSnapshotView
      checks: WebserverCheckItem[]
      supervisorSync: { synced: boolean; detail: string }
    }
  | { ok: false; error: string; field?: string | undefined }
> {
  const openRepo = deps.openRepo ?? openWebserverSettingsRepo
  const readEnv = deps.readEnv ?? readUnifiedEnvSnapshot
  const readSupervisor = deps.readSupervisor ?? readSupervisorWebserverSnapshot
  const syncSupervisor = deps.syncSupervisor ?? syncWebserverOptionsToSupervisor

  const repo = await openRepo()
  const existing = await repo.getByKeys([...SETTINGS_READ_KEYS])
  const existingKeyConfigured = Boolean(existing.webserver_ssl_private_key)

  const validation = validateWebserverConfigInput(input, existingKeyConfigured)
  if (!validation.ok) {
    return { ok: false, error: validation.error, field: validation.field }
  }

  const { config, checks, newPrivateKey } = validation
  const writes: Array<{ key: string; value: string }> = [
    { key: "webserver_server_name", value: JSON.stringify(config.serverName) },
    { key: "webserver_internal_url", value: JSON.stringify(config.internalUrl) },
    { key: "webserver_external_url", value: JSON.stringify(config.externalUrl) },
    { key: "webserver_home_assistant_url", value: JSON.stringify(config.homeAssistantUrl) },
    { key: "webserver_ports", value: JSON.stringify(config.portsSpec) },
    { key: "webserver_bind_address", value: JSON.stringify(config.bindAddress) },
    { key: "webserver_tls_enabled", value: JSON.stringify(config.tlsEnabled) },
    { key: "webserver_ssl_certificate", value: JSON.stringify(config.sslCertificate) },
    { key: "webserver_sync_ha_options", value: JSON.stringify(config.syncHaOptions) },
  ]

  const prevWsHa = typeof existing.webserver_home_assistant_url === "string" ? existing.webserver_home_assistant_url.trim() : ""
  const prevIntHa = typeof existing.ha_url === "string" ? existing.ha_url.trim() : ""
  if (config.homeAssistantUrl && (!prevIntHa || prevIntHa === prevWsHa)) {
    writes.push({ key: "ha_url", value: JSON.stringify(config.homeAssistantUrl) })
  }

  if (newPrivateKey !== undefined) {
    writes.push({
      key: "webserver_ssl_private_key",
      value: JSON.stringify(newPrivateKey ?? ""),
    })
  }

  await repo.importBatch(writes)
  invalidateWebserverStateCache()

  const envSnapshot = readEnv()
  const [freshSettings, supervisor] = await Promise.all([
    repo.getByKeys([...SETTINGS_READ_KEYS]),
    readSupervisor(),
  ])
  const view = buildWebserverView(config, supervisor, readRequestOrigin(request), envSnapshot, freshSettings)
  const supervisorSync = config.syncHaOptions
    ? await syncSupervisor(view.haOptions)
    : { synced: false, detail: "Home Assistant option sync is turned off." }

  return { ok: true, view, checks, supervisorSync }
}

/**
 * Resolve the unified set of configured HTTP/HTTPS origins allowed to call `/api/mcp`
 * across SQLite settings, `process.env`, and `.env` (cached briefly for hot-path speed).
 */
export async function getUnifiedAllowedMcpOrigins(deps: WebserverServiceDeps = {}): Promise<string[]> {
  const now = Date.now()
  if (cachedAllowedOrigins && now < cachedAllowedOrigins.expiresAt) {
    return cachedAllowedOrigins.origins
  }

  const readEnv = deps.readEnv ?? readUnifiedEnvSnapshot
  const openRepo = deps.openRepo ?? openWebserverSettingsRepo

  const envSnapshot = readEnv()
  const candidates: Array<string | undefined> = [
    envSnapshot.merged.SITE_URL,
    envSnapshot.merged.MEITHEAL_EXTERNAL_URL,
    envSnapshot.merged.MEITHEAL_INTERNAL_URL,
  ]

  try {
    const repo = await openRepo()
    const saved = await repo.getByKeys(["webserver_external_url", "webserver_internal_url"])
    if (typeof saved.webserver_external_url === "string") candidates.push(saved.webserver_external_url)
    if (typeof saved.webserver_internal_url === "string") candidates.push(saved.webserver_internal_url)
  } catch {
    // Non-fatal: env-configured origins still apply if DB is unavailable.
  }

  const origins = new Set<string>()
  for (const raw of candidates) {
    if (!raw) continue
    const parsed = URL.parse(raw.trim())
    if (parsed && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
      origins.add(parsed.origin)
    }
  }

  const list = [...origins]
  cachedAllowedOrigins = { origins: list, expiresAt: now + MCP_ORIGINS_TTL_MS }
  return list
}
