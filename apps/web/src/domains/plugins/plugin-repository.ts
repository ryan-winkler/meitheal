/**
 * Plugin SQLite Repository
 *
 * Manages three dedicated tables in local SQLite (`node:sqlite` via
 * `getPersistenceClient()`):
 *   - `plugins`: installed uploaded plugins + built-in enablement/config state
 *   - `plugin_storage`: isolated key-value storage per plugin (256 KB quota)
 *   - `plugin_secrets`: write-only credentials excluded from JSON/CSV/SQLite exports
 *
 * All queries are strictly parameterized and support dependency injection
 * (`PluginDbClient`) for isolated temporary-SQLite unit tests.
 *
 * @domain plugins
 * @bounded-context plugins
 */
import { ensureSchema, getPersistenceClient } from "@domains/tasks"
import { localReaderCacheToken } from "../../../scripts/database-client.mjs"
import type {
  PluginFiles,
  PluginManifest,
  PluginRecord,
  PluginSecretStatus,
} from "./types"

export interface PluginDbClient {
  execute(query: string | { sql: string; args?: unknown[] }): Promise<{
    rows: Array<Record<string, unknown>>
  }>
}

export const PLUGIN_SAFE_MODE_SETTING_KEY = "plugin_safe_mode"
const activePluginsCache = new WeakMap<object, { token: string; active: boolean }>()
export const MAX_PLUGIN_STORAGE_BYTES = 256 * 1024 // 256 KB per plugin
export const MAX_PLUGIN_STORAGE_KEYS = 100

let defaultSchemaReady = false

async function getDefaultDb(): Promise<PluginDbClient> {
  await ensureSchema()
  const client = getPersistenceClient() as unknown as PluginDbClient
  if (!defaultSchemaReady) {
    await ensurePluginTables(client)
    defaultSchemaReady = true
  }
  return client
}

