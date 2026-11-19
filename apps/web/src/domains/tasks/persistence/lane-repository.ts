import { requireBoardScope, type BoardScope } from "../board-scope"
import { boardOperationClient, canReadBoardAggregate, BoardOperationError } from "./board-operation-client"
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
  async create(data: { id: string; key: string; label: string; icon: string; position: number; wipLimit: number; includes: string }): Promise<void> {
    const now = Date.now()
    const db = this.definitionWriter(data.includes)
    await db.execute(sql`INSERT INTO kanban_lanes (id, board_id, key, label, icon, position, wip_limit, includes, built_in, created_at, updated_at)
      VALUES (${data.id}, ${this.scope.boardId}, ${data.key}, ${data.label}, ${data.icon}, ${data.position}, ${data.wipLimit}, ${data.includes}, 0, ${now}, ${now})`)
  }
  async update(id: string, fields: Record<string, InValue>): Promise<LaneRow | null> {
    const allowed = new Set(["label", "icon", "position", "wip_limit", "includes"])
    if (Object.keys(fields).some(column => !allowed.has(column))) throw new Error("Unsupported lane field")
    const sets = Object.entries(fields).map(([column, value]) => sql`${sourceSql(column)} = ${value}`)
    if (!sets.length) return null
    sets.push(sql`updated_at = ${Date.now()}`)
    const db = fields.includes === undefined ? this.db(true) : this.definitionWriter(String(fields.includes))
    const { rows } = await db.execute(sql`UPDATE kanban_lanes SET ${joinSql(sets)} WHERE board_id = ${this.scope.boardId} AND id = ${id} RETURNING *`)
    return rows[0] as unknown as LaneRow ?? null
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
  async delete(id: string, laneKey: string): Promise<void> {
    let db = this.db(true)
    db = boardOperationClient(db, this.scope, { resource: "task", action: "edit" })
    db = boardOperationClient(db, this.scope, { resource: "task", action: "reopen" })
    const tx = await db.transaction("write")
    try {
      if (!await canReadBoardAggregate(tx, this.scope)) throw new BoardOperationError("unavailable")
      const { rows: [lane] } = await tx.execute(sql`SELECT id FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${id} AND key = ${laneKey} AND built_in = 0`)
      if (!lane) return
      const { rows: [replacement] } = await tx.execute(sql`SELECT id FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id <> ${id} AND EXISTS (SELECT 1 FROM json_each(includes) WHERE value = ${STATUS.PENDING}) ORDER BY position, id LIMIT 1`)
      if (!replacement) throw new Error("Keep a lane for pending work")
      await tx.execute(sql`UPDATE tasks SET status = ${STATUS.PENDING}, board_column_id = ${storageBoardId(this.scope) === null ? null : String(replacement.id)}, updated_at = ${Date.now()}
        WHERE ${taskOwnedBy(this.scope)} AND (board_column_id = ${id} OR (board_column_id IS NULL AND status = ${laneKey}))`)
      await tx.execute(sql`DELETE FROM kanban_lanes WHERE board_id = ${this.scope.boardId} AND id = ${id} AND built_in = 0`)
      await tx.commit()
    } finally { tx.close() }
  }
}
