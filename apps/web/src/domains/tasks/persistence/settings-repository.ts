/**
 * SettingsRepository — domain service for settings, reminders, and saved filters.
 * @domain Task Management (Settings context)
 *
 * Provides typed, parameterized query methods for:
 * - Settings key-value store (general preferences)
 * - Reminders (tasks with pending reminder_at)
 * - Saved filters (smart views / user-defined filter combos)
 */
import type { Client } from "@libsql/client"
import type { InValue } from "@libsql/client"
import { STATUS } from "../../../lib/status-config"

export class SettingsRepository {
  constructor(private client: Client) {}

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
    const now = Date.now()
    await this.client.execute({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, value, now] as InValue[],
    })
  }

  /** Delete all settings (factory reset) */
  async deleteAll(): Promise<void> {
    await this.client.execute("DELETE FROM settings")
  }

  /** Get multiple settings by keys (batch read) */
  async getByKeys(keys: string[]): Promise<Record<string, unknown>> {
    if (keys.length === 0) return {}
    const placeholders = keys.map(() => "?").join(", ")
    const result = await this.client.execute({
      sql: `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
      args: keys as InValue[],
    })
    const settings: Record<string, unknown> = {}
    for (const row of result.rows) {
      const r = row as Record<string, unknown>
      const key = String(r.key)
      try {
        settings[key] = JSON.parse(String(r.value))
      } catch {
        settings[key] = String(r.value)
      }
    }
    return settings
  }

  /** Batch import settings atomically (upsert many at once) */
  async importBatch(entries: Array<{ key: string; value: string }>): Promise<number> {
    if (entries.length === 0) return 0
    const now = Date.now()
    const statements = entries.map(({ key, value }) => ({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [key, value, now] as InValue[],
    }))
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
