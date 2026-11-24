/** Global assignee identity registry. Administrative HTTP callers verify current Settings authority.
 * Board preferences and work effects belong to the scope-required UserRepository. */
import type { Client } from "@libsql/client"
import { guardClientContinuity } from "./continuity-client"

export type CustomUserKind = "human" | "agent"

export function customUserKind(value: unknown): CustomUserKind {
  return value === "agent" ? "agent" : "human"
}

export class IdentityRepository {
  protected readonly client: Client
  constructor(client: Client) {
    this.client = guardClientContinuity(client)
  }

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
      args: [name]
    })
    return result.rows.length > 0
  }

  /** Create a new custom user */
  async createCustomUser(
    id: string,
    name: string,
    color: string,
    kind: CustomUserKind = "human"
  ): Promise<number> {
    const now = Date.now()
    await this.client.execute({
      sql: "INSERT INTO custom_users (id, name, color, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      args: [id, name, color, kind, now, now]
    })
    return now
  }

  /** Check if a custom user exists */
  async customUserExists(id: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM custom_users WHERE id = ? LIMIT 1",
      args: [id]
    })
    return result.rows.length > 0
  }

  /** Read one custom user, or null when the ID is unknown */
  async getCustomUser(
    id: string
  ): Promise<{ id: string; name: string; kind: CustomUserKind } | null> {
    const result = await this.client.execute({
      sql: "SELECT id, name, kind FROM custom_users WHERE id = ? LIMIT 1",
      args: [id]
    })
    const row = result.rows[0] as Record<string, unknown> | undefined
    return row
      ? { id: String(row.id), name: String(row.name), kind: customUserKind(row.kind) }
      : null
  }

  /** Remove registry identity without mutating work in Boards the operator may not manage. */
  async deleteCustomUser(id: string): Promise<void> {
    const tx = await this.client.transaction("write")
    try {
      await tx.execute({ sql: "DELETE FROM custom_users WHERE id=?", args: [id] })
      const { rows } = await tx.execute(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='agent_tokens'"
      )
      if (rows.length)
        await tx.execute({
          sql: "UPDATE agent_tokens SET assignee_id=NULL WHERE assignee_id=?",
          args: [id]
        })
      await tx.commit()
    } finally {
      tx.close()
    }
  }
}
