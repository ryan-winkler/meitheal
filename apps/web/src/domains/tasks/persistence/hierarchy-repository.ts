import { validateBoardFeature } from "../board-access-service"
import { goalEligibility } from "./shared-goal-repository"
import { scopedTaskRead, planningVisible } from "./board-work-query"
import type { Client, InValue } from "@libsql/client"
import { goalProgress } from "@meitheal/domain-tasks"
import { getStatusDef, STATUS } from "../../../lib/status-config"
import { validateBoardScope, requireBoardScope, type BoardScope, type WorkAction, type WorkResource } from "../board-scope"
import { changeBoardGrants } from "./board-grant-fence"
import { boardOperationClient, BoardOperationError } from "./board-operation-client"
import { ownedPlanning, storageBoardId, taskField, taskOwnedBy } from "./board-storage"
import { sql, sourceSql, joinSql, type SqlFragment } from "./sql-fragment"
import { deferralTerminalStatusesSql } from "./task-deferral-status"

export interface AreaRow {
  id: string
  name: string
  icon: string
  color: string
  position: number
  created_at: number
  updated_at: number
}

export interface GoalRow {
  id: string
  area_id: string | null
  title: string
  description: string | null
  status: string
  target_date: string | null
  /** Metric tracking type: count, percentage, currency, boolean, custom */
  metric_type: string | null
  /** Target value for goal completion (e.g. 100 for percentage, 50000 for savings) */
  metric_target: number | null
  /** Current progress value toward metric_target */
  metric_current: number
  progress: number
  created_at: number
  updated_at: number
}

export interface ProjectRow {
  id: string
  goal_id: string | null
  /** Direct area ownership — sidebar groups projects by this field */
  area_id: string | null
  title: string
  description: string | null
  status: string
  icon: string
  color: string
  position: number
  /** Whether this is the protected default project ("Every Day") */
  is_default: boolean
  created_at: number
  updated_at: number
}

export class PlanningAccessLockedError extends Error {}

type GoalInput = { project_id?: string | null; id: string; title: string; area_id?: string | null; description?: string; status?: string; target_date?: string | null; metric_type?: string | null; metric_target?: number | null; metric_current?: number }
type GoalPatch = { title?: string; area_id?: string | null; description?: string | null; status?: string; target_date?: string | null; metric_type?: string | null; metric_target?: number | null; metric_current?: number; progress?: number }
type ProjectInput = { id: string; title: string; goal_id?: string | null; area_id?: string | null; description?: string; status?: string; icon?: string; color?: string; position?: number }
type ProjectPatch = Omit<Partial<Omit<ProjectInput, "id">>, "description"> & { description?: string | null }

export class HierarchyRepository {
  constructor(private readonly rawClient: Client, private readonly scope: BoardScope, private readonly markerPath?: string) { requireBoardScope(scope) }

  private db(resource: WorkResource, action: WorkAction = "read") { return boardOperationClient(this.rawClient, this.scope, { resource, action }) }
  private target(table: "areas" | "goals" | "projects", id: SqlFragment, includeRetired = false) {
    return sql`SELECT id FROM ${sourceSql(table)} WHERE id = ${id} AND ${ownedPlanning(this.scope, table)} AND ${planningVisible(this.scope, table)} ${sourceSql(includeRetired ? "" : "AND retired_at IS NULL")}`
  }
  private goalProjection() {
    return sql`goals.*, (${this.target("areas", sourceSql("goals.area_id"))}) AS visible_area_id`
  }
  private projectProjection() {
    return sql`projects.*, (${this.target("areas", sourceSql("projects.area_id"))}) AS visible_area_id,
      CASE WHEN ${goalEligibility(this.scope, sourceSql("projects.goal_id"), { areaId: sourceSql("projects.area_id"), projectId: sourceSql("projects.id") })} THEN projects.goal_id END AS visible_goal_id`
  }
  private optionalTarget(table: "areas" | "goals" | "projects", id: string | null | undefined) {
    return id == null ? sourceSql("1") : sql`EXISTS (${this.target(table, sql`${id}`)})`
  }

