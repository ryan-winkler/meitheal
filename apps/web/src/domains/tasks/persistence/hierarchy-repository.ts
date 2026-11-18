/**
 * HierarchyRepository — domain service for Area, Goal, and Project CRUD.
 * @domain Task Management (Hierarchy context)
 *
 * Uses the tables created in Phase 04.1a (areas, goals, projects).
 * All operations use typed, parameterized queries.
 *
 * @see docs/decisions/ADR-007-hierarchy-model.md
 */
import type { Client } from "@libsql/client"
import { goalProgress } from "@meitheal/domain-tasks"
import { getStatusDef, STATUS } from "../../../lib/status-config"
import { changeBoardGrants } from "./board-grant-fence"
import { deferralTerminalStatusesSql } from "./task-deferral-status"

// ─── Types ───────────────────────────────────────────────────────────

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

const householdPlanningLink = (table: "areas" | "goals", reference: string, includeRetired = false) =>
  `SELECT id FROM ${table} WHERE id = ${reference} AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active')${includeRetired ? "" : " AND retired_at IS NULL"}`
const householdAreaLink = (reference: string, includeRetired = false) => householdPlanningLink("areas", reference, includeRetired)
const householdGoalLink = (reference: string, includeRetired = false) => householdPlanningLink("goals", reference, includeRetired)

const householdGoalProjection = `goals.*, (${householdAreaLink("goals.area_id")}) AS visible_area_id`
const householdProjectProjection = `projects.*, (${householdAreaLink("projects.area_id")}) AS visible_area_id,
  (${householdGoalLink("projects.goal_id")}) AS visible_goal_id`

// ─── Repository ──────────────────────────────────────────────────────

export class PlanningAccessLockedError extends Error {}

export class HierarchyRepository {
  constructor(private client: Client, private markerPath?: string) {}

  // ── Areas ────────────────────────────────────────────────────────

  async findAllAreas(): Promise<AreaRow[]> {
    const result = await this.client.execute(
      "SELECT * FROM areas WHERE owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL ORDER BY position ASC, created_at ASC"
    )
    return result.rows.map(r => this.mapArea(r as Record<string, unknown>))
  }

  async findAreaPage(after: string | null) {
    const { rows } = await this.client.execute({
      sql: `WITH marker AS (
          SELECT position, name, id FROM areas WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL
        )
        SELECT item.id, item.name FROM areas AS item
        WHERE item.owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND item.retired_at IS NULL AND (
          ? IS NULL OR EXISTS (
            SELECT 1 FROM marker WHERE (item.position, item.name COLLATE NOCASE, item.id) >
              (marker.position, marker.name COLLATE NOCASE, marker.id)
          )
        )
        ORDER BY item.position, item.name COLLATE NOCASE, item.id LIMIT 31`,
      args: [after, after],
    })
    const items = rows.slice(0, 30).map(row => ({ id: String(row.id), name: String(row.name) }))
    return { items, next_cursor: rows.length > 30 ? items.at(-1)!.id : null }
  }

  async findAreaById(id: string): Promise<AreaRow | null> {
    const result = await this.client.execute({
      sql: "SELECT * FROM areas WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL",
      args: [id],
    })
    return result.rows[0] ? this.mapArea(result.rows[0] as Record<string, unknown>) : null
  }

