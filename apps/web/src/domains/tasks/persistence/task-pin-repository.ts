import type { Client } from "@libsql/client"
import { requireBoardScope, validateBoardScope, type BoardScope } from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { guardClientContinuity } from "./continuity-client"
import { scopedTaskRead } from "./board-work-query"
import { sql } from "./sql-fragment"
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
  ticket_key?: string
  status: string
  deferred_at: number | null
  pinned_at: number
}

export class TaskPinRepository {
  constructor(
    private readonly client: Client,
    private readonly scope: BoardScope
  ) {
    requireBoardScope(scope)
  }
  private owns(ownerId: string) {
    return (
      ["ha_user", "local_operator"].includes(this.scope.principal.kind) &&
      ownerId === this.scope.principal.id
    )
  }
  private reader() {
    return boardOperationClient(this.client, this.scope, { resource: "task", action: "read" })
  }
  async hasAny(ownerId: string): Promise<boolean> {
    if (!this.owns(ownerId)) return false
    const { rows } = await this.reader().execute(
      scopedTaskRead(
        this.scope,
        sql`SELECT 1 FROM task_pins AS pin JOIN scoped_tasks AS task ON task.id=pin.task_id WHERE pin.owner_id=${ownerId} LIMIT 1`
      )
    )
    return rows.length > 0
  }
  async list(
    ownerId: string,
    requestedPage: number
  ): Promise<{ page: number; total: number; items: TaskPinRow[] }> {
    if (!this.owns(ownerId)) return { page: 1, total: 0, items: [] }
    const tx = await this.reader().transaction("read")
    try {
      const {
        rows: [count]
      } = await tx.execute(
        scopedTaskRead(
          this.scope,
          sql`SELECT COUNT(*) AS total FROM task_pins AS pin JOIN scoped_tasks AS task ON task.id=pin.task_id WHERE pin.owner_id=${ownerId}`
        )
      )
      const total = Number(count?.total ?? 0),
        page = Math.min(requestedPage, Math.max(1, Math.ceil(total / TASK_PIN_PAGE_SIZE)))
      const { rows } = await tx.execute(
        scopedTaskRead(
          this.scope,
          sql`SELECT task.id,task.title,task.ticket_number,task.ticket_ref AS ticket_key,task.status,task.deferred_at,pin.pinned_at
        FROM task_pins AS pin JOIN scoped_tasks AS task ON task.id=pin.task_id WHERE pin.owner_id=${ownerId} ORDER BY pin.pinned_at DESC,pin.task_id LIMIT ${TASK_PIN_PAGE_SIZE} OFFSET ${(page - 1) * TASK_PIN_PAGE_SIZE}`
        )
      )
      await tx.commit()
      return { page, total, items: rows as unknown as TaskPinRow[] }
    } finally {
      tx.close()
    }
  }
  async get(ownerId: string, taskId: string): Promise<TaskPinState | null> {
    if (!this.owns(ownerId)) return null
    const {
      rows: [row]
    } = await this.reader().execute(
      scopedTaskRead(
        this.scope,
        sql`SELECT pin.pinned_at FROM scoped_tasks AS task LEFT JOIN task_pins AS pin ON pin.task_id=task.id AND pin.owner_id=${ownerId} WHERE task.id=${taskId}`
      )
    )
    if (!row) return null
    const at = row.pinned_at === null ? null : Number(row.pinned_at)
    return { id: taskId, pinned: at !== null, pinned_at: at }
  }
  /** A personal bookmark writes no task content and needs current task read, even for a Viewer. */
  async set(
    ownerId: string,
    taskId: string,
    desired: boolean,
    now = Date.now()
  ): Promise<TaskPinState | null> {
    if (!this.owns(ownerId)) return null
    const tx = await guardClientContinuity(this.client).transaction("write")
    try {
      if (!(await validateBoardScope(this.scope, tx, { resource: "task", action: "read" })).ok)
        return null
      const { rows } = await tx.execute(
        scopedTaskRead(this.scope, sql`SELECT id FROM scoped_tasks WHERE id=${taskId}`)
      )
      if (!rows.length) return null
      await tx.execute(
        desired
          ? sql`INSERT INTO task_pins(owner_id,task_id,pinned_at) VALUES (${ownerId},${taskId},${now}) ON CONFLICT(owner_id,task_id) DO NOTHING`
          : sql`DELETE FROM task_pins WHERE owner_id=${ownerId} AND task_id=${taskId}`
      )
      const {
        rows: [pin]
      } = await tx.execute(
        sql`SELECT pinned_at FROM task_pins WHERE owner_id=${ownerId} AND task_id=${taskId}`
      )
      if (!(await validateBoardScope(this.scope, tx, { resource: "task", action: "read" })).ok)
        return null
      await tx.commit()
      return { id: taskId, pinned: Boolean(pin), pinned_at: pin ? Number(pin.pinned_at) : null }
    } finally {
      tx.close()
    }
  }
}
