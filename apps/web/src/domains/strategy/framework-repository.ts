/**
 * Framework Repository — manages framework config overrides in SQLite
 *
 * YAML files in content/frameworks/ are immutable defaults.
 * This repository stores user overrides (weights, descriptions, help text)
 * and provides merged configs at runtime.
 */

import type { Client } from "@libsql/client"
import { getPersistenceClient } from "../tasks/persistence/store"
import type { FrameworkConfig, FrameworkOverrides, FrameworkOverrideRecord } from "@meitheal/domain-strategy"
import { mergeFrameworkConfig, parseFrameworkConfig, validateFrameworkOverrides } from "@meitheal/domain-strategy"

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

/**
 * Map a database row to a FrameworkOverrideRecord.
 */
function toOverrideRecord(row: Record<string, unknown>): FrameworkOverrideRecord {
  return {
    id: String(row.id),
    frameworkId: String(row.framework_id),
    overrides: safeParseJson<FrameworkOverrides>(row.overrides, {}),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  }
}

/** Get overrides for a specific framework */
export async function getOverrides(frameworkId: string, client: Pick<Client, "execute"> = getPersistenceClient()): Promise<FrameworkOverrideRecord | null> {
  const result = await client.execute({
    sql: "SELECT * FROM framework_configs WHERE framework_id = ? LIMIT 1",
    args: [frameworkId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return toOverrideRecord(row)
}

/** Save overrides for a framework (upsert) */
export async function saveOverrides(
  frameworkId: string,
  overrides: FrameworkOverrides,
  client: Pick<Client, "execute"> = getPersistenceClient(),
): Promise<FrameworkOverrideRecord> {
  const { getBuiltInFramework } = await import("./framework-catalog")
  const base = await getBuiltInFramework(frameworkId)
  if (!base) throw new TypeError(`Unknown built-in framework: ${frameworkId}`)
  return persistOverridePatch(client, frameworkId, overrides, base.fields.map(field => field.key))
}

/** Merge a validated patch using the exact stored JSON as its write guard. */
export async function persistOverridePatch(
  client: Pick<Client, "execute">,
  frameworkId: string,
  patch: FrameworkOverrides,
  fieldKeys: readonly string[],
): Promise<FrameworkOverrideRecord> {
  const errors = validateFrameworkOverrides(patch, fieldKeys)
  if (errors) throw new TypeError(errors.join(". "))

  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await client.execute({
      sql: "SELECT * FROM framework_configs WHERE framework_id = ? LIMIT 1",
      args: [frameworkId],
    })
    const row = result.rows[0] as Record<string, unknown> | undefined
    const existing = row ? toOverrideRecord(row) : null
    const previous = existing && !validateFrameworkOverrides(existing.overrides) ? existing.overrides : {}
    const overrides: FrameworkOverrides = {
      ...previous,
      ...patch,
      ...((previous.fields || patch.fields) ? { fields: {
        ...previous.fields,
        ...Object.fromEntries(Object.entries(patch.fields ?? {}).map(([key, field]) => [key, { ...previous.fields?.[key], ...field }])),
      } } : {}),
    }
    const now = new Date().toISOString()
    if (existing && row) {
      const saved = await client.execute({
        sql: "UPDATE framework_configs SET overrides = ?, updated_at = ? WHERE framework_id = ? AND overrides = ?",
        args: [JSON.stringify(overrides), now, frameworkId, String(row.overrides)],
      })
      if (saved.rowsAffected) return { ...existing, overrides, updatedAt: now }
    } else {
      const id = crypto.randomUUID()
      const saved = await client.execute({
        sql: "INSERT INTO framework_configs (id, framework_id, overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(framework_id) DO NOTHING",
        args: [id, frameworkId, JSON.stringify(overrides), now, now],
      })
      if (saved.rowsAffected) return { id, frameworkId, overrides, createdAt: now, updatedAt: now }
    }
    // Another writer won after our read. Merge again from its committed values.
  }
  throw new Error("Framework settings changed repeatedly while saving. Reload and retry.")
}

/** Reset a framework to YAML defaults by removing overrides */
export async function resetOverrides(frameworkId: string): Promise<boolean> {
  const client = getPersistenceClient()
  const result = await client.execute({
    sql: "DELETE FROM framework_configs WHERE framework_id = ?",
    args: [frameworkId],
  })
  return (result.rowsAffected ?? 0) > 0
}

/** Get all override records */
export async function getAllOverrides(): Promise<FrameworkOverrideRecord[]> {
  const client = getPersistenceClient()
  const result = await client.execute("SELECT * FROM framework_configs ORDER BY framework_id ASC")
  return result.rows.map((row) => toOverrideRecord(row as Record<string, unknown>))
}

/**
 * Load a framework config from YAML source, then merge with SQLite overrides.
 *
 * @param frameworkId - e.g. "rice", "heart", "ddd", "kcs"
 * @param yamlData - parsed YAML object (loaded by caller from content/frameworks/)
 */
export async function getFrameworkConfig(
  frameworkId: string,
  yamlData: Record<string, unknown>,
): Promise<FrameworkConfig> {
  const base = parseFrameworkConfig(frameworkId, yamlData)
  const overrideRecord = await getOverrides(frameworkId)
  return mergeFrameworkConfig(base, overrideRecord?.overrides ?? null)
}
