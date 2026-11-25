/**
 * Plugin Application Service
 *
 * Orchestrates plugin discovery, ZIP installation, enable/disable/re-consent,
 * connector configuration & sync, isolated storage, write-only secrets,
 * Safe Mode, and SSRF-hardened HTTP gateway execution.
 *
 * @domain plugins
 * @bounded-context plugins
 */
import { BUILTIN_PLUGINS, getBuiltinPluginById } from "./builtin-plugins"
import { evaluatePluginHealth, summarizeFleetHealth } from "./plugin-health"
import { executePluginHttpRequest, type PluginHttpGatewayDeps } from "./plugin-http-gateway"
import { sanitizePluginIconSvg, validatePluginManifest } from "./plugin-manifest"
import { checkPluginCapability, requiresPermissionReconsent } from "./plugin-permissions"
import { PluginRepository, type PluginDbClient } from "./plugin-repository"
import { buildPluginZip, extractPluginZip } from "./plugin-zip"
import type {
  PluginFiles,
  PluginFleetHealthSummary,
  PluginHttpRequestInput,
  PluginHttpResponse,
  PluginRecord,
  PluginResult,
  PluginRuntimeBundle,
  PluginSecretStatus,
  PluginView,
} from "./types"

const STORAGE_KEY_RE = /^[a-zA-Z0-9._:-]{1,64}$/
const SECRET_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

export interface PluginServiceDeps {
  db?: PluginDbClient
  httpDeps?: Omit<PluginHttpGatewayDeps, "resolveSecret">
}

export interface PluginCatalogState {
  safeMode: boolean
  fleetHealth: PluginFleetHealthSummary
  plugins: PluginView[]
}

export interface PluginBundleInput {
  manifest: unknown
  pluginJs?: string
  indexHtml?: string
  iconSvg?: string
}

export interface ConnectorSyncItem {
  externalId: string
  title: string
  description?: string
  url?: string
  dueDate?: string
}

export class PluginService {
  private readonly repo: PluginRepository
  private readonly httpDeps: Omit<PluginHttpGatewayDeps, "resolveSecret">

  constructor(deps: PluginServiceDeps = {}) {
    this.repo = new PluginRepository(deps.db)
    this.httpDeps = deps.httpDeps ?? {}
  }

  private async resolveRecord(pluginId: string): Promise<PluginRecord | null> {
    if (!PLUGIN_ID_RE.test(pluginId)) return null
    const stored = await this.repo.getStoredRecord(pluginId)
    const builtin = getBuiltinPluginById(pluginId)
    if (builtin) {
      const now = new Date().toISOString()
      return {
        id: builtin.manifest.id,
        source: "builtin",
        enabled: stored?.enabled ?? false,
        needsReconsent: false,
        manifest: builtin.manifest,
        files: builtin.files,
        sha256: builtin.sha256,
        config: stored?.config ?? {},
        approvedUserServer: stored?.approvedUserServer ?? null,
        installedAt: stored?.installedAt ?? now,
        updatedAt: stored?.updatedAt ?? now,
      }
    }
    return stored
  }

  private async toView(record: PluginRecord, safeMode?: boolean): Promise<PluginView> {
    const resolvedSafeMode = safeMode ?? (await this.repo.getSafeMode())
    const secrets = await this.repo.listSecretStatuses(record.id)
    // Include declared connector secret fields as configured: false if not set yet
    const statusMap = new Map<string, PluginSecretStatus>()
    for (const s of secrets) statusMap.set(s.key, s)
    for (const field of record.manifest.connector?.configFields ?? []) {
      if (field.type === "secret" && field.secretKey && !statusMap.has(field.secretKey)) {
        statusMap.set(field.secretKey, { key: field.secretKey, configured: false })
      }
    }
    const sortedSecrets = [...statusMap.values()].sort((a, b) => a.key.localeCompare(b.key))
    const health = evaluatePluginHealth({
      record,
      secrets: sortedSecrets,
      safeMode: resolvedSafeMode,
    })
    return {
      id: record.id,
      source: record.source,
      enabled: record.enabled,
      needsReconsent: record.needsReconsent,
      manifest: record.manifest,
      iconSvg: record.files.iconSvg ?? null,
      sha256: record.sha256,
      config: record.config,
      approvedUserServer: record.approvedUserServer,
      secrets: sortedSecrets,
      health,
      installedAt: record.installedAt,
      updatedAt: record.updatedAt,
    }
  }

