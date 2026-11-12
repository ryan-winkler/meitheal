/**
 * SettingsRepository — domain service for settings, reminders, and saved filters.
 * @domain Task Management (Settings context)
 *
 * Provides typed, parameterized query methods for:
 * - Settings key-value store (general preferences)
 * - Reminders (tasks with pending reminder_at)
 * - Saved filters (smart views / user-defined filter combos)
 */
import type { Client, InStatement, InValue, ResultSet } from "@libsql/client"
import { runWriteTransaction } from "../../../../scripts/database-client.mjs"
import { STATUS } from "../../../lib/status-config"

export const AI_HANDOFF_SETTING_KEYS = ["ai-provider", "ai-custom-url", "ai-custom-url-approved"]

function readSettingsStatement(keys: string[]): InStatement {
  const placeholders = keys.map(() => "?").join(", ")
  return { sql: `SELECT key, value FROM settings WHERE key IN (${placeholders})`, args: keys }
}

function readSettingsRows(rows: ResultSet["rows"]): Record<string, unknown> {
  const settings: Record<string, unknown> = Object.create(null)
  for (const row of rows) {
    const key = String(row.key)
    try { settings[key] = JSON.parse(String(row.value)) }
    catch { settings[key] = String(row.value) }
  }
  return settings
}

function upsertSettingStatement(key: string, value: string, now: number): InStatement {
  return {
    sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, now],
  }
}

interface AiHandoffSettings {
  provider: string | null
  url: string | null
  shared: boolean
}

/** Compare the form's saved values and commit the provider, destination and approval together. */
export function saveAiHandoffSettings(
  client: Client,
  expected: AiHandoffSettings,
  next: { provider: string; destination?: { url: string; shared: boolean } },
): Promise<boolean> {
  return runWriteTransaction(client, function* () {
    const [result] = yield [readSettingsStatement(AI_HANDOFF_SETTING_KEYS)]
    const current = readSettingsRows(result!.rows)
    const provider = typeof current["ai-provider"] === "string" ? current["ai-provider"] : null
    const url = typeof current["ai-custom-url"] === "string" ? current["ai-custom-url"] : null
    const shared = Boolean(url) && current["ai-custom-url-approved"] === url
    if (provider !== expected.provider || url !== expected.url || shared !== expected.shared) return false
    const now = Date.now()
    const statements = [upsertSettingStatement("ai-provider", JSON.stringify(next.provider), now)]
    if (next.destination) {
      statements.push(
        upsertSettingStatement("ai-custom-url", JSON.stringify(next.destination.url), now),
        upsertSettingStatement("ai-custom-url-approved", JSON.stringify(next.destination.shared ? next.destination.url : null), now),
      )
    }
    yield statements
    return true
  })
}

/** Legacy URL writes revoke sharing in the same transaction whenever the value changes. */
export function saveLegacyAiHandoffUrl(client: Client, value: unknown): Promise<void> {
  return runWriteTransaction(client, function* () {
    const key = "ai-custom-url"
    const [result] = yield [readSettingsStatement([key])]
    const current = readSettingsRows(result!.rows)[key]
    const statements = [upsertSettingStatement(key, JSON.stringify(value), Date.now())]
    if (current !== value) statements.push({ sql: "DELETE FROM settings WHERE key = ?", args: ["ai-custom-url-approved"] })
    yield statements
  })
}

export class SettingsRepository {
  constructor(private client: Pick<Client, "execute" | "batch">) {}

  // ── Settings KV Store ──────────────────────────────────────────────

  /** Ensure settings table exists */
  async ensureSettingsTable(): Promise<void> {
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`
    )
  }

  /** Get a single setting by key */
  async getByKey(key: string): Promise<{ key: string; value: unknown } | null> {
    const result = await this.client.execute({
      sql: "SELECT key, value FROM settings WHERE key = ?",
      args: [key] as InValue[],
    })
    const row = result.rows[0] as Record<string, unknown> | undefined
    if (!row) return null
    return { key: String(row.key), value: JSON.parse(String(row.value)) }
  }

  /** Get all settings (returns raw rows for caller to handle redaction) */
  async getAll(): Promise<Array<Record<string, unknown>>> {
    const result = await this.client.execute("SELECT key, value FROM settings ORDER BY key")
    return result.rows as Array<Record<string, unknown>>
  }

  /** Upsert a setting (insert or update on conflict) */
  async upsert(key: string, value: string): Promise<void> {
    await this.client.execute(upsertSettingStatement(key, value, Date.now()))
  }

  /** Delete all settings (factory reset) */
  async deleteAll(): Promise<void> {
    await this.client.execute("DELETE FROM settings")
  }

  /** Get multiple settings by keys (batch read) */
  async getByKeys(keys: string[]): Promise<Record<string, unknown>> {
    if (keys.length === 0) return {}
    return readSettingsRows((await this.client.execute(readSettingsStatement(keys))).rows)
  }

  /** Batch import settings atomically (upsert many at once) */
  async importBatch(entries: Array<{ key: string; value: string }>): Promise<number> {
    if (entries.length === 0) return 0
    const now = Date.now()
    const statements = entries.map(({ key, value }) => upsertSettingStatement(key, value, now))
    await this.client.batch(statements)
    return entries.length
  }

  /** Delete settings by keys (batch delete) */
  async deleteByKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return
    const statements = keys.map((key) => ({
      sql: "DELETE FROM settings WHERE key = ?",
      args: [key] as InValue[],
    }))
    await this.client.batch(statements)
  }

  // ── Reminders ──────────────────────────────────────────────────────

  /** Get tasks with pending reminders (reminder_at <= now, not completed) */
  async getPendingReminders(): Promise<{ reminders: unknown[]; checked_at: string }> {
    const now = new Date().toISOString()
    const result = await this.client.execute({
      sql: `SELECT id, title, due_date, reminder_at, priority, status
            FROM tasks
            WHERE reminder_at IS NOT NULL
              AND reminder_at <= ?
              AND status NOT IN (?)
            ORDER BY reminder_at ASC
            LIMIT 50`,
      args: [now, STATUS.COMPLETE],
    })
    return { reminders: result.rows, checked_at: now }
  }

  /** Snooze a reminder to a future time */
  async snoozeReminder(taskId: string, snoozeTime: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE tasks SET reminder_at = ?, updated_at = ? WHERE id = ?",
      args: [snoozeTime, Date.now(), taskId],
    })
  }

  /** Dismiss a reminder (clear reminder_at) */
  async dismissReminder(taskId: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE tasks SET reminder_at = NULL, updated_at = ? WHERE id = ?",
      args: [Date.now(), taskId],
    })
  }

  // ── Saved Filters ──────────────────────────────────────────────────

  /** List all saved filters ordered by position */
  async listFilters() {
    const result = await this.client.execute(
      "SELECT * FROM saved_filters ORDER BY position ASC, created_at ASC"
    )
    return result.rows
  }

  /** Get next available filter position */
  async getNextFilterPosition(): Promise<number> {
    const result = await this.client.execute(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM saved_filters"
    )
    return Number((result.rows[0] as Record<string, unknown>)?.next_pos ?? 0)
  }

  /** Create a saved filter */
  async createFilter(data: {
    id: string; name: string; queryJson: string; icon: string; position: number
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: `INSERT INTO saved_filters (id, name, query_json, icon, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [data.id, data.name, data.queryJson, data.icon, data.position, now, now],
    })
  }

  /** Delete a saved filter by ID */
  async deleteFilter(id: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM saved_filters WHERE id = ?",
      args: [id],
    })
  }
}