  async createArea(data: {
    id: string; name: string; icon?: string; color?: string; position?: number
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: `INSERT INTO areas (id, name, icon, color, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.id,
        data.name,
        data.icon ?? "📁",
        data.color ?? "#6366F1",
        data.position ?? 0,
        now,
        now,
      ],
    })
  }

  async updateArea(id: string, data: {
    name?: string; icon?: string; color?: string; position?: number
  }): Promise<boolean> {
    const sets: string[] = []
    const args: (string | number)[] = []

    if (data.name !== undefined) { sets.push("name = ?"); args.push(data.name) }
    if (data.icon !== undefined) { sets.push("icon = ?"); args.push(data.icon) }
    if (data.color !== undefined) { sets.push("color = ?"); args.push(data.color) }
    if (data.position !== undefined) { sets.push("position = ?"); args.push(data.position) }

    if (sets.length === 0) return false

    sets.push("updated_at = ?")
    args.push(Date.now())
    args.push(id)

    const result = await this.client.execute({
      sql: `UPDATE areas SET ${sets.join(", ")} WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL`,
      args,
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async deleteArea(id: string): Promise<boolean> {
    if (id === "default") return false
    return this.retireHouseholdPlanning("areas", id)
  }

  async countAreas(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as cnt FROM areas WHERE owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL")
    return Number((result.rows[0] as Record<string, unknown>).cnt)
  }

  async getNextAreaPosition(): Promise<number> {
    const result = await this.client.execute(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM areas WHERE owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL"
    )
    return Number((result.rows[0] as Record<string, unknown>)?.next_pos ?? 0)
  }

  // ── Goals ────────────────────────────────────────────────────────

  async findAllGoals(filters?: { area_id?: string; project_id?: string; status?: string }): Promise<GoalRow[]> {
    let sql = `SELECT ${householdGoalProjection} FROM goals`
    const conditions = ["owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL"]
    const args: string[] = []

    if (filters?.area_id) {
      conditions.push(`EXISTS (${householdAreaLink("?")}) AND
        (area_id = ? OR id IN (SELECT goal_id FROM projects WHERE area_id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL))`)
      args.push(filters.area_id, filters.area_id, filters.area_id)
    }
    if (filters?.project_id) {
      conditions.push("id = (SELECT goal_id FROM projects WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL)")
      args.push(filters.project_id)
    }
    if (filters?.status) { conditions.push("status = ?"); args.push(filters.status) }

    sql += ` WHERE ${conditions.join(" AND ")}`
    sql += " ORDER BY created_at DESC"

    const result = await this.client.execute({ sql, args })
    return result.rows.map(r => this.mapGoal(r as Record<string, unknown>))
  }

  async findGoalById(id: string): Promise<GoalRow | null> {
    const result = await this.client.execute({
      sql: `SELECT ${householdGoalProjection} FROM goals WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL`,
      args: [id],
    })
    return result.rows[0] ? this.mapGoal(result.rows[0] as Record<string, unknown>) : null
  }

  async createGoal(data: {
    id: string; title: string; area_id?: string | null | undefined; description?: string; status?: string; target_date?: string | null | undefined
    metric_type?: string | null; metric_target?: number | null; metric_current?: number
  }): Promise<boolean> {
    const now = Date.now()
    const result = await this.client.execute({
      sql: `INSERT INTO goals (id, area_id, title, description, status, target_date, metric_type, metric_target, metric_current, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE ? IS NULL OR EXISTS (${householdAreaLink("?")})`,
      args: [
        data.id,
        data.area_id ?? null,
        data.title,
        data.description ?? null,
        data.status ?? "active",
        data.target_date ?? null,
        data.metric_type ?? null,
        data.metric_target ?? null,
        data.metric_current ?? 0,
        now,
        now,
        data.area_id ?? null,
        data.area_id ?? null,
      ],
    })
    return result.rowsAffected > 0
  }

  async updateGoal(id: string, data: {
    title?: string; area_id?: string | null; description?: string | null; status?: string; target_date?: string | null
    metric_type?: string | null; metric_target?: number | null; metric_current?: number; progress?: number
  }): Promise<boolean> {
    const sets: string[] = []
    const args: (string | number | null)[] = []

    if (data.title !== undefined) { sets.push("title = ?"); args.push(data.title) }
    if (data.area_id !== undefined) { sets.push("area_id = ?"); args.push(data.area_id) }
    if (data.description !== undefined) { sets.push("description = ?"); args.push(data.description) }
    if (data.status !== undefined) { sets.push("status = ?"); args.push(data.status) }
    if (data.target_date !== undefined) { sets.push("target_date = ?"); args.push(data.target_date) }
    if (data.metric_type !== undefined) { sets.push("metric_type = ?"); args.push(data.metric_type) }
    if (data.metric_target !== undefined) { sets.push("metric_target = ?"); args.push(data.metric_target) }
    if (data.progress !== undefined) {
      sets.push("metric_current = ? * CASE WHEN metric_target > 0 THEN metric_target ELSE 100 END / 100.0")
      args.push(data.progress)
      sets.push("metric_type = CASE WHEN metric_target > 0 THEN metric_type ELSE 'percentage' END")
      sets.push("metric_target = CASE WHEN metric_target > 0 THEN metric_target ELSE 100 END")
    } else if (data.metric_current !== undefined) { sets.push("metric_current = ?"); args.push(data.metric_current) }

    if (sets.length === 0) return false

    sets.push("updated_at = ?")
    args.push(Date.now())
    args.push(id)

    const area = data.area_id
    const existingAreaGuard = area === undefined ? "" : `AND (area_id IS NULL OR EXISTS (${householdAreaLink("goals.area_id", true)}))`
    const areaGuard = area == null ? "" : `AND EXISTS (${householdAreaLink("?")})`
    if (area != null) args.push(area)
    const result = await this.client.execute({
      sql: `UPDATE goals SET ${sets.join(", ")} WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL ${existingAreaGuard} ${areaGuard}`,
      args,
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async deleteGoal(id: string): Promise<boolean> {
    return this.retireHouseholdPlanning("goals", id)
  }

  private async retireHouseholdPlanning(table: "areas" | "goals", id: string) {
    const outcome = await changeBoardGrants(this.client, async tx => {
      const now = Date.now()
      const result = await tx.execute({
        sql: `UPDATE ${table} SET retired_at = ?, updated_at = ?
          WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL`,
        args: [now, now, id],
      })
      return result.rowsAffected ? { next: true } : { unchanged: false }
    }, this.markerPath, { keepUninitialized: true })
    if (outcome.status === "locked") throw new PlanningAccessLockedError("Named Board access is temporarily locked")
    return outcome.result
  }

  async countGoals(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as cnt FROM goals WHERE owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL")
    return Number((result.rows[0] as Record<string, unknown>).cnt)
  }

  // ── Projects ─────────────────────────────────────────────────────

  /** Household Project identities and their scoped direct or inherited Area. */
  async findProjectGroups(): Promise<Array<{ id: string; title: string; area_id: string | null }>> {
    const result = await this.client.execute(
      `SELECT projects.id, projects.title,
        CASE WHEN projects.area_id IS NOT NULL THEN (${householdAreaLink("projects.area_id")})
          ELSE (SELECT (${householdAreaLink("goals.area_id")}) FROM goals
            WHERE goals.id = projects.goal_id AND goals.owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND goals.retired_at IS NULL)
        END AS area_id
       FROM projects WHERE projects.owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND projects.retired_at IS NULL
       ORDER BY projects.position ASC, projects.id ASC`,
    )
    return result.rows.map(row => ({
      id: String(row.id), title: String(row.title), area_id: row.area_id == null ? null : String(row.area_id),
    }))
  }

  async findAllProjects(filters?: { goal_id?: string; area_id?: string; status?: string }): Promise<ProjectRow[]> {
    let sql = `SELECT ${householdProjectProjection} FROM projects`
    const conditions = ["owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL"]
    const args: string[] = []

    if (filters?.goal_id) { conditions.push("visible_goal_id = ?"); args.push(filters.goal_id) }
    if (filters?.area_id) {
      conditions.push(`(CASE WHEN projects.area_id IS NOT NULL THEN visible_area_id
        ELSE (SELECT (${householdAreaLink("goals.area_id")}) FROM goals
          WHERE goals.id = projects.goal_id AND goals.owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL) END) = ?`)
      args.push(filters.area_id)
    }
    if (filters?.status) { conditions.push("status = ?"); args.push(filters.status) }

    sql += ` WHERE ${conditions.join(" AND ")}`
    sql += " ORDER BY position ASC, created_at DESC"

    const result = await this.client.execute({ sql, args })
    return result.rows.map(r => this.mapProject(r as Record<string, unknown>))
  }

  /** Convenience: find all projects belonging to a specific area */
  async findProjectsByArea(areaId: string): Promise<ProjectRow[]> {
    return this.findAllProjects({ area_id: areaId })
  }

  async findProjectById(id: string): Promise<ProjectRow | null> {
    const result = await this.client.execute({
      sql: `SELECT ${householdProjectProjection} FROM projects WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL`,
      args: [id],
    })
    return result.rows[0] ? this.mapProject(result.rows[0] as Record<string, unknown>) : null
  }

  async getProjectTaskCounts(id: string): Promise<{ active_open: number; total: number; complete: number }> {
    const completed = [STATUS.COMPLETE, ...(getStatusDef(STATUS.COMPLETE)?.aliases ?? [])]
    const { rows: [counts] } = await this.client.execute({
      sql: `SELECT COUNT(*) AS total,
                  COUNT(*) FILTER (WHERE deferred_at IS NULL AND lower(status) NOT IN ${deferralTerminalStatusesSql}) AS active_open,
                  COUNT(*) FILTER (WHERE lower(status) IN (${completed.map(() => "?").join(", ")})) AS complete
            FROM tasks WHERE task_board_id IS NULL AND project_id = ?`,
      args: [...completed, id],
    })
    return { total: Number(counts?.total), active_open: Number(counts?.active_open), complete: Number(counts?.complete) }
  }

  async createProject(data: {
    id: string; title: string; goal_id?: string | null | undefined; area_id?: string | null | undefined; description?: string; status?: string; icon?: string; color?: string; position?: number
  }): Promise<boolean> {
    const now = Date.now()
    const result = await this.client.execute({
      sql: `INSERT INTO projects (id, goal_id, area_id, title, description, status, icon, color, position, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE (? IS NULL OR EXISTS (${householdGoalLink("?")}))
              AND (? IS NULL OR EXISTS (${householdAreaLink("?")}))`,
      args: [
        data.id,
        data.goal_id ?? null,
        data.area_id ?? null,
        data.title,
        data.description ?? null,
        data.status ?? "active",
        data.icon ?? "📋",
        data.color ?? "#6366F1",
        data.position ?? 0,
        now,
        now,
        data.goal_id ?? null, data.goal_id ?? null,
        data.area_id ?? null, data.area_id ?? null,
      ],
    })
    return result.rowsAffected > 0
  }

  async updateProject(id: string, data: {
    title?: string; goal_id?: string | null; area_id?: string | null; description?: string | null; status?: string; icon?: string; color?: string; position?: number
  }): Promise<boolean> {
    const sets: string[] = []
    const args: (string | number | null)[] = []

    if (data.title !== undefined) { sets.push("title = ?"); args.push(data.title) }
    if (data.goal_id !== undefined) { sets.push("goal_id = ?"); args.push(data.goal_id) }
    if (data.area_id !== undefined) { sets.push("area_id = ?"); args.push(data.area_id) }
    if (data.description !== undefined) { sets.push("description = ?"); args.push(data.description) }
    if (data.status !== undefined) { sets.push("status = ?"); args.push(data.status) }
    if (data.icon !== undefined) { sets.push("icon = ?"); args.push(data.icon) }
    if (data.color !== undefined) { sets.push("color = ?"); args.push(data.color) }
    if (data.position !== undefined) { sets.push("position = ?"); args.push(data.position) }

    if (sets.length === 0) return false

    sets.push("updated_at = ?")
    args.push(Date.now())
    args.push(id)

    const goal = data.goal_id
    const area = data.area_id
    const existingGoalGuard = goal === undefined ? "" : `AND (goal_id IS NULL OR EXISTS (${householdGoalLink("projects.goal_id", true)}))`
    const existingAreaGuard = area === undefined ? "" : `AND (area_id IS NULL OR EXISTS (${householdAreaLink("projects.area_id", true)}))`
    const goalGuard = goal == null ? "" : `AND EXISTS (${householdGoalLink("?")})`
    const areaGuard = area == null ? "" : `AND EXISTS (${householdAreaLink("?")})`
    if (goal != null) args.push(goal)
    if (area != null) args.push(area)
    const result = await this.client.execute({
      sql: `UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL
        ${existingGoalGuard} ${existingAreaGuard} ${goalGuard} ${areaGuard}`,
      args,
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async deleteProject(id: string): Promise<boolean> {
    const now = Date.now()
    const deletable = "SELECT 1 FROM projects WHERE id = ? AND is_default = 0 AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL"
    const [, result] = await this.client.batch([
      {
        sql: `UPDATE tasks SET project_id = NULL, updated_at = ?
              WHERE task_board_id IS NULL AND project_id = ? AND EXISTS (${deletable})`,
        args: [now, id, id],
      },
      {
        sql: `UPDATE projects SET retired_at = ?, updated_at = ? WHERE id = ? AND EXISTS (${deletable})`,
        args: [now, now, id, id],
      },
    ], "write")
    return (result?.rowsAffected ?? 0) > 0
  }

  async countProjects(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as cnt FROM projects WHERE owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL")
    return Number((result.rows[0] as Record<string, unknown>).cnt)
  }

  async getNextProjectPosition(): Promise<number> {
    const result = await this.client.execute(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM projects WHERE owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL"
    )
    return Number((result.rows[0] as Record<string, unknown>)?.next_pos ?? 0)
  }

  // ── Mappers ──────────────────────────────────────────────────────

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

  // ── Default Project Helpers ──────────────────────────────────────

  /** Find the default "Every Day" project */
  async findDefaultProject(): Promise<ProjectRow | null> {
    const result = await this.client.execute(
      `SELECT ${householdProjectProjection} FROM projects WHERE is_default = 1 AND owner_board_id IS NULL AND EXISTS (SELECT 1 FROM task_boards WHERE id = 'household' AND state = 'active') AND retired_at IS NULL LIMIT 1`
    )
    return result.rows[0] ? this.mapProject(result.rows[0] as Record<string, unknown>) : null
  }

  /** Ensure a default project exists — idempotent, called on startup */
  async ensureDefaultProject(): Promise<ProjectRow> {
    const existing = await this.findDefaultProject()
    if (existing) return existing

    const now = Date.now()
    const id = "every-day"
    await this.client.execute({
      sql: `INSERT INTO projects (id, goal_id, title, description, status, icon, color, position, is_default, created_at, updated_at)
            VALUES (?, NULL, 'Every Day', 'Your daily tasks and quick captures', 'active', '☀️', '#F59E0B', -1, 1, ?, ?)
            ON CONFLICT(id) DO NOTHING`,
      args: [id, now, now],
    })
    return (await this.findDefaultProject())!
  }
}
