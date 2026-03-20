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

// ─── Repository ──────────────────────────────────────────────────────

export class HierarchyRepository {
  constructor(private client: Client) {}

  // ── Areas ────────────────────────────────────────────────────────

  async findAllAreas(): Promise<AreaRow[]> {
    const result = await this.client.execute(
      "SELECT * FROM areas ORDER BY position ASC, created_at ASC"
    )
    return result.rows.map(r => this.mapArea(r as Record<string, unknown>))
  }

  async findAreaById(id: string): Promise<AreaRow | null> {
    const result = await this.client.execute({
      sql: "SELECT * FROM areas WHERE id = ?",
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
      sql: `UPDATE areas SET ${sets.join(", ")} WHERE id = ?`,
      args,
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async deleteArea(id: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "DELETE FROM areas WHERE id = ?",
      args: [id],
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async countAreas(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as cnt FROM areas")
    return Number((result.rows[0] as Record<string, unknown>).cnt)
  }

  async getNextAreaPosition(): Promise<number> {
    const result = await this.client.execute(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM areas"
    )
    return Number((result.rows[0] as Record<string, unknown>)?.next_pos ?? 0)
  }

  // ── Goals ────────────────────────────────────────────────────────

  async findAllGoals(filters?: { area_id?: string; status?: string }): Promise<GoalRow[]> {
    let sql = "SELECT * FROM goals"
    const conditions: string[] = []
    const args: string[] = []

    if (filters?.area_id) { conditions.push("area_id = ?"); args.push(filters.area_id) }
    if (filters?.status) { conditions.push("status = ?"); args.push(filters.status) }

    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`
    sql += " ORDER BY created_at DESC"

    const result = await this.client.execute({ sql, args })
    return result.rows.map(r => this.mapGoal(r as Record<string, unknown>))
  }

  async findGoalById(id: string): Promise<GoalRow | null> {
    const result = await this.client.execute({
      sql: "SELECT * FROM goals WHERE id = ?",
      args: [id],
    })
    return result.rows[0] ? this.mapGoal(result.rows[0] as Record<string, unknown>) : null
  }

  async createGoal(data: {
    id: string; title: string; area_id?: string | null | undefined; description?: string; status?: string; target_date?: string | null | undefined
    metric_type?: string | null; metric_target?: number | null; metric_current?: number
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: `INSERT INTO goals (id, area_id, title, description, status, target_date, metric_type, metric_target, metric_current, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ],
    })
  }

  async updateGoal(id: string, data: {
    title?: string; area_id?: string | null; description?: string | null; status?: string; target_date?: string | null
    metric_type?: string | null; metric_target?: number | null; metric_current?: number
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
    if (data.metric_current !== undefined) { sets.push("metric_current = ?"); args.push(data.metric_current) }

    if (sets.length === 0) return false

    sets.push("updated_at = ?")
    args.push(Date.now())
    args.push(id)

    const result = await this.client.execute({
      sql: `UPDATE goals SET ${sets.join(", ")} WHERE id = ?`,
      args,
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async deleteGoal(id: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "DELETE FROM goals WHERE id = ?",
      args: [id],
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async countGoals(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as cnt FROM goals")
    return Number((result.rows[0] as Record<string, unknown>).cnt)
  }

  // ── Projects ─────────────────────────────────────────────────────

  async findAllProjects(filters?: { goal_id?: string; area_id?: string; status?: string }): Promise<ProjectRow[]> {
    let sql = "SELECT * FROM projects"
    const conditions: string[] = []
    const args: string[] = []

    if (filters?.goal_id) { conditions.push("goal_id = ?"); args.push(filters.goal_id) }
    if (filters?.area_id) { conditions.push("area_id = ?"); args.push(filters.area_id) }
    if (filters?.status) { conditions.push("status = ?"); args.push(filters.status) }

    if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`
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
      sql: "SELECT * FROM projects WHERE id = ?",
      args: [id],
    })
    return result.rows[0] ? this.mapProject(result.rows[0] as Record<string, unknown>) : null
  }

  async createProject(data: {
    id: string; title: string; goal_id?: string | null | undefined; area_id?: string | null | undefined; description?: string; status?: string; icon?: string; color?: string; position?: number
  }): Promise<void> {
    const now = Date.now()
    await this.client.execute({
      sql: `INSERT INTO projects (id, goal_id, area_id, title, description, status, icon, color, position, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ],
    })
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

    const result = await this.client.execute({
      sql: `UPDATE projects SET ${sets.join(", ")} WHERE id = ?`,
      args,
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async deleteProject(id: string): Promise<boolean> {
    // Guard: prevent deleting the default "Every Day" project
    const project = await this.findProjectById(id)
    if (project?.is_default) return false

    const result = await this.client.execute({
      sql: "DELETE FROM projects WHERE id = ? AND is_default = 0",
      args: [id],
    })
    return (result.rowsAffected ?? 0) > 0
  }

  async countProjects(): Promise<number> {
    const result = await this.client.execute("SELECT COUNT(*) as cnt FROM projects")
    return Number((result.rows[0] as Record<string, unknown>).cnt)
  }

  async getNextProjectPosition(): Promise<number> {
    const result = await this.client.execute(
      "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM projects"
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
      area_id: row.area_id ? String(row.area_id) : null,
      title: String(row.title),
      description: row.description ? String(row.description) : null,
      status: String(row.status ?? "active"),
      target_date: row.target_date ? String(row.target_date) : null,
      metric_type: row.metric_type ? String(row.metric_type) : null,
      metric_target: row.metric_target != null ? Number(row.metric_target) : null,
      metric_current: Number(row.metric_current ?? 0),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    }
  }

  private mapProject(row: Record<string, unknown>): ProjectRow {
    return {
      id: String(row.id),
      goal_id: row.goal_id ? String(row.goal_id) : null,
      area_id: row.area_id ? String(row.area_id) : null,
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
      "SELECT * FROM projects WHERE is_default = 1 LIMIT 1"
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