  async findAllAreas(): Promise<AreaRow[]> {
    const result = await this.db("area").execute(sql`SELECT * FROM areas WHERE ${ownedPlanning(this.scope, "areas")} AND ${planningVisible(this.scope, "areas")} AND retired_at IS NULL ORDER BY position, created_at`)
    return result.rows.map(row => this.mapArea(row))
  }
  async findAreaPage(after: string | null) {
    const { rows } = await this.db("area").execute(sql`WITH marker AS (
      SELECT position, name, id FROM areas WHERE id = ${after} AND ${ownedPlanning(this.scope, "areas")} AND ${planningVisible(this.scope, "areas")} AND retired_at IS NULL
    ) SELECT item.id, item.name FROM areas AS item WHERE ${ownedPlanning(this.scope, "item")} AND item.id IN (SELECT id FROM areas WHERE ${ownedPlanning(this.scope, "areas")} AND ${planningVisible(this.scope, "areas")}) AND item.retired_at IS NULL
      AND (${after} IS NULL OR EXISTS (SELECT 1 FROM marker WHERE (item.position, item.name COLLATE NOCASE, item.id) > (marker.position, marker.name COLLATE NOCASE, marker.id)))
      ORDER BY item.position, item.name COLLATE NOCASE, item.id LIMIT 31`)
    const items = rows.slice(0, 30).map(row => ({ id: String(row.id), name: String(row.name) }))
    return { items, next_cursor: rows.length > 30 ? items.at(-1)!.id : null }
  }
  async findAreaById(id: string): Promise<AreaRow | null> {
    const { rows } = await this.db("area").execute(sql`SELECT * FROM areas WHERE id = ${id} AND ${ownedPlanning(this.scope, "areas")} AND ${planningVisible(this.scope, "areas")} AND retired_at IS NULL`)
    return rows[0] ? this.mapArea(rows[0]) : null
  }
  async createArea(data: { id: string; name: string; icon?: string; color?: string; position?: number }): Promise<void> {
    const now = Date.now()
    await this.db("area", "create").execute(sql`INSERT INTO areas (id, owner_board_id, name, icon, color, position, created_at, updated_at)
      VALUES (${data.id}, ${storageBoardId(this.scope)}, ${data.name}, ${data.icon ?? "📁"}, ${data.color ?? "#6366F1"}, ${data.position ?? 0}, ${now}, ${now})`)
  }
  async updateArea(id: string, data: { name?: string; icon?: string; color?: string; position?: number }): Promise<boolean> {
    return this.updatePlanning("areas", "area", id, data, ["name", "icon", "color", "position"])
  }
  async retireAreaCommand(id: string): Promise<{ ok: true } | { ok: false, errorCode: "children" | "unavailable" }> {
    const result = await this.retirePlanning("areas", "area", id)
    return result === "saved" ? { ok: true } : { ok: false, errorCode: result }
  }
  async deleteArea(id: string): Promise<boolean> { return (await this.retireAreaCommand(id)).ok }
  async countAreas(): Promise<number> { return this.count("areas", "area") }
  async getNextAreaPosition(): Promise<number> { return this.nextPosition("areas", "area") }

