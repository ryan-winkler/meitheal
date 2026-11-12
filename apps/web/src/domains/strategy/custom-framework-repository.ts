/**
 * Custom Framework Repository — CRUD for user-created framework definitions
 *
 * Built-in frameworks live in YAML files (content/frameworks/*.yaml).
 * User-created and imported frameworks are stored in the custom_frameworks
 * SQLite table as full FrameworkConfig JSON.
 *
 * @domain strategy
 * @kcs Framework extensibility — users can create, import, and delete custom frameworks
 */

import type { Client } from "@libsql/client"
import type { FrameworkConfig, FrameworkSource } from "@meitheal/domain-strategy"
import { getPersistenceClient } from "../tasks/persistence/store"

/**
 * Safely parse a JSON string, returning fallback on failure.
 */
function safeParseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toFrameworkConfig(row: Record<string, unknown>): FrameworkConfig {
  const parsed = safeParseJson<FrameworkConfig>(row.config_json, null as unknown as FrameworkConfig)
  if (parsed) return { ...parsed, source: (row.source as FrameworkSource) ?? "user" }

  // Fallback: minimal config from row columns
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    version: "1.0.0",
    archetype: "formula",
    source: (row.source as FrameworkSource) ?? "user",
    fields: [],
    badgeThresholds: [],
  }
}

/** Get all user-created/imported frameworks */
export async function getAllCustomFrameworks(): Promise<FrameworkConfig[]> {
  const client = getPersistenceClient()
  const result = await client.execute("SELECT * FROM custom_frameworks ORDER BY name ASC")
  return result.rows.map((row) => toFrameworkConfig(row as Record<string, unknown>))
}

/** Get a single custom framework by ID */
export async function getCustomFramework(id: string): Promise<FrameworkConfig | null> {
  const client = getPersistenceClient()
  const result = await client.execute({
    sql: "SELECT * FROM custom_frameworks WHERE id = ? LIMIT 1",
    args: [id],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return toFrameworkConfig(row)
}

/** Create a new custom framework */
export async function createCustomFramework(config: FrameworkConfig): Promise<FrameworkConfig> {
  const client = getPersistenceClient()
  const now = new Date().toISOString()

  await client.execute({
    sql: `INSERT INTO custom_frameworks (id, name, source, config_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      config.id,
      config.name,
      config.source ?? "user",
      JSON.stringify(config),
      now,
      now,
    ],
  })

  return config
}

/** Restore a portable definition without replacing unrelated custom frameworks. */
export async function restoreCustomFramework(client: Pick<Client, "execute">, config: FrameworkConfig): Promise<void> {
  const now = new Date().toISOString()
  await client.execute({
    sql: `INSERT INTO custom_frameworks (id, name, source, config_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE
          SET name = excluded.name, config_json = excluded.config_json, updated_at = excluded.updated_at`,
    args: [config.id, config.name, config.source, JSON.stringify(config), now, now],
  })
}

/** Update an existing custom framework */
export async function updateCustomFramework(
  id: string,
  config: FrameworkConfig,
): Promise<FrameworkConfig | null> {
  const client = getPersistenceClient()
  const now = new Date().toISOString()

  const result = await client.execute({
    sql: `UPDATE custom_frameworks SET name = ?, config_json = ?, updated_at = ? WHERE id = ?`,
    args: [config.name, JSON.stringify(config), now, id],
  })

  if ((result.rowsAffected ?? 0) === 0) return null
  return config
}

/** Delete a custom framework (built-ins cannot be deleted) */
export async function deleteCustomFramework(id: string): Promise<boolean> {
  const client = getPersistenceClient()
  const result = await client.execute({
    sql: "DELETE FROM custom_frameworks WHERE id = ?",
    args: [id],
  })
  return (result.rowsAffected ?? 0) > 0
}

/** Check if a framework ID is already taken (built-in or custom) */
export async function isFrameworkIdTaken(id: string): Promise<boolean> {
  const client = getPersistenceClient()
  const result = await client.execute({
    sql: "SELECT COUNT(*) as count FROM custom_frameworks WHERE id = ?",
    args: [id],
  })
  const count = Number((result.rows[0] as Record<string, unknown>)?.count ?? 0)
  return count > 0
}
