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

export class UserRepository {
  constructor(private client: Client) {}

  // ── Custom Users ───────────────────────────────────────────────────

  /** List all custom users ordered by name */
  async listCustomUsers() {
    const result = await this.client.execute(
      "SELECT id, name, color, created_at, updated_at FROM custom_users ORDER BY name ASC"
    )
    return result.rows
  }

  /** List custom users (minimal: id, name, color) for merge with HA users */
  async listCustomUsersMinimal() {
    const result = await this.client.execute(
      "SELECT id, name, color FROM custom_users ORDER BY name ASC"
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
  async createCustomUser(id: string, name: string, color: string): Promise<number> {
    const now = Date.now()
    await this.client.execute({
      sql: "INSERT INTO custom_users (id, name, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [id, name, color, now, now],
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

  /** Delete a custom user and unassign their tasks */
  async deleteCustomUser(id: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM custom_users WHERE id = ?", args: [id] })
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
