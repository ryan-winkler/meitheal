/**
 * UserRepository — domain service for user-related database queries.
 * @domain Task Management (Users context)
 *
 * Provides typed, parameterized query methods for:
 * - Custom user CRUD (non-HA users)
 * - Default assignee setting
 * - Custom user listing for merge with HA users
 */
import type { Client } from "@libsql/client"

export type CustomUserKind = "human" | "agent"

export function customUserKind(value: unknown): CustomUserKind {
  return value === "agent" ? "agent" : "human"
}

export class UserRepository {
  constructor(private client: Client) {}

  // ── Custom Users ───────────────────────────────────────────────────

  /** List all custom users ordered by name */
  async listCustomUsers() {
    const result = await this.client.execute(
      "SELECT id, name, color, kind, created_at, updated_at FROM custom_users ORDER BY name ASC"
    )
    return result.rows
  }

  /** List custom users (minimal: id, name, color, kind) for merge with HA users */
  async listCustomUsersMinimal() {
    const result = await this.client.execute(
      "SELECT id, name, color, kind FROM custom_users ORDER BY name ASC"
    )
    return result.rows
  }

  /** Count total custom users (for abuse limits) */
  async countCustomUsers(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as cnt FROM custom_users")
    return Number((result.rows[0] as Record<string, unknown>).cnt)
  }

  /** Check if a custom user name already exists (case-insensitive) */
  async customUserNameExists(name: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM custom_users WHERE LOWER(name) = LOWER(?) LIMIT 1",
      args: [name],
    })
    return result.rows.length > 0
  }

  /** Create a new custom user */
  async createCustomUser(id: string, name: string, color: string, kind: CustomUserKind = "human"): Promise<number> {
    const now = Date.now()
    await this.client.execute({
      sql: "INSERT INTO custom_users (id, name, color, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [id, name, color, kind, now, now],
    })
    return now
  }

  /** Check if a custom user exists */
  async customUserExists(id: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM custom_users WHERE id = ? LIMIT 1",
      args: [id],
    })
    return result.rows.length > 0
  }

  /** Read one custom user, or null when the ID is unknown */
  async getCustomUser(id: string): Promise<{ id: string; name: string; kind: CustomUserKind } | null> {
    const result = await this.client.execute({
      sql: "SELECT id, name, kind FROM custom_users WHERE id = ? LIMIT 1",
      args: [id],
    })
    const row = result.rows[0] as Record<string, unknown> | undefined
    return row ? { id: String(row.id), name: String(row.name), kind: customUserKind(row.kind) } : null
  }

  /** Delete a custom user, unassign their tasks and detach any agent tokens */
  async deleteCustomUser(id: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM custom_users WHERE id = ?", args: [id] })
    // The token table is created on first use, so it may not exist yet.
    await this.client.execute({ sql: "UPDATE agent_tokens SET assignee_id = NULL WHERE assignee_id = ?", args: [id] })
      .catch(() => {})
    await this.client.execute({
      sql: "UPDATE tasks SET assigned_to = NULL, updated_at = ? WHERE assigned_to = ?",
      args: [Date.now(), id],
    })
  }

  // ── Default Assignee ───────────────────────────────────────────────

  /** Get current default assignee */
  async getDefaultAssigneeSetting(): Promise<string | null> {
    const result = await this.client.execute(
      "SELECT value FROM app_settings WHERE key = 'default_assignee' LIMIT 1"
    )
    return result.rows.length > 0
      ? String((result.rows[0] as Record<string, unknown>).value)
      : null
  }

  /** Set default assignee (upsert) */
  async setDefaultAssignee(userId: string): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO app_settings (key, value, updated_at) VALUES ('default_assignee', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [userId, Date.now()],
    })
  }

  /** Clear default assignee */
  async clearDefaultAssignee(): Promise<void> {
    await this.client.execute("DELETE FROM app_settings WHERE key = 'default_assignee'")
  }
}