  async findAllGoals(filters?: { area_id?: string; project_id?: string; status?: string }): Promise<GoalRow[]> {
    const predicates = [ownedPlanning(this.scope, "goals"), sourceSql("goals.retired_at IS NULL")]
    if (filters?.area_id) predicates.push(sql`EXISTS (${this.target("areas", sql`${filters.area_id}`)}) AND (goals.area_id = ${filters.area_id} OR EXISTS (
      SELECT 1 FROM projects WHERE projects.goal_id = goals.id AND projects.area_id = ${filters.area_id} AND ${ownedPlanning(this.scope, "projects")} AND ${planningVisible(this.scope, "projects")} AND projects.retired_at IS NULL))`)
    if (filters?.project_id) predicates.push(sql`EXISTS (SELECT 1 FROM projects WHERE projects.id = ${filters.project_id} AND projects.goal_id = goals.id AND ${ownedPlanning(this.scope, "projects")} AND ${planningVisible(this.scope, "projects")} AND projects.retired_at IS NULL)`)
    if (filters?.status) predicates.push(sql`goals.status = ${filters.status}`)
    const result = await this.db("goal").execute(sql`SELECT ${this.goalProjection()} FROM goals WHERE ${joinSql(predicates, " AND ")} ORDER BY created_at DESC`)
    return result.rows.map(row => this.mapGoal(row))
  }
  async findGoalById(id: string): Promise<GoalRow | null> {
    const { rows } = await this.db("goal").execute(sql`SELECT ${this.goalProjection()} FROM goals WHERE id = ${id} AND ${ownedPlanning(this.scope, "goals")} AND ${planningVisible(this.scope, "goals")} AND retired_at IS NULL`)
    return rows[0] ? this.mapGoal(rows[0]) : null
  }
  async createGoal(data: GoalInput): Promise<boolean> {
    const now = Date.now()
    let db = this.db("goal", "create")
    if (data.project_id) db = boardOperationClient(db, this.scope, { resource: "project", action: "edit" })
    const tx = await db.transaction("write")
    try {
      if (data.project_id) {
        const project = await tx.execute(sql`SELECT id FROM projects WHERE id = ${data.project_id} AND goal_id IS NULL AND ${ownedPlanning(this.scope, "projects")} AND ${planningVisible(this.scope, "projects")} AND retired_at IS NULL`)
        if (!project.rows.length) return false
      }
      const result = await tx.execute(sql`INSERT INTO goals (id, owner_board_id, area_id, title, description, status, target_date, metric_type, metric_target, metric_current, created_at, updated_at)
        SELECT ${data.id}, ${storageBoardId(this.scope)}, ${data.area_id ?? null}, ${data.title}, ${data.description ?? null}, ${data.status ?? "active"}, ${data.target_date ?? null}, ${data.metric_type ?? null}, ${data.metric_target ?? null}, ${data.metric_current ?? 0}, ${now}, ${now}
        WHERE ${this.optionalTarget("areas", data.area_id)}`)
      if (!result.rowsAffected) return false
      if (data.project_id) {
        const linked = await tx.execute(sql`UPDATE projects SET goal_id = ${data.id}, updated_at = ${now} WHERE id = ${data.project_id} AND goal_id IS NULL AND ${ownedPlanning(this.scope, "projects")} AND ${planningVisible(this.scope, "projects")} AND retired_at IS NULL`)
        if (linked.rowsAffected !== 1) throw new Error("Project association changed while creating the Goal")
      }
      await tx.commit()
      return true
    } finally { tx.close() }
  }
  async updateGoal(id: string, data: GoalPatch): Promise<boolean> {
    const sets = this.sets(data, ["title", "area_id", "description", "status", "target_date", "metric_type", "metric_target"])
    if (data.progress !== undefined) sets.push(sql`metric_current = ${data.progress} * CASE WHEN metric_target > 0 THEN metric_target ELSE 100 END / 100.0`, sourceSql("metric_type = CASE WHEN metric_target > 0 THEN metric_type ELSE 'percentage' END"), sourceSql("metric_target = CASE WHEN metric_target > 0 THEN metric_target ELSE 100 END"))
    else if (data.metric_current !== undefined) sets.push(sql`metric_current = ${data.metric_current}`)
    return this.updatePlanning("goals", "goal", id, data, [], sets, this.optionalTarget("areas", data.area_id))
  }
  async deleteGoal(id: string): Promise<boolean> { return await this.retirePlanning("goals", "goal", id) === "saved" }
  async countGoals(): Promise<number> { return this.count("goals", "goal") }