export async function ensurePluginTables(db: PluginDbClient): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      needs_reconsent INTEGER NOT NULL DEFAULT 0,
      manifest_json TEXT NOT NULL,
      files_json TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      approved_user_server TEXT,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS plugin_storage (
      plugin_id TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, storage_key)
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS plugin_secrets (
      plugin_id TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      secret_value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (plugin_id, secret_key)
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS plugin_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

function rowToPluginRecord(row: Record<string, unknown>): PluginRecord | null {
  try {
    const manifest = JSON.parse(String(row.manifest_json)) as PluginManifest
    const files = JSON.parse(String(row.files_json || "{}")) as PluginFiles
    const config = JSON.parse(String(row.config_json || "{}")) as Record<string, unknown>
    return {
      id: String(row.id),
      source: row.source === "uploaded" ? "uploaded" : "builtin",
      enabled: Number(row.enabled) === 1,
      needsReconsent: Number(row.needs_reconsent) === 1,
      manifest,
      files,
      sha256: String(row.sha256 ?? ""),
      config: config && typeof config === "object" && !Array.isArray(config) ? config : {},
      approvedUserServer: typeof row.approved_user_server === "string" ? row.approved_user_server : null,
      installedAt: String(row.installed_at ?? ""),
      updatedAt: String(row.updated_at ?? ""),
    }
  } catch {
    return null
  }
}

export class PluginRepository {
  private readonly customDb?: PluginDbClient
  private customSchemaReady = false

  constructor(db?: PluginDbClient) {
    this.customDb = db
  }

  private async db(): Promise<PluginDbClient> {
    if (this.customDb) {
      if (!this.customSchemaReady) {
        await ensurePluginTables(this.customDb)
        this.customSchemaReady = true
      }
      return this.customDb
    }
    return getDefaultDb()
  }

  async listStoredRecords(): Promise<PluginRecord[]> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT * FROM plugins ORDER BY installed_at ASC, id ASC",
      args: [],
    })
    const results: PluginRecord[] = []
    for (const row of rows) {
      const parsed = rowToPluginRecord(row)
      if (parsed) results.push(parsed)
    }
    return results
  }

  async getStoredRecord(id: string): Promise<PluginRecord | null> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT * FROM plugins WHERE id = ? LIMIT 1",
      args: [id],
    })
    return rows[0] ? rowToPluginRecord(rows[0]) : null
  }

  async upsertRecord(record: PluginRecord): Promise<void> {
    const db = await this.db()
    await db.execute({
      sql: `INSERT INTO plugins (
        id, source, enabled, needs_reconsent, manifest_json, files_json,
        sha256, config_json, approved_user_server, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        enabled = excluded.enabled,
        needs_reconsent = excluded.needs_reconsent,
        manifest_json = excluded.manifest_json,
        files_json = excluded.files_json,
        sha256 = excluded.sha256,
        config_json = excluded.config_json,
        approved_user_server = excluded.approved_user_server,
        updated_at = excluded.updated_at`,
      args: [
        record.id,
        record.source,
        record.enabled ? 1 : 0,
        record.needsReconsent ? 1 : 0,
        JSON.stringify(record.manifest),
        JSON.stringify(record.files),
        record.sha256,
        JSON.stringify(record.config),
        record.approvedUserServer,
        record.installedAt,
        record.updatedAt,
      ],
    })
  }

  async deletePlugin(id: string): Promise<void> {
    const db = await this.db()
    await db.execute({ sql: "DELETE FROM plugin_storage WHERE plugin_id = ?", args: [id] })
    await db.execute({ sql: "DELETE FROM plugin_secrets WHERE plugin_id = ?", args: [id] })
    await db.execute({ sql: "DELETE FROM plugins WHERE id = ?", args: [id] })
  }

  async deleteAllUploaded(): Promise<number> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT id FROM plugins WHERE source = 'uploaded'",
      args: [],
    })
    for (const row of rows) {
      await this.deletePlugin(String(row.id))
    }
    return rows.length
  }

  async getSafeMode(): Promise<boolean> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT value FROM plugin_state WHERE key = ? LIMIT 1",
      args: [PLUGIN_SAFE_MODE_SETTING_KEY],
    })
    return rows[0]?.value === "true"
  }

  async setSafeMode(enabled: boolean): Promise<void> {
    const db = await this.db()
    await db.execute({
      sql: `INSERT INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [PLUGIN_SAFE_MODE_SETTING_KEY, enabled ? "true" : "false", Date.now()],
    })
  }

  async hasActivePlugins(): Promise<boolean> {
    const db = await this.db()
    const state = localReaderCacheToken(db as never)
    if (state) {
      const cached = activePluginsCache.get(state.owner)
      if (cached && cached.token === state.token) return cached.active
    }
    const safeMode = await this.getSafeMode()
    const active = safeMode
      ? false
      : (
          await db.execute({
            sql: "SELECT 1 FROM plugins WHERE enabled = 1 AND needs_reconsent = 0 LIMIT 1",
            args: [],
          })
        ).rows.length > 0
    if (state && localReaderCacheToken(db as never)?.token === state.token) {
      activePluginsCache.set(state.owner, { token: state.token, active })
    }
    return active
  }

  // ── Isolated Per-Plugin Storage ──

  async getStorageValue(pluginId: string, key: string): Promise<unknown> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT value_json FROM plugin_storage WHERE plugin_id = ? AND storage_key = ? LIMIT 1",
      args: [pluginId, key],
    })
    if (!rows[0]) return null
    try {
      return JSON.parse(String(rows[0].value_json))
    } catch {
      return null
    }
  }

  async listStorageMap(pluginId: string): Promise<Record<string, unknown>> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT storage_key, value_json FROM plugin_storage WHERE plugin_id = ?",
      args: [pluginId],
    })
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      try {
        out[String(row.storage_key)] = JSON.parse(String(row.value_json))
      } catch {
        // Skip corrupted entry
      }
    }
    return out
  }

  async setStorageValue(pluginId: string, key: string, value: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const db = await this.db()
    const serialized = JSON.stringify(value)
    const byteSize = Buffer.byteLength(serialized, "utf8")
    if (byteSize > 64 * 1024) {
      return { ok: false, error: "Single storage value exceeds 64 KB." }
    }

    const { rows } = await db.execute({
      sql: "SELECT COUNT(*) AS cnt, COALESCE(SUM(byte_size), 0) AS total FROM plugin_storage WHERE plugin_id = ? AND storage_key <> ?",
      args: [pluginId, key],
    })
    const otherCount = Number(rows[0]?.cnt ?? 0)
    const otherBytes = Number(rows[0]?.total ?? 0)
    if (otherCount >= MAX_PLUGIN_STORAGE_KEYS) {
      return { ok: false, error: `Plugin storage is limited to ${MAX_PLUGIN_STORAGE_KEYS} keys.` }
    }
    if (otherBytes + byteSize > MAX_PLUGIN_STORAGE_BYTES) {
      return { ok: false, error: "Plugin storage exceeds the 256 KB quota." }
    }

    await db.execute({
      sql: `INSERT INTO plugin_storage (plugin_id, storage_key, value_json, byte_size, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(plugin_id, storage_key) DO UPDATE SET
              value_json = excluded.value_json,
              byte_size = excluded.byte_size,
              updated_at = excluded.updated_at`,
      args: [pluginId, key, serialized, byteSize, new Date().toISOString()],
    })
    return { ok: true }
  }

  async deleteStorageValue(pluginId: string, key: string): Promise<void> {
    const db = await this.db()
    await db.execute({
      sql: "DELETE FROM plugin_storage WHERE plugin_id = ? AND storage_key = ?",
      args: [pluginId, key],
    })
  }

  // ── Write-Only Secrets (NEVER returned as plaintext to clients) ──

  async listSecretStatuses(pluginId: string): Promise<PluginSecretStatus[]> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT secret_key, updated_at FROM plugin_secrets WHERE plugin_id = ? ORDER BY secret_key ASC",
      args: [pluginId],
    })
    return rows.map((row) => ({
      key: String(row.secret_key),
      configured: true,
      updatedAt: String(row.updated_at ?? ""),
    }))
  }

  async getSecretValueInternal(pluginId: string, secretKey: string): Promise<string | null> {
    const db = await this.db()
    const { rows } = await db.execute({
      sql: "SELECT secret_value FROM plugin_secrets WHERE plugin_id = ? AND secret_key = ? LIMIT 1",
      args: [pluginId, secretKey],
    })
    return typeof rows[0]?.secret_value === "string" ? rows[0].secret_value : null
  }

  async setSecretValue(pluginId: string, secretKey: string, value: string): Promise<void> {
    const db = await this.db()
    await db.execute({
      sql: `INSERT INTO plugin_secrets (plugin_id, secret_key, secret_value, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(plugin_id, secret_key) DO UPDATE SET
              secret_value = excluded.secret_value,
              updated_at = excluded.updated_at`,
      args: [pluginId, secretKey, value, new Date().toISOString()],
    })
  }

  async deleteSecretValue(pluginId: string, secretKey: string): Promise<void> {
    const db = await this.db()
    await db.execute({
      sql: "DELETE FROM plugin_secrets WHERE plugin_id = ? AND secret_key = ?",
      args: [pluginId, secretKey],
    })
  }
}
