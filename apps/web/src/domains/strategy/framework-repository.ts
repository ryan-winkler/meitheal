/**
 * Framework Repository — manages framework config overrides in SQLite
 *
 * YAML files in content/frameworks/ are immutable defaults.
 * This repository stores user overrides (weights, descriptions, help text)
 * and provides merged configs at runtime.
 */

import { getEntry } from "astro:content"
import type { FrameworkConfig, FrameworkOverrides, FrameworkOverrideRecord } from "@meitheal/domain-strategy"
import { mergeFrameworkConfig, parseFrameworkConfig, validateFrameworkOverrides } from "@meitheal/domain-strategy"
import { getPersistenceClient } from "../tasks/persistence/store"

/** Shared default lookup keeps override validation aligned with the actual YAML fields. */
export async function loadBuiltInFramework(id: string): Promise<FrameworkConfig | null> {
  if (!/^[a-z0-9-]+$/.test(id)) return null
  const entry = await getEntry("frameworks", id)
  return entry ? parseFrameworkConfig(id, entry.data) : null
}

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
export async function getOverrides(frameworkId: string): Promise<FrameworkOverrideRecord | null> {
  const client = getPersistenceClient()
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
): Promise<FrameworkOverrideRecord> {
  const base = await loadBuiltInFramework(frameworkId)
  if (!base) throw new TypeError(`Unknown built-in framework: ${frameworkId}`)
  const errors = validateFrameworkOverrides(overrides, base.fields.map((field) => field.key))
  if (errors) throw new TypeError(errors.join(". "))
  const client = getPersistenceClient()
  const now = new Date().toISOString()

  const existing = await getOverrides(frameworkId)
  const previous = existing && !validateFrameworkOverrides(existing.overrides) ? existing.overrides : {}
  // A slider changes one field; preserve all other field and config overrides.
  overrides = {
    ...previous,
    ...overrides,
    ...((previous.fields || overrides.fields) ? { fields: {
      ...previous.fields,
      ...Object.fromEntries(Object.entries(overrides.fields ?? {}).map(([key, field]) => [key, { ...previous.fields?.[key], ...field }])),
    } } : {}),
  }
  if (existing) {
    await client.execute({
      sql: "UPDATE framework_configs SET overrides = ?, updated_at = ? WHERE framework_id = ?",
      args: [JSON.stringify(overrides), now, frameworkId],
    })
    return { ...existing, overrides, updatedAt: now }
  }

  const id = crypto.randomUUID()
  await client.execute({
    sql: "INSERT INTO framework_configs (id, framework_id, overrides, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    args: [id, frameworkId, JSON.stringify(overrides), now, now],
  })
  return { id, frameworkId, overrides, createdAt: now, updatedAt: now }
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