  async findProjectGroups(): Promise<Array<{ id: string; title: string; area_id: string | null }>> {
    return (await this.findAllProjects()).map(project => ({ id: project.id, title: project.title, area_id: project.area_id }))
  }
  async findAllProjects(filters?: { goal_id?: string; area_id?: string; status?: string }): Promise<ProjectRow[]> {
    const predicates = [ownedPlanning(this.scope, "projects"), planningVisible(this.scope, "projects"), sourceSql("projects.retired_at IS NULL")]
    if (filters?.goal_id) predicates.push(sql`projects.goal_id = ${filters.goal_id} AND ${goalEligibility(this.scope, sql`${filters.goal_id}`, { areaId: sourceSql("projects.area_id"), projectId: sourceSql("projects.id") })}`)
    if (filters?.area_id) predicates.push(sql`projects.area_id = ${filters.area_id} AND EXISTS (${this.target("areas", sql`${filters.area_id}`)})`)
    if (filters?.status) predicates.push(sql`projects.status = ${filters.status}`)
    const { rows } = await this.db("project").execute(sql`SELECT ${this.projectProjection()} FROM projects WHERE ${joinSql(predicates, " AND ")} ORDER BY position, created_at DESC`)
    return rows.map(row => this.mapProject(row))
  }
  /** Bounded sidebar options. Cursor and selected lookup share one admitted snapshot. */
  async findProjectPage(areaId: string, after: string | null, selectedId: string | null = null): Promise<{
    items: Array<{ id: string, name: string }>, selected: { id: string, name: string } | null, next_cursor: string | null
  } | null> {
    const tx = await this.db("project").transaction("read")
    try {
      const eligible = sql`${ownedPlanning(this.scope, "projects")} AND ${planningVisible(this.scope, "projects")}
        AND projects.retired_at IS NULL AND projects.area_id = ${areaId} AND EXISTS (${this.target("areas", sql`${areaId}`)})`
      const { rows: [marker] } = after === null ? { rows: [] } : await tx.execute(sql`SELECT projects.position, projects.title, projects.id
        FROM projects WHERE projects.id = ${after} AND ${eligible}`)
      if (after !== null && !marker) return null
      const { rows } = await tx.execute(sql`SELECT projects.id, projects.title FROM projects WHERE ${eligible}
        ${marker ? sql`AND (projects.position, projects.title COLLATE NOCASE, projects.id) > (${Number(marker.position)}, ${String(marker.title)} COLLATE NOCASE, ${String(marker.id)})` : sourceSql("")}
        ORDER BY projects.position, projects.title COLLATE NOCASE, projects.id LIMIT 31`)
      const { rows: [selected] } = selectedId === null ? { rows: [] } : await tx.execute(sql`SELECT projects.id, projects.title
        FROM projects WHERE projects.id = ${selectedId} AND ${eligible} LIMIT 1`)
      const items = rows.slice(0, 30).map(row => ({ id: String(row.id), name: String(row.title) }))
      await tx.commit()
      return { items, selected: selected ? { id: String(selected.id), name: String(selected.title) } : null,
        next_cursor: rows.length > 30 ? items.at(-1)!.id : null }
    } finally { tx.close() }
  }
  async findProjectsByArea(areaId: string): Promise<ProjectRow[]> { return this.findAllProjects({ area_id: areaId }) }
  async findProjectById(id: string): Promise<ProjectRow | null> {
    const { rows } = await this.db("project").execute(sql`SELECT ${this.projectProjection()} FROM projects WHERE id = ${id} AND ${ownedPlanning(this.scope, "projects")} AND ${planningVisible(this.scope, "projects")} AND retired_at IS NULL`)
    return rows[0] ? this.mapProject(rows[0]) : null
  }
  async getProjectTaskCounts(id: string): Promise<{ active_open: number; total: number; complete: number }> {
    const complete = [STATUS.COMPLETE, ...(getStatusDef(STATUS.COMPLETE)?.aliases ?? [])]
    const { rows: [counts] } = await this.db("task").execute(scopedTaskRead(this.scope, sql`SELECT COUNT(*) AS total,
      COUNT(*) FILTER (WHERE deferred_at IS NULL AND lower(status) NOT IN ${sourceSql(deferralTerminalStatusesSql)}) AS active_open,
      COUNT(*) FILTER (WHERE lower(status) IN (${joinSql(complete.map(value => sql`${value}`))})) AS complete
      FROM scoped_tasks WHERE project_id = ${id}`))
    return { total: Number(counts?.total ?? 0), active_open: Number(counts?.active_open ?? 0), complete: Number(counts?.complete ?? 0) }
  }
  async createProject(data: ProjectInput): Promise<boolean> {
    const now = Date.now()
    let db = this.db("project", "create")
    if (data.goal_id) db = boardOperationClient(db, this.scope, { resource: "project", action: "create" }, [], async reader => {
      if (!await validateBoardFeature(this.scope, reader, "goals")) throw new BoardOperationError("unavailable")
      return []
    })
    const result = await db.execute(sql`INSERT INTO projects (id, owner_board_id, goal_id, area_id, title, description, status, icon, color, position, created_at, updated_at)
      SELECT ${data.id}, ${storageBoardId(this.scope)}, ${data.goal_id ?? null}, ${data.area_id ?? null}, ${data.title}, ${data.description ?? null}, ${data.status ?? "active"}, ${data.icon ?? "📋"}, ${data.color ?? "#6366F1"}, ${data.position ?? 0}, ${now}, ${now}
      WHERE ${this.optionalTarget("areas", data.area_id)} AND (${data.goal_id ?? null} IS NULL OR ${goalEligibility(this.scope, sql`${data.goal_id ?? null}`, { areaId: sql`${data.area_id ?? null}`, projectId: sql`${data.id}` })})`)
    return result.rowsAffected > 0
  }
  async updateProject(id: string, data: ProjectPatch): Promise<boolean> {
    const goal = data.goal_id === undefined ? sourceSql("projects.goal_id") : sql`${data.goal_id}`
    const area = data.area_id === undefined ? sourceSql("projects.area_id") : sql`${data.area_id}`
    return this.updatePlanning("projects", "project", id, data, ["title", "goal_id", "area_id", "description", "status", "icon", "color", "position"], [], sql`${this.optionalTarget("areas", data.area_id)} AND (${goal} IS NULL OR ${goalEligibility(this.scope, goal, { areaId: area, projectId: sql`${id}` })})`)
  }
  async deleteProject(id: string): Promise<boolean> { return await this.retirePlanning("projects", "project", id) === "saved" }
  async countProjects(): Promise<number> { return this.count("projects", "project") }
  async getNextProjectPosition(): Promise<number> { return this.nextPosition("projects", "project") }

