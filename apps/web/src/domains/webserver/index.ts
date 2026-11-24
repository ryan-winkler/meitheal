/**
 * Webserver Domain — Barrel Export
 * @domain webserver
 * @bounded-context configuration
 */
export {
  MAX_RESOLVED_PORTS,
  DEFAULT_WEBSERVER_PORT,
  DEFAULT_BIND_ADDRESS,
  WEBSERVER_SETTING_KEYS,
  parsePortSpec,
  formatPortSummary,
  validateWebserverUrl,
  validateBindAddress,
  validateTlsMaterial,
  validateServerName,
  resolveMcpEndpoints,
  evaluateWebserverSecurity,
  validateWebserverConfigInput,
  buildHaAddonOptionsPayload,
  readWebserverEnvDefaults,
  hydrateWebserverConfig,
  resolveWebserverRuntimeState,
} from "./webserver-config"

export type {
  WebserverSettingKey,
  PortSpecMode,
  ParsedPortSpec,
  PortSpecError,
  PortSpecResult,
  WebserverConfig,
  WebserverConfigInput,
  McpEndpointInfo,
  WebserverFieldSource,
  WebserverFieldProvenance,
  WebserverConfigProvenance,
  WebserverActiveRuntime,
  WebserverRuntimeEnv,
  WebserverSecurityNotice,
  WebserverCheckItem,
  HaAddonOptionsPayload,
} from "./webserver-config"

export {
  ALLOWED_WEBSERVER_ENV_KEYS,
  parseAllowlistedDotenvContent,
  readSafeDotenvState,
  mergeEnvLayers,
  readUnifiedEnvSnapshot,
} from "./env-state"

export type {
  AllowedWebserverEnvKey,
  DotenvFileState,
  EnvKeyOrigin,
  UnifiedEnvSnapshot,
} from "./env-state"

export {
  readSupervisorWebserverSnapshot,
  syncWebserverOptionsToSupervisor,
} from "./supervisor-webserver"

export type {
  BindInterfaceOption,
  SupervisorServiceEntry,
  SupervisorWebserverSnapshot,
} from "./supervisor-webserver"

export {
  readRequestOrigin,
  openWebserverSettingsRepo,
  buildWebserverView,
  loadWebserverSnapshotView,
  getUnifiedWebserverState,
  verifyWebserverConfiguration,
  saveWebserverConfiguration,
  getUnifiedAllowedMcpOrigins,
  invalidateWebserverStateCache,
} from "./webserver-service"

export type {
  WebserverServiceDeps,
  WebserverSettingsStore,
  WebserverSnapshotView,
} from "./webserver-service"
