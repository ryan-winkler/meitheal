/**
 * LaneRepository — domain service for kanban lane database queries.
 * @domain Task Management (Lanes context)
 *
 * Provides typed, parameterized query methods for lane CRUD operations.
 * Used by /api/lanes/* API routes.
 */
import type { Client } from "@libsql/client"
import type { InValue } from "@libsql/client"
import { STATUS } from "../../../lib/status-config"

export interface LaneRow {
  [key: string]: unknown
  id: unknown
  key: unknown
  label: unknown
  icon: unknown
  position: unknown
  wip_limit: unknown
  includes: unknown
  built_in: unknown
  created_at: unknown
  updated_at: unknown
}

export class LaneRepository {
  constructor(private client: Client) {}

  /** List all lanes ordered by position */
  async findAll(): Promise<LaneRow[]> {
    const result = await this.client.execute(
      "SELECT id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at FROM kanban_lanes ORDER BY position ASC"
    )
    return result.rows as unknown as LaneRow[]
  }

  /** Find a lane by ID */
  async findById(id: string): Promise<LaneRow | null> {
    const result = await this.client.execute({
      sql: "SELECT id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at FROM kanban_lanes WHERE id = ? LIMIT 1",
      args: [id],
    })
    return (result.rows[0] as unknown as LaneRow) ?? null
  }

  /** Find a lane by ID with only id, built_in, key fields (for delete validation) */
  async findForDelete(id: string): Promise<{ id: unknown; built_in: unknown; key: unknown } | null> {
    const result = await this.client.execute({
      sql: "SELECT id, built_in, key FROM kanban_lanes WHERE id = ? LIMIT 1",
      args: [id],
    })
    return (result.rows[0] as unknown as { id: unknown; built_in: unknown; key: unknown }) ?? null
  }

  /** Check if a lane key already exists */
  async keyExists(key: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM kanban_lanes WHERE key = ?",
      args: [key],
    })
    return result.rows.length > 0
  }

  /** Get the next available position */
  async getMaxPosition(): Promise<number> {
    const result = await this.client.execute("SELECT MAX(position) as maxp FROM kanban_lanes")
    return Number(result.rows[0]?.maxp ?? -1)
  }

  /** Insert a new lane */
  async create(data: {
    id: string; key: string; label: string; icon: string;
    position: number; wipLimit: number; includes: string
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: "INSERT INTO kanban_lanes (id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
      args: [data.id, data.key, data.label, data.icon, data.position, data.wipLimit, data.includes, now, now] as InValue[],
    })
  }

  /** Dynamic update — only SET the columns present in `fields` */
  async update(id: string, fields: Record<string, InValue>): Promise<LaneRow | null> {
    const updates: string[] = []
    const args: InValue[] = []

    for (const [col, val] of Object.entries(fields)) {
      updates.push(`${col} = ?`)
      args.push(val)
    }
    if (updates.length === 0) return null

    updates.push("updated_at = ?")
    args.push(Date.now())
    args.push(id)

    await this.client.execute({
      sql: `UPDATE kanban_lanes SET ${updates.join(", ")} WHERE id = ?`,
      args,
    })

    return this.findById(id)
  }

  /** Delete a lane and reassign tasks with its status back to pending */
  async delete(id: string, laneKey: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE tasks SET status = ?, updated_at = ? WHERE status = ?",
      args: [STATUS.PENDING, Date.now(), laneKey],
    })
    await this.client.execute({
      sql: "DELETE FROM kanban_lanes WHERE id = ?",
      args: [id],
    })
  }
}