  private sets(data: object, allowed: readonly string[]): SqlFragment[] {
    return allowed.filter(key => (data as Record<string, unknown>)[key] !== undefined).map(key => sql`${sourceSql(key)} = ${(data as Record<string, InValue>)[key]!}`)
  }
  private async updatePlanning(table: "areas" | "goals" | "projects", resource: WorkResource, id: string, data: object, allowed: readonly string[], extra: SqlFragment[] = [], guard = sourceSql("1")) {
    const sets = [...this.sets(data, allowed), ...extra]
    if (!sets.length) return false
    sets.push(sql`updated_at = ${Date.now()}`)
    let db = this.db(resource, "edit")
    if (table === "projects" && Object.hasOwn(data, "goal_id")) db = boardOperationClient(db, this.scope, { resource: "project", action: "edit" }, [], async reader => {
      if (!await validateBoardFeature(this.scope, reader, "goals")) throw new BoardOperationError("unavailable")
      return []
    })
    const result = await db.execute(sql`UPDATE ${sourceSql(table)} SET ${joinSql(sets)} WHERE id = ${id} AND ${ownedPlanning(this.scope, table)} AND ${planningVisible(this.scope, table)} AND retired_at IS NULL AND ${guard}`)
    return result.rowsAffected > 0
  }
  private async retirePlanning(table: "areas" | "goals" | "projects", resource: WorkResource, id: string) {
    const result = await changeBoardGrants<"saved" | "children" | "unavailable">(this.rawClient, async tx => {
      const allowed = await validateBoardScope(this.scope, tx, { resource, action: "delete" })
      if (!allowed.ok) throw new BoardOperationError(allowed.errorCode)
      const { rows: [current] } = await tx.execute(sql`SELECT retired_at FROM ${sourceSql(table)} WHERE id = ${id}
        AND ${ownedPlanning(this.scope, table)} AND ${planningVisible(this.scope, table)}`)
      if (!current) return { unchanged: "unavailable" }
      if (current.retired_at !== null) return { unchanged: "saved" }
      if (table === "areas") {
        const { rows: [children] } = await tx.execute(sql`SELECT 1 WHERE
          EXISTS (SELECT 1 FROM projects WHERE area_id = ${id} AND ${ownedPlanning(this.scope, "projects")} AND retired_at IS NULL)
          OR EXISTS (SELECT 1 FROM goals WHERE area_id = ${id} AND ${ownedPlanning(this.scope, "goals")} AND retired_at IS NULL)
          OR EXISTS (SELECT 1 FROM task_templates WHERE ${ownedPlanning(this.scope, "task_templates")} AND retired_at IS NULL AND is_routine = 1
            AND CASE WHEN json_valid(template_json) THEN json_extract(template_json, '$.area_id') END = ${id})`)
        if (children) return { unchanged: "children" }
      }
      const now = Date.now()
      const changed = await tx.execute(sql`UPDATE ${sourceSql(table)} SET retired_at = ${now}, updated_at = ${now} WHERE id = ${id} AND ${ownedPlanning(this.scope, table)} AND ${planningVisible(this.scope, table)} AND retired_at IS NULL`)
      return changed.rowsAffected ? { next: "saved" } : { unchanged: "unavailable" }
    }, this.markerPath)
    if (result.status === "locked") throw new PlanningAccessLockedError("Work access is temporarily locked")
    return result.result
  }
  private async count(table: "areas" | "goals" | "projects", resource: WorkResource) {
    const { rows: [row] } = await this.db(resource).execute(sql`SELECT COUNT(*) AS count FROM ${sourceSql(table)} WHERE ${ownedPlanning(this.scope, table)} AND ${planningVisible(this.scope, table)} AND retired_at IS NULL`)
    return Number(row?.count ?? 0)
  }
  private async nextPosition(table: "areas" | "projects", resource: WorkResource) {
    const { rows: [row] } = await this.db(resource).execute(sql`SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM ${sourceSql(table)} WHERE ${ownedPlanning(this.scope, table)} AND ${planningVisible(this.scope, table)} AND retired_at IS NULL`)
    return Number(row?.next_pos ?? 0)
  }
  private mapArea(row: Record<string, unknown>): AreaRow {
    return {
      id: String(row.id),
      name: String(row.name),
      icon: String(row.icon ?? "📁"),
      color: String(row.color ?? "#6366F1"),
      position: Number(row.position ?? 0),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }
  }

