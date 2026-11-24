import { planningVisible } from "./board-work-query"
import { requireBoardScope, type BoardScope, type WorkAction } from "../board-scope"
import { boardOperationClient } from "./board-operation-client"
import { ownedPlanning } from "./board-storage"
import { HierarchyRepository } from "./hierarchy-repository"
import { sql, sourceSql, joinSql } from "./sql-fragment"
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
  constructor(private readonly client: Client, private readonly scope: BoardScope) { requireBoardScope(scope) }
  private db(action: WorkAction = "read") { return boardOperationClient(this.client, this.scope, { resource: "area", action }) }
  async findAll(): Promise<AreaRow[]> {
    const result = await this.db().execute(sql`SELECT * FROM areas WHERE ${ownedPlanning(this.scope, "areas")} AND ${planningVisible(this.scope, "areas")} AND retired_at IS NULL ORDER BY position, created_at`)
    return result.rows as unknown as AreaRow[]
  }
  async count(): Promise<number> { return new HierarchyRepository(this.client, this.scope).countAreas() }
  async getNextPosition(): Promise<number> { return new HierarchyRepository(this.client, this.scope).getNextAreaPosition() }
  async create(data: { id: string; name: string; icon: string; color: string; position: number }): Promise<void> {
    return new HierarchyRepository(this.client, this.scope).createArea(data)
  }
  async update(id: string, fields: Record<string, InValue>): Promise<void> {
    const columns = new Set(["name", "icon", "color", "position", "wip_limit", "energy_budget", "review_cadence", "last_reviewed_at"])
    const entries = Object.entries(fields)
    if (entries.some(([column]) => !columns.has(column))) throw new Error("Unsupported Area field")
    if (!entries.length) return
    const sets = entries.map(([column, value]) => sql`${sourceSql(column)} = ${value}`)
    sets.push(sql`updated_at = ${Date.now()}`)
    await this.db("edit").execute(sql`UPDATE areas SET ${joinSql(sets)} WHERE id = ${id} AND ${ownedPlanning(this.scope, "areas")} AND ${planningVisible(this.scope, "areas")} AND retired_at IS NULL`)
  }
}