  async listPlugins(): Promise<PluginCatalogState> {
    const safeMode = await this.repo.getSafeMode()
    const stored = await this.repo.listStoredRecords()
    const storedById = new Map(stored.map((r) => [r.id, r]))
    const records: PluginRecord[] = []
    const seen = new Set<string>()
    const now = new Date().toISOString()

    for (const builtin of BUILTIN_PLUGINS) {
      const state = storedById.get(builtin.manifest.id)
      records.push({
        id: builtin.manifest.id,
        source: "builtin",
        enabled: state?.enabled ?? false,
        needsReconsent: false,
        manifest: builtin.manifest,
        files: builtin.files,
        sha256: builtin.sha256,
        config: state?.config ?? {},
        approvedUserServer: state?.approvedUserServer ?? null,
        installedAt: state?.installedAt ?? now,
        updatedAt: state?.updatedAt ?? now,
      })
      seen.add(builtin.manifest.id)
    }

    for (const item of stored) {
      if (!seen.has(item.id) && item.source === "uploaded") {
        records.push(item)
      }
    }

    const views = await Promise.all(records.map((r) => this.toView(r, safeMode)))
    const fleetHealth = summarizeFleetHealth(
      views.map((v) => v.health),
      safeMode,
    )
    return { safeMode, fleetHealth, plugins: views }
  }

  async getPlugin(pluginId: string): Promise<PluginView | null> {
    const record = await this.resolveRecord(pluginId)
    return record ? this.toView(record) : null
  }

  async hasActivePlugins(): Promise<boolean> {
    return this.repo.hasActivePlugins()
  }

  async getRuntimeBundles(): Promise<{ safeMode: boolean; bundles: PluginRuntimeBundle[] }> {
    const safeMode = await this.repo.getSafeMode()
    if (safeMode) return { safeMode: true, bundles: [] }

    const stored = await this.repo.listStoredRecords()
    const storedById = new Map(stored.map((r) => [r.id, r]))
    const active: PluginRecord[] = []
    const seen = new Set<string>()

    for (const builtin of BUILTIN_PLUGINS) {
      const state = storedById.get(builtin.manifest.id)
      if (state?.enabled) {
        active.push({
          id: builtin.manifest.id,
          source: "builtin",
          enabled: true,
          needsReconsent: false,
          manifest: builtin.manifest,
          files: builtin.files,
          sha256: builtin.sha256,
          config: state.config ?? {},
          approvedUserServer: state.approvedUserServer ?? null,
          installedAt: state.installedAt,
          updatedAt: state.updatedAt,
        })
      }
      seen.add(builtin.manifest.id)
    }

    for (const item of stored) {
      if (!seen.has(item.id) && item.source === "uploaded" && item.enabled && !item.needsReconsent) {
        active.push(item)
      }
    }

    return {
      safeMode: false,
      bundles: active.map((record) => ({
        id: record.id,
        name: record.manifest.name,
        version: record.manifest.version,
        type: record.manifest.type,
        permissions: record.manifest.permissions,
        hooks: record.manifest.hooks,
        sidePanel: Boolean(record.manifest.sidePanel && record.files.iframeHtml),
        entryJs: record.files.entryJs ?? null,
        iframeHtml: record.files.iframeHtml ?? null,
        iconSvg: record.files.iconSvg ?? null,
        config: record.config,
      })),
    }
  }

