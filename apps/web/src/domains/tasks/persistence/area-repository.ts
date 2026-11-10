/**
 * AreaRepository — domain service for area-related database queries.
 * @domain Task Management (Areas context)
 *
 * Provides typed, parameterized query methods for area CRUD operations.
 * Used by /api/areas/* API routes.
 */
import type { Client } from "@libsql/client"
import type { InValue } from "@libsql/client"

export interface AreaRow {
  [key: string]: unknown
  id: string
  name: string
  icon: string
  color: string
  position: number
  /** WIP limit per status column — 0 = unlimited */
  wip_limit: number
  /** Weekly hours cap — 0 = unlimited */
  energy_budget: number
  /** Days between reviews — 0 = no scheduled review */
  review_cadence: number
  /** Last reviewed timestamp (epoch ms) */
  last_reviewed_at: number | null
  created_at: number
  updated_at: number
}

export class AreaRepository {
  constructor(private client: Client) {}

  /** List all areas ordered by position */
  async findAll(): Promise<AreaRow[]> {
    const result = await this.client.execute(
      "SELECT id, name, icon, color, position, created_at, updated_at FROM areas ORDER BY position ASC, created_at ASC"
    )
    return result.rows as unknown as AreaRow[]
  }

  /** Count total areas (for abuse limits) */
  async count(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as c FROM areas")
    return Number(result.rows[0]?.c || 0)
  }

  /** Get the next available position */
  async getNextPosition(): Promise<number> {
    const result = await this.client.execute("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM areas")
    return Number(result.rows[0]?.next_pos ?? 0)
  }

  /** Insert a new area */
  async create(data: {
    id: string; name: string; icon: string; color: string; position: number
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: "INSERT INTO areas (id, name, icon, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [data.id, data.name, data.icon, data.color, data.position, now, now],
    })
  }

  /** Dynamic update — only SET the columns present in `fields` */
  async update(id: string, fields: Record<string, InValue>): Promise<void> {
    const updates: string[] = []
    const args: InValue[] = []

    for (const [col, val] of Object.entries(fields)) {
      updates.push(`${col} = ?`)
      args.push(val)
    }
    if (updates.length === 0) return

    updates.push("updated_at = ?")
    args.push(Date.now())
    args.push(id)

    await this.client.execute({
      sql: `UPDATE areas SET ${updates.join(", ")} WHERE id = ?`,
      args,
    })
  }

  /** Delete an area and reassign its tasks to 'default' */
  async delete(id: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE tasks SET area_id = 'default' WHERE area_id = ?",
      args: [id],
    })
    await this.client.execute({
      sql: "DELETE FROM areas WHERE id = ?",
      args: [id],
    })
  }
}
