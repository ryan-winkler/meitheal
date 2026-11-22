/**
 * Plugins Bounded Context — Public Server API Barrel
 *
 * Server routes import `@domains/plugins`. Browser scripts MUST NEVER import
 * this barrel so `node:sqlite` and secret internals never enter client bundles.
 *
 * @domain plugins
 * @bounded-context plugins
 */
export * from "./types"
export { BUILTIN_PLUGINS, getBuiltinPluginById, type BuiltinPluginDefinition } from "./builtin-plugins"
export { sanitizePluginIconSvg, validatePluginManifest } from "./plugin-manifest"
export {
  buildPluginZip,
  extractPluginZip,
  MAX_ZIP_COMPRESSED_BYTES,
  MAX_ZIP_COMPRESSION_RATIO,
  MAX_ZIP_FILES,
  MAX_ZIP_UNCOMPRESSED_BYTES,
  type ExtractedPluginArchive,
} from "./plugin-zip"
export {
  checkPluginCapability,
  PLUGIN_PERMISSION_CATALOG,
  requiresPermissionReconsent,
  type PluginPermissionDescriptor,
} from "./plugin-permissions"
export {
  classifyIpAddress,
  executePluginHttpRequest,
  validatePluginTargetUrl,
  type IpClassification,
  type PluginHttpGatewayDeps,
} from "./plugin-http-gateway"
export {
  ensurePluginTables,
  MAX_PLUGIN_STORAGE_BYTES,
  MAX_PLUGIN_STORAGE_KEYS,
  PLUGIN_SAFE_MODE_SETTING_KEY,
  PluginRepository,
  type PluginDbClient,
} from "./plugin-repository"
export {
  evaluatePluginHealth,
  summarizeFleetHealth,
  type PluginHealthEvaluationInput,
} from "./plugin-health"
export {
  getPluginService,
  PluginService,
  type ConnectorSyncItem,
  type PluginBundleInput,
  type PluginCatalogState,
  type PluginServiceDeps,
} from "./plugin-service"