  async installFromZip(zipBuffer: Buffer): Promise<PluginResult<PluginView>> {
    const extracted = extractPluginZip(zipBuffer)
    if (!extracted.ok) return extracted

    const manifestBytes = extracted.data.files.get("manifest.json")
    if (!manifestBytes) {
      return { ok: false, errorCode: "MISSING_MANIFEST", error: "manifest.json is required.", status: 400 }
    }

    let rawManifest: unknown
    try {
      rawManifest = JSON.parse(manifestBytes.toString("utf8"))
    } catch {
      return { ok: false, errorCode: "INVALID_MANIFEST", error: "manifest.json contains invalid JSON.", status: 400 }
    }

    const validated = validatePluginManifest(rawManifest)
    if (!validated.ok) return validated
    const manifest = validated.data

    if (getBuiltinPluginById(manifest.id)) {
      return {
        ok: false,
        errorCode: "BUILTIN_ID_CONFLICT",
        error: `Plugin ID "${manifest.id}" is reserved for a built-in plugin.`,
        status: 409,
      }
    }

    const files: PluginFiles = {}
    if (manifest.entry) {
      const entryBuf = extracted.data.files.get(manifest.entry)
      if (!entryBuf) {
        return {
          ok: false,
          errorCode: "MISSING_ENTRY",
          error: `Declared entry script "${manifest.entry}" was not found in the archive.`,
          status: 400,
        }
      }
      files.entryJs = entryBuf.toString("utf8")
    }

    if (manifest.iFrame) {
      const iframeBuf = extracted.data.files.get(manifest.iFrame)
      if (!iframeBuf) {
        return {
          ok: false,
          errorCode: "MISSING_IFRAME",
          error: `Declared iFrame file "${manifest.iFrame}" was not found in the archive.`,
          status: 400,
        }
      }
      files.iframeHtml = iframeBuf.toString("utf8")
    }

    if (manifest.icon) {
      const iconBuf = extracted.data.files.get(manifest.icon)
      if (!iconBuf) {
        return {
          ok: false,
          errorCode: "MISSING_ICON",
          error: `Declared icon "${manifest.icon}" was not found in the archive.`,
          status: 400,
        }
      }
      const cleanSvg = sanitizePluginIconSvg(iconBuf.toString("utf8"))
      if (!cleanSvg.ok) return cleanSvg
      files.iconSvg = cleanSvg.data
    }

    const existing = await this.repo.getStoredRecord(manifest.id)
    const needsReconsent = existing !== null && (existing.needsReconsent || requiresPermissionReconsent(existing.manifest, manifest))
    const now = new Date().toISOString()

    const nextRecord: PluginRecord = {
      id: manifest.id,
      source: "uploaded",
      // Newly uploaded plugins start disabled; upgrades with new permissions force re-consent.
      enabled: (existing?.enabled ?? false) && !needsReconsent,
      needsReconsent,
      manifest,
      files,
      sha256: extracted.data.sha256,
      config: existing?.config ?? {},
      approvedUserServer: existing?.approvedUserServer ?? null,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    }

    await this.repo.upsertRecord(nextRecord)
    return { ok: true, data: await this.toView(nextRecord) }
  }

  async installFromBundle(bundle: PluginBundleInput): Promise<PluginResult<PluginView>> {
    if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
      return { ok: false, errorCode: "INVALID_BUNDLE", error: "Bundle must be a JSON object.", status: 400 }
    }
    const validated = validatePluginManifest(bundle.manifest)
    if (!validated.ok) return validated
    const manifest = validated.data

    const entries: Array<{ name: string; content: string }> = [
      { name: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    ]
    if (manifest.entry) {
      if (typeof bundle.pluginJs !== "string" || !bundle.pluginJs.trim()) {
        return { ok: false, errorCode: "MISSING_ENTRY", error: `Provide pluginJs for "${manifest.entry}".`, status: 400 }
      }
      entries.push({ name: manifest.entry, content: bundle.pluginJs })
    }
    if (manifest.iFrame) {
      if (typeof bundle.indexHtml !== "string" || !bundle.indexHtml.trim()) {
        return { ok: false, errorCode: "MISSING_IFRAME", error: `Provide indexHtml for "${manifest.iFrame}".`, status: 400 }
      }
      entries.push({ name: manifest.iFrame, content: bundle.indexHtml })
    }
    if (manifest.icon) {
      if (typeof bundle.iconSvg !== "string" || !bundle.iconSvg.trim()) {
        return { ok: false, errorCode: "MISSING_ICON", error: `Provide iconSvg for "${manifest.icon}".`, status: 400 }
      }
      entries.push({ name: manifest.icon, content: bundle.iconSvg })
    }

    // Route through buildPluginZip -> installFromZip so every security, size, SVG, and re-consent invariant applies identically.
    const zipBuffer = buildPluginZip(entries)
    return this.installFromZip(zipBuffer)
  }

