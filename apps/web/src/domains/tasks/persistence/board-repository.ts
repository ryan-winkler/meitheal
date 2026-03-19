/**
 * BoardRepository — domain service for board-related database queries.
 * @domain Task Management (Boards context)
 *
 * Provides typed, parameterized query methods for board CRUD operations.
 * Used by /api/boards/* API routes.
 */
import type { Client } from "@libsql/client"
import type { InValue } from "@libsql/client"

export interface BoardRow {
  [key: string]: unknown
  id: unknown
  title: unknown
  icon: unknown
  color: unknown
  position: unknown
  /** WIP limit per status column — 0 = unlimited */
  wip_limit: unknown
  created_at: unknown
  updated_at: unknown
}

export class BoardRepository {
  constructor(private client: Client) {}

  /** List all boards ordered by position */
  async findAll(): Promise<BoardRow[]> {
    const result = await this.client.execute(
      "SELECT id, title, icon, color, position, wip_limit, created_at, updated_at FROM boards ORDER BY position ASC, created_at ASC"
    )
    return result.rows as unknown as BoardRow[]
  }

  /** Count total boards (for abuse limits) */
  async count(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as c FROM boards")
    return Number(result.rows[0]?.c || 0)
  }

  /** Get the next available position */
  async getNextPosition(): Promise<number> {
    const result = await this.client.execute("SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM boards")
    return Number(result.rows[0]?.next_pos ?? 0)
  }

  /** Insert a new board */
  async create(data: {
    id: string; title: string; icon: string; color: string; position: number
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: "INSERT INTO boards (id, title, icon, color, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      args: [data.id, data.title, data.icon, data.color, data.position, now, now],
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
      sql: `UPDATE boards SET ${updates.join(", ")} WHERE id = ?`,
      args,
    })
  }

  /** Delete a board and reassign its tasks to 'default' */
  async delete(id: string): Promise<void> {
    await this.client.execute({
      sql: "UPDATE tasks SET board_id = 'default' WHERE board_id = ?",
      args: [id],
    })
    await this.client.execute({
      sql: "DELETE FROM boards WHERE id = ?",
      args: [id],
    })
  }
}
