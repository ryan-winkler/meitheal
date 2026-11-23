import { requireBoardScope, type BoardScope } from "../board-scope"
import { boardOperationClient, canReadBoardAggregate, BoardOperationError, requireBoardWriterIntent } from "./board-operation-client"
import { storageBoardId, taskOwnedBy } from "./board-storage"
import { sql, sourceSql, joinSql } from "./sql-fragment"
/**
 * LaneRepository — domain service for kanban lane database queries.
 * @domain Task Management (Lanes context)
 *
 * Provides typed, parameterized query methods for lane CRUD operations.
 * Used by /api/lanes/* API routes.
 */
import type { Client } from "@libsql/client"
import type { InValue } from "@libsql/client"
import { isDoneStatus, STATUS } from "../../../lib/status-config"
import { taskTimestampMs } from "./task-timestamp"

export class LaneDeleteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message)
    this.name = "LaneDeleteError"
  }
}

export interface LaneRow {
  [key: string]: unknown
  id: unknown
  key: unknown
  label: unknown
  icon: unknown
  color?: unknown
  position: unknown
  wip_limit: unknown
  includes: unknown
  built_in: unknown
  created_at: unknown
  updated_at: unknown
}

export class LaneRepository {
  constructor(private readonly client: Client, private readonly scope: BoardScope) { requireBoardScope(scope) }
  private db(manage = false) { return boardOperationClient(this.client, this.scope, { resource: manage ? "board" : "task", action: manage ? "manage" : "read" }) }
  async findAll(): Promise<LaneRow[]> {
    const { rows } = await this.db().execute(sql`SELECT * FROM kanban_lanes WHERE board_id = ${this.scope.boardId} ORDER BY position, id`)
    return rows as unknown as LaneRow[]
  }
  async findById(id: string): Promise<LaneRow | null> {
    const { rows } = await this.db().execute(sql`SELECT * FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${id}`)
    return rows[0] as unknown as LaneRow ?? null
  }
  async findForDelete(id: string): Promise<{ id: unknown, built_in: unknown, key: unknown } | null> { return this.findById(id) }
  async keyExists(key: string): Promise<boolean> {
    return Boolean((await this.db().execute(sql`SELECT id FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND key = ${key}`)).rows.length)
  }
  async getMaxPosition(): Promise<number> {
    const { rows: [row] } = await this.db().execute(sql`SELECT MAX(position) AS maxp FROM kanban_lanes WHERE board_id = ${this.scope.boardId}`)
    return Number(row?.maxp ?? -1)
  }
  async create(data: { id: string; key: string; label: string; icon: string; color?: string | null; position: number; wipLimit: number; includes: string }): Promise<void> {
    const now = Date.now()
    const db = this.definitionWriter(data.includes)
    await db.execute(sql`INSERT INTO kanban_lanes (id, board_id, key, label, icon, color, position, wip_limit, includes, built_in, created_at, updated_at)
      VALUES (${data.id}, ${this.scope.boardId}, ${data.key}, ${data.label}, ${data.icon}, ${data.color ?? null}, ${data.position}, ${data.wipLimit}, ${data.includes}, 0, ${now}, ${now})`)
  }
  async update(id: string, fields: Record<string, InValue>): Promise<LaneRow | null> {
    const allowed = new Set(["label", "icon", "color", "position", "wip_limit", "includes"])
    if (Object.keys(fields).some(column => !allowed.has(column))) throw new Error("Unsupported lane field")
    const sets = Object.entries(fields).map(([column, value]) => sql`${sourceSql(column)} = ${value}`)
    if (!sets.length) return null
    sets.push(sql`updated_at = ${Date.now()}`)
    const db = fields.includes === undefined ? this.db(true) : this.definitionWriter(String(fields.includes))
    const { rows } = await db.execute(sql`UPDATE kanban_lanes SET ${joinSql(sets)} WHERE board_id = ${this.scope.boardId} AND id = ${id} RETURNING *`)
    return rows[0] as unknown as LaneRow ?? null
  }
  async reorder(orderedIds: string[]): Promise<boolean> {
    if (!orderedIds.length || new Set(orderedIds).size !== orderedIds.length) return false
    const tx = await this.db(true).transaction("write")
    try {
      if (!await canReadBoardAggregate(tx, this.scope)) throw new BoardOperationError("unavailable")
      const { rows } = await tx.execute(sql`SELECT id FROM kanban_lanes WHERE board_id = ${this.scope.boardId} ORDER BY position, id`)
      const validIds = new Set(rows.map(r => String(r.id)))
      if (!orderedIds.every(id => validIds.has(id))) return false
      const rest = rows.map(r => String(r.id)).filter(id => !orderedIds.includes(id))
      const finalOrder = [...orderedIds, ...rest]
      const now = Date.now()
      for (let idx = 0; idx < finalOrder.length; idx++) {
        await tx.execute(sql`UPDATE kanban_lanes SET position = ${idx}, updated_at = ${now} WHERE board_id = ${this.scope.boardId} AND id = ${finalOrder[idx]!}`)
      }
      await tx.commit()
      return true
    } finally { tx.close() }
  }
  private definitionWriter(includes: string) {
    let statuses: unknown
    try { statuses = JSON.parse(includes) } catch { throw new Error("Choose valid lane statuses") }
    if (!Array.isArray(statuses) || !statuses.length || !statuses.every(value => typeof value === "string" && /^[a-z0-9_]{1,50}$/.test(value))) throw new Error("Choose valid lane statuses")
    // Changing status meaning is an authority-bearing workflow change.
    let db = boardOperationClient(this.db(true), this.scope, { resource: "task", action: "edit" }, [], async reader => {
      if (!await canReadBoardAggregate(reader, this.scope)) throw new BoardOperationError("unavailable")
      return []
    })
    db = boardOperationClient(db, this.scope, { resource: "task", action: "complete" })
    return boardOperationClient(db, this.scope, { resource: "task", action: "reopen" })
  }
  async delete(id: string, laneKey: string, targetLaneId?: string): Promise<{ replacementId: string; replacementKey: string } | null> {
    let db = this.db(true)
    db = boardOperationClient(db, this.scope, { resource: "task", action: "edit" })
    db = boardOperationClient(db, this.scope, { resource: "task", action: "reopen" })
    const tx = await db.transaction("write")
    try {
      if (!await canReadBoardAggregate(tx, this.scope)) throw new BoardOperationError("unavailable")
      const { rows: [lane] } = await tx.execute(sql`SELECT id, includes FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${id} AND key = ${laneKey} AND built_in = 0`)
      if (!lane) return null
      const { rows: [intakeRef] } = await tx.execute(sql`SELECT 1 FROM board_intakes WHERE board_id = ${this.scope.boardId} AND lane_id = ${id} LIMIT 1`)
      if (intakeRef) {
        throw new LaneDeleteError("Remove or retarget board intakes using this lane before deleting it", 409)
      }
      const { rows: [replacement] } = targetLaneId
        ? await tx.execute(sql`SELECT id, key, includes FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${targetLaneId} AND id <> ${id} LIMIT 1`)
        : await tx.execute(sql`SELECT id, key, includes FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id <> ${id} AND EXISTS (SELECT 1 FROM json_each(includes) WHERE value = ${STATUS.PENDING}) ORDER BY position, id LIMIT 1`)
      if (!replacement) {
        throw new LaneDeleteError(
          targetLaneId ? "Choose a valid destination lane on this board" : "Keep a destination lane for existing tasks",
          targetLaneId ? 400 : 409,
        )
      }
      let targetStatus: string = STATUS.PENDING
      try {
        const inc = JSON.parse(String(replacement.includes ?? "[]"))
        if (Array.isArray(inc) && typeof inc[0] === "string" && inc[0]) targetStatus = inc[0]
      } catch { /* fallback to pending */ }
      if (isDoneStatus(targetStatus)) {
        // Reassigning tasks into a done lane completes work and must verify task:complete authority inside tx.
        await requireBoardWriterIntent(tx, this.scope, { resource: "task", action: "complete" })
      }
      let oldStatuses = [laneKey]
      try {
        const inc = JSON.parse(String(lane.includes ?? "[]"))
        if (Array.isArray(inc) && inc.length) oldStatuses = inc.filter((s): s is string => typeof s === "string")
      } catch { /* fallback to laneKey */ }
      await tx.execute(sql`UPDATE tasks SET status = ${targetStatus}, board_column_id = ${storageBoardId(this.scope) === null ? null : String(replacement.id)}, updated_at = MIN(9007199254740991, MAX(${sourceSql(taskTimestampMs("tasks.updated_at"))} + 1, ${Date.now()}))
        WHERE ${taskOwnedBy(this.scope)} AND (board_column_id = ${id} OR (board_column_id IS NULL AND status IN (${joinSql(oldStatuses.map(s => sql`${s}`))})))`)
      await tx.execute(sql`DELETE FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${id} AND built_in = 0`)
      await tx.commit()
      return { replacementId: String(replacement.id), replacementKey: String(replacement.key) }
    } finally { tx.close() }
  }
}