  async updatePlugin(
    pluginId: string,
    patch: {
      enabled?: boolean
      approveReconsent?: boolean
      config?: Record<string, unknown>
      approvedUserServer?: string | null
    },
  ): Promise<PluginResult<PluginView>> {
    const current = await this.resolveRecord(pluginId)
    if (!current) {
      return { ok: false, errorCode: "NOT_FOUND", error: `Plugin "${pluginId}" was not found.`, status: 404 }
    }

    let nextConfig = { ...current.config }
    let nextApprovedServer = current.approvedUserServer

    if (patch.config && typeof patch.config === "object" && !Array.isArray(patch.config)) {
      const sanitized: Record<string, unknown> = {}
      const declaredFields = new Map(
        (current.manifest.connector?.configFields ?? []).map((f) => [f.key, f]),
      )
      for (const [key, val] of Object.entries(patch.config)) {
        const field = declaredFields.get(key)
        // Never persist secret field values inside plaintext config JSON
        if (field?.type === "secret") continue
        if (typeof val === "string") {
          const trimmed = val.trim().slice(0, 500)
          sanitized[key] = trimmed
          if (field?.bindUserServer && trimmed) {
            nextApprovedServer = trimmed
          }
        } else if (typeof val === "number" || typeof val === "boolean") {
          sanitized[key] = val
        }
      }
      nextConfig = { ...nextConfig, ...sanitized }
    }

    if (patch.approvedUserServer !== undefined) {
      if (patch.approvedUserServer === null || patch.approvedUserServer === "") {
        nextApprovedServer = null
      } else {
        try {
          const parsed = new URL(patch.approvedUserServer)
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
            return {
              ok: false,
              errorCode: "INVALID_URL",
              error: "Server URL must start with https:// or http://.",
              status: 400,
            }
          }
          nextApprovedServer = parsed.origin + parsed.pathname.replace(/\/+$/, "")
        } catch {
          return {
            ok: false,
            errorCode: "INVALID_URL",
            error: "Approved server URL must be a valid URL.",
            status: 400,
          }
        }
      }
    }

    const nextNeedsReconsent = patch.approveReconsent ? false : current.needsReconsent
    let nextEnabled = current.enabled
    if (typeof patch.enabled === "boolean") {
      if (patch.enabled && nextNeedsReconsent) {
        return {
          ok: false,
          errorCode: "RECONSENT_REQUIRED",
          error: "Approve updated permissions before re-enabling this plugin.",
          status: 409,
        }
      }
      nextEnabled = patch.enabled
    }

    const updated: PluginRecord = {
      ...current,
      enabled: nextEnabled,
      needsReconsent: nextNeedsReconsent,
      config: nextConfig,
      approvedUserServer: nextApprovedServer,
      updatedAt: new Date().toISOString(),
    }