  private mapGoal(row: Record<string, unknown>): GoalRow {
    return {
      id: String(row.id),
      area_id: row.visible_area_id ? String(row.visible_area_id) : null,
      title: String(row.title),
      description: row.description ? String(row.description) : null,
      status: String(row.status ?? "active"),
      target_date: row.target_date ? String(row.target_date) : null,
      metric_type: row.metric_type ? String(row.metric_type) : null,
      metric_target: row.metric_target != null ? Number(row.metric_target) : null,
      metric_current: Number(row.metric_current ?? 0),
      progress: goalProgress(Number(row.metric_current ?? 0), row.metric_target != null ? Number(row.metric_target) : null),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }
  }

  private mapProject(row: Record<string, unknown>): ProjectRow {
    return {
      id: String(row.id),
      goal_id: row.visible_goal_id ? String(row.visible_goal_id) : null,
      area_id: row.visible_area_id ? String(row.visible_area_id) : null,
      title: String(row.title),
      description: row.description ? String(row.description) : null,
      status: String(row.status ?? "active"),
      icon: String(row.icon ?? "📋"),
      color: String(row.color ?? "#6366F1"),
      position: Number(row.position ?? 0),
      is_default: Boolean(Number(row.is_default ?? 0)),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }
  }

  async findDefaultProject(): Promise<ProjectRow | null> {
    const { rows } = await this.db("project").execute(sql`SELECT ${this.projectProjection()} FROM projects WHERE is_default = 1 AND ${ownedPlanning(this.scope, "projects")} AND ${planningVisible(this.scope, "projects")} AND retired_at IS NULL LIMIT 1`)
    return rows[0] ? this.mapProject(rows[0]) : null
  }

  /** Compatibility read: choosing a default never invents a Project. */
  async ensureDefaultProject(): Promise<ProjectRow | null> { return this.findDefaultProject() }
}
