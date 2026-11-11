import type { Client } from "@libsql/client"

export const TASK_PIN_PAGE_SIZE = 25

export interface TaskPinState {
  id: string
  pinned: boolean
  pinned_at: number | null
}

export interface TaskPinRow {
  id: string
  title: string
  ticket_number: number | null
  status: string
  deferred_at: number | null
  pinned_at: number
}

export class TaskPinRepository {
  constructor(private readonly client: Client) {}

  async list(ownerId: string, requestedPage: number): Promise<{ page: number; total: number; items: TaskPinRow[] }> {
    const snapshot = await this.client.transaction("read")
    try {
      const { rows: [count] } = await snapshot.execute({
        sql: `SELECT COUNT(*) AS total FROM task_pins AS pin
              JOIN tasks AS task ON task.id = pin.task_id
              WHERE pin.owner_id = ?`,
        args: [ownerId],
      })
      const total = Number(count?.total ?? 0)
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / TASK_PIN_PAGE_SIZE)))
      const { rows } = await snapshot.execute({
        sql: `SELECT task.id, task.title, task.ticket_number, task.status, task.deferred_at, pin.pinned_at
              FROM task_pins AS pin JOIN tasks AS task ON task.id = pin.task_id
              WHERE pin.owner_id = ?
              ORDER BY pin.pinned_at DESC, pin.task_id ASC LIMIT ? OFFSET ?`,
        args: [ownerId, TASK_PIN_PAGE_SIZE, (page - 1) * TASK_PIN_PAGE_SIZE],
      })
      return { page, total, items: rows as unknown as TaskPinRow[] }
    } finally {
      snapshot.close()
    }
  }

  async get(ownerId: string, taskId: string): Promise<TaskPinState | null> {
    const { rows: [row] } = await this.client.execute({
      sql: `SELECT pin.pinned_at FROM tasks AS task
            LEFT JOIN task_pins AS pin ON pin.task_id = task.id AND pin.owner_id = ?
            WHERE task.id = ?`,
      args: [ownerId, taskId],
    })
    if (!row) return null
    const pinnedAt = row.pinned_at == null ? null : Number(row.pinned_at)
    return { id: taskId, pinned: pinnedAt !== null, pinned_at: pinnedAt }
  }

  async set(ownerId: string, taskId: string, desired: boolean, now = Date.now()): Promise<TaskPinState | null> {
    const [task, , pin] = await this.client.batch([
      { sql: "SELECT id FROM tasks WHERE id = ?", args: [taskId] },
      desired ? {
        sql: `INSERT INTO task_pins (owner_id, task_id, pinned_at)
              SELECT ?, id, ? FROM tasks WHERE id = ?
              ON CONFLICT(owner_id, task_id) DO NOTHING`,
        args: [ownerId, now, taskId],
      } : {
        sql: "DELETE FROM task_pins WHERE owner_id = ? AND task_id = ?",
        args: [ownerId, taskId],
      },
      { sql: "SELECT pinned_at FROM task_pins WHERE owner_id = ? AND task_id = ?", args: [ownerId, taskId] },
    ], "write")
    if (!task?.rows.length) return null
    const row = pin?.rows[0]
    return { id: taskId, pinned: Boolean(row), pinned_at: row ? Number(row.pinned_at) : null }
  }
}