    await this.repo.upsertRecord(updated)
    return { ok: true, data: await this.toView(updated) }
  }

  async uninstallPlugin(pluginId: string): Promise<PluginResult<{ removed: boolean }>> {
    if (!PLUGIN_ID_RE.test(pluginId)) {
      return { ok: false, errorCode: "INVALID_ID", error: "Invalid plugin ID.", status: 400 }
    }
    if (getBuiltinPluginById(pluginId)) {
      return {
        ok: false,
        errorCode: "CANNOT_UNINSTALL_BUILTIN",
        error: "Built-in plugins cannot be uninstalled. Toggle the switch to disable them.",
        status: 400,
      }
    }
    const existing = await this.repo.getStoredRecord(pluginId)
    if (!existing) {
      return { ok: false, errorCode: "NOT_FOUND", error: `Plugin "${pluginId}" was not found.`, status: 404 }
    }
    await this.repo.deletePlugin(pluginId)
    return { ok: true, data: { removed: true } }
  }

  async removeAllUploadedPlugins(): Promise<{ removedCount: number }> {
    const removedCount = await this.repo.deleteAllUploaded()
    return { removedCount }
  }

  async setSafeMode(enabled: boolean): Promise<{ safeMode: boolean }> {
    await this.repo.setSafeMode(enabled)
    return { safeMode: enabled }
  }

  async getSafeMode(): Promise<boolean> {
    return this.repo.getSafeMode()
  }

  // ── Isolated Storage API ──

  async readStorage(pluginId: string, key?: string): Promise<PluginResult<unknown>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    const check = checkPluginCapability(record, "storage:local", await this.repo.getSafeMode())
    if (!check.ok) return check

    if (key !== undefined) {
      if (!STORAGE_KEY_RE.test(key)) {
        return { ok: false, errorCode: "INVALID_KEY", error: "Invalid storage key.", status: 400 }
      }
      return { ok: true, data: await this.repo.getStorageValue(pluginId, key) }
    }
    return { ok: true, data: await this.repo.listStorageMap(pluginId) }
  }

  async writeStorage(pluginId: string, key: string, value: unknown): Promise<PluginResult<{ saved: true }>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    const check = checkPluginCapability(record, "storage:local", await this.repo.getSafeMode())
    if (!check.ok) return check

    if (!STORAGE_KEY_RE.test(key)) {
      return { ok: false, errorCode: "INVALID_KEY", error: "Invalid storage key.", status: 400 }
    }
    const result = await this.repo.setStorageValue(pluginId, key, value)
    if (!result.ok) {
      return { ok: false, errorCode: "STORAGE_QUOTA_EXCEEDED", error: result.error, status: 413 }
    }
    return { ok: true, data: { saved: true } }
  }

  async deleteStorage(pluginId: string, key: string): Promise<PluginResult<{ deleted: true }>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    const check = checkPluginCapability(record, "storage:local", await this.repo.getSafeMode())
    if (!check.ok) return check

    if (!STORAGE_KEY_RE.test(key)) {
      return { ok: false, errorCode: "INVALID_KEY", error: "Invalid storage key.", status: 400 }
    }
    await this.repo.deleteStorageValue(pluginId, key)
    return { ok: true, data: { deleted: true } }
  }

  // ── Write-Only Secrets API (Admin-Only) ──

  async listSecrets(pluginId: string): Promise<PluginResult<PluginSecretStatus[]>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    const view = await this.toView(record)
    return { ok: true, data: view.secrets }
  }

  async setSecret(pluginId: string, key: string, value: string): Promise<PluginResult<{ configured: true }>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    if (!SECRET_KEY_RE.test(key)) {
      return { ok: false, errorCode: "INVALID_SECRET_KEY", error: "Invalid secret key name.", status: 400 }
    }
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > 4096) {
      return { ok: false, errorCode: "INVALID_SECRET_VALUE", error: "Secret value must be 1 to 4096 characters.", status: 400 }
    }
    await this.repo.setSecretValue(pluginId, key, trimmed)
    return { ok: true, data: { configured: true } }
  }

  async deleteSecret(pluginId: string, key: string): Promise<PluginResult<{ deleted: true }>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    if (!SECRET_KEY_RE.test(key)) {
      return { ok: false, errorCode: "INVALID_SECRET_KEY", error: "Invalid secret key name.", status: 400 }
    }
    await this.repo.deleteSecretValue(pluginId, key)
    return { ok: true, data: { deleted: true } }
  }

  // ── SSRF-Guarded Outbound HTTP Gateway ──

  async proxyHttpRequest(
    pluginId: string,
    input: PluginHttpRequestInput,
  ): Promise<PluginResult<PluginHttpResponse>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    const safeMode = await this.repo.getSafeMode()
    return executePluginHttpRequest(record, safeMode, input, {
      ...this.httpDeps,
      resolveSecret: (id, key) => this.repo.getSecretValueInternal(id, key),
    })
  }

  // ── Built-In Connector Test & Fetch Helpers (Routed Through Gateway) ──

  async testConnector(pluginId: string): Promise<PluginResult<{ connected: boolean; message: string }>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    if (record.manifest.type !== "connector") {
      return { ok: false, errorCode: "NOT_A_CONNECTOR", error: "This plugin is not an external connector.", status: 400 }
    }

    const request = this.buildConnectorRequest(record, "test")
    if (!request.ok) return request

    // Temporarily run through gateway using enabled check bypassed only if testing config?
    // Enforce strict ADR 0028 policy: plugin must be enabled and Safe Mode off to make outbound calls.
    const res = await this.proxyHttpRequest(pluginId, request.data)
    if (!res.ok) return res

    return {
      ok: true,
      data: {
        connected: res.data.ok,
        message: res.data.ok
          ? `Connected to ${record.manifest.name} (HTTP ${res.data.status}).`
          : `${record.manifest.name} returned HTTP ${res.data.status}.`,
      },
    }
  }

  async fetchConnectorItems(pluginId: string): Promise<PluginResult<ConnectorSyncItem[]>> {
    const record = await this.resolveRecord(pluginId)
    if (!record) return { ok: false, errorCode: "NOT_FOUND", error: "Plugin not found.", status: 404 }
    if (record.manifest.type !== "connector") {
      return { ok: false, errorCode: "NOT_A_CONNECTOR", error: "This plugin is not an external connector.", status: 400 }
    }

    const request = this.buildConnectorRequest(record, "fetch")
    if (!request.ok) return request

    const res = await this.proxyHttpRequest(pluginId, request.data)
    if (!res.ok) return res
    if (!res.data.ok || !Array.isArray(res.data.json)) {
      return {
        ok: false,
        errorCode: "CONNECTOR_UPSTREAM_ERROR",
        error: `Connector upstream returned HTTP ${res.data.status}.`,
        status: 502,
      }
    }

    const repoSlug = String(record.config.repository ?? "").trim()
    const items: ConnectorSyncItem[] = []
    for (const raw of res.data.json) {
      if (!raw || typeof raw !== "object") continue
      const issue = raw as Record<string, unknown>
      if (pluginId === "github-issues" && issue.pull_request) continue
      const num = issue.number
      const title = typeof issue.title === "string" ? issue.title.trim() : ""
      if (!num || !title) continue
      items.push({
        externalId: `${pluginId}:${repoSlug}#${String(num)}`,
        title: `[#${String(num)}] ${title}`.slice(0, 180),
        description: typeof issue.body === "string" ? issue.body.slice(0, 2000) : "",
        url: typeof issue.html_url === "string" ? issue.html_url : undefined,
        dueDate:
          typeof issue.due_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(issue.due_date)
            ? issue.due_date.slice(0, 10)
            : undefined,
      })
    }

    return { ok: true, data: items }
  }

  private buildConnectorRequest(
    record: PluginRecord,
    mode: "test" | "fetch",
  ): PluginResult<PluginHttpRequestInput> {
    const repo = String(record.config.repository ?? "").trim()
    if (record.id === "github-issues") {
      if (mode === "fetch" && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
        return {
          ok: false,
          errorCode: "INVALID_CONFIG",
          error: 'Enter a valid GitHub repository slug in "owner/name" format.',
          status: 400,
        }
      }
      const url =
        mode === "test"
          ? repo && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)
            ? `https://api.github.com/repos/${repo}`
            : "https://api.github.com/user"
          : `https://api.github.com/repos/${repo}/issues?state=open&per_page=25`
      return {
        ok: true,
        data: {
          method: "GET",
          url,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: "Bearer {{secret:github_token}}",
          },
        },
      }
    }

    if (record.id === "gitea-issues") {
      const serverUrl = String(record.config.serverUrl ?? record.approvedUserServer ?? "")
        .trim()
        .replace(/\/+$/, "")
      if (!serverUrl) {
        return { ok: false, errorCode: "INVALID_CONFIG", error: "Configure a Gitea Server URL first.", status: 400 }
      }
      if (mode === "fetch" && !/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo)) {
        return {
          ok: false,
          errorCode: "INVALID_CONFIG",
          error: 'Enter a valid Gitea repository slug in "owner/name" format.',
          status: 400,
        }
      }
      const url =
        mode === "test"
          ? `${serverUrl}/api/v1/user`
          : `${serverUrl}/api/v1/repos/${repo}/issues?state=open&limit=25`
      return {
        ok: true,
        data: {
          method: "GET",
          url,
          headers: {
            Authorization: "token {{secret:gitea_token}}",
          },
        },
      }
    }

    return {
      ok: false,
      errorCode: "CUSTOM_CONNECTOR_RUNTIME",
      error: "Custom connectors execute through the sandboxed plugin runtime.",
      status: 400,
    }
  }
}

let defaultService: PluginService | null = null

export function getPluginService(): PluginService {
  if (!defaultService) defaultService = new PluginService()
  return defaultService
}
