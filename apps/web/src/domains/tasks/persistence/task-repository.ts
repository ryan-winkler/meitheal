/**
 * TaskRepository — centralized domain service for all task-related database queries.
 * @domain Task Management
 *
 * Provides typed, parameterized query methods for both reads and writes.
 * Read methods serve Astro page files (dashboard, kanban, calendar, etc.).
 * Write methods serve API routes (tasks CRUD, recurrence, activity logging).
 *
 * @example
 *   import { TaskRepository } from '@domains/tasks/persistence/task-repository';
 *   const repo = new TaskRepository(getPersistenceClient());
 *   const tasks = await repo.getRecentTasks(10);
 *   const created = await repo.createTask({ id: '...', title: 'New', ... });
 */

import type { Client } from "@libsql/client";
import type { InValue } from "@libsql/client";
import { normalizeStatus, STATUS } from "../../../lib/status-config";

// ── Types ──────────────────────────────────────────────────────────────────

/** Generic task row — all fields returned raw from the database */
export type TaskRow = Record<string, unknown>;

/**
 * Strip agent_scratchpad from task rows before returning to callers.
 * The scratchpad is ephemeral bot working data that must NEVER appear in API responses.
 */
function sanitizeRows(rows: TaskRow[]): TaskRow[] {
  return rows.map(row => {
    const { agent_scratchpad: _, ...rest } = row
    return rest
  })
}

/** Status count for dashboard statistics */
export interface StatusCount {
  status: string;
  count: number;
}

/** Dashboard statistics aggregate */
export interface DashboardStats {
  total: number;
  open: number;
  active: number;
  completed: number;
  overdue: number;
}

/** Board metadata */
export interface BoardInfo {
  id: string;
  name: string;
  color: string;
}

/** Calendar day task aggregate */
export interface CalendarDayInfo {
  dueDate: string;
  count: number;
  colors: string[];
  haEvents: number;
}

/** Kanban lane definition */
export interface KanbanLane {
  id: string;
  key: string;
  label: string;
  icon: string;
  includes: string[];
  builtIn: boolean;
  wipLimit: number;
}

/** Comment count per task */
export type CommentCounts = Record<string, number>;

/** Setting key-value pair */
export interface SettingRow {
  key: string;
  value: string;
}

// ── Repository ─────────────────────────────────────────────────────────────

/**
 * Centralized repository for task-related database queries.
 * Replaces inline SQL in Astro page files to enforce DDD boundaries.
 *
 * Design decisions:
 * - Returns raw `TaskRow[]` to avoid coupling to specific page needs.
 * - Uses parameterized queries to prevent SQL injection.
 * - Each method maps 1:1 to a query previously inline in a page file.
 * - Stateless: client injected via constructor (follows existing store pattern).
 */
export class TaskRepository {
  constructor(private readonly client: Client) {}

  // ── Dashboard (index.astro) ─────────────────────────────────────────

  /** Recent tasks for dashboard hero section */
  async getRecentTasks(limit = 10): Promise<TaskRow[]> {
    const result = await this.client.execute(
      `SELECT id, title, description, status, priority, due_date, labels, calendar_sync_state, is_favorite, board_id, color, ticket_number, task_type, task_kind, project_id, owner, handoff_state, created_at, updated_at
       FROM tasks ORDER BY created_at DESC LIMIT ${limit}`,
    );
    return result.rows as TaskRow[];
  }

  /** Tasks belonging to a specific project, ordered by priority */
  async findByProjectId(projectId: string): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT id, title, description, status, priority, due_date, labels, is_favorite, board_id, color, ticket_number, task_type, task_kind, project_id, owner, handoff_state, assigned_to, progress, created_at, updated_at
            FROM tasks WHERE project_id = ?
            ORDER BY priority ASC, created_at DESC`,
      args: [projectId],
    });
    return sanitizeRows(result.rows as TaskRow[]);
  }

  /** Favorited, non-complete tasks */
  async getFavoriteTasks(limit = 5): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT id, title, status, priority, due_date, is_favorite
            FROM tasks WHERE is_favorite = 1 AND status != ?
            ORDER BY updated_at DESC LIMIT ${limit}`,
      args: [STATUS.COMPLETE],
    });
    return result.rows as TaskRow[];
  }

  /** Open (non-complete) tasks ordered by priority then due date */
  async getOpenTasks(limit = 15): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT id, title, status, priority, due_date, assigned_to, board_id, ticket_number, task_type, task_kind, project_id, owner, handoff_state
            FROM tasks WHERE status NOT IN (?)
            ORDER BY priority ASC, due_date ASC NULLS LAST, updated_at DESC
            LIMIT ${limit}`,
      args: [STATUS.COMPLETE],
    });
    return result.rows as TaskRow[];
  }

  /** Count tasks grouped by status for dashboard stats */
  async getStatusCounts(): Promise<DashboardStats> {
    const result = await this.client.execute(
      "SELECT status, COUNT(*) as cnt FROM tasks GROUP BY status",
    );
    const stats: DashboardStats = { total: 0, open: 0, active: 0, completed: 0, overdue: 0 };
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      const s = String(r.status);
      const c = Number(r.cnt);
      stats.total += c;
      if (s === STATUS.ACTIVE) stats.active += c;
      if (s === STATUS.COMPLETE) stats.completed += c;
      else stats.open += c;
    }
    return stats;
  }

  /** Count overdue tasks (past due, not complete) */
  async getOverdueCount(): Promise<number> {
    const result = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM tasks
            WHERE due_date IS NOT NULL AND due_date < ? AND status != ?`,
      args: [new Date().toISOString(), STATUS.COMPLETE],
    });
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  }

  /** All boards (for card badges on dashboard) */
  async getBoards(): Promise<Record<string, BoardInfo>> {
    const result = await this.client.execute("SELECT id, title, color FROM boards");
    const boardMap: Record<string, BoardInfo> = {
      default: { id: "default", name: "Default", color: "#6366F1" },
    };
    for (const b of result.rows) {
      const br = b as Record<string, unknown>;
      boardMap[String(br.id)] = {
        id: String(br.id),
        name: String(br.title ?? "Default"),
        color: String(br.color ?? "#6366F1"),
      };
    }
    return boardMap;
  }

  // ── Kanban (kanban.astro) ───────────────────────────────────────────

  /** All tasks for kanban board, ordered by position then priority */
  async getKanbanTasks(): Promise<TaskRow[]> {
    const result = await this.client.execute(
      `SELECT id, title, description, status, priority, due_date, labels, framework_payload, calendar_sync_state, board_id, custom_fields, start_date, end_date, progress, color, is_favorite, task_type, task_kind, project_id, owner, handoff_state, parent_id, ticket_number, assigned_to, kanban_position, created_at, updated_at
       FROM tasks ORDER BY kanban_position ASC NULLS LAST, priority ASC, created_at DESC`,
    );
    return result.rows as TaskRow[];
  }

  /** Comment counts per task (for kanban card badges) */
  async getCommentCounts(): Promise<CommentCounts> {
    const result = await this.client.execute(
      "SELECT task_id, COUNT(*) as cnt FROM comments GROUP BY task_id",
    );
    const counts: CommentCounts = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      counts[String(r.task_id)] = Number(r.cnt);
    }
    return counts;
  }

  /** Kanban lane definitions ordered by position */
  async getKanbanLanes(): Promise<KanbanLane[]> {
    const result = await this.client.execute(
      "SELECT id, key, label, icon, position, wip_limit, includes, built_in FROM kanban_lanes ORDER BY position ASC",
    );
    return result.rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      key: String(r.key),
      label: String(r.label),
      icon: String(r.icon),
      includes: JSON.parse(String(r.includes ?? "[]")),
      builtIn: Number(r.built_in ?? 0) === 1,
      wipLimit: Number(r.wip_limit ?? 0),
    }));
  }

  /** Get settings by keys (e.g. completed_auto_hide_days, backlog_mode) */
  async getSettings(keys: string[]): Promise<Record<string, string>> {
    const placeholders = keys.map(() => "?").join(", ");
    const result = await this.client.execute({
      sql: `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
      args: keys,
    });
    const settings: Record<string, string> = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      settings[String(r.key)] = String(r.value);
    }
    return settings;
  }

  // ── Calendar (calendar.astro) ───────────────────────────────────────

  /** Task counts per day for a given month (non-complete) */
  async getCalendarTaskCounts(
    monthStart: string,
    monthEnd: string,
  ): Promise<Record<string, CalendarDayInfo>> {
    const result = await this.client.execute({
      sql: `SELECT due_date, COUNT(*) as cnt, GROUP_CONCAT(COALESCE(color, ''), ',') as colors
            FROM tasks
            WHERE due_date >= ? AND due_date <= ? AND status NOT IN (?)
            GROUP BY due_date`,
      args: [monthStart, monthEnd, STATUS.COMPLETE],
    });

    const tasksByDay: Record<string, CalendarDayInfo> = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      const dateStr = String(r.due_date);
      tasksByDay[dateStr] = {
        dueDate: dateStr,
        count: Number(r.cnt),
        colors: String(r.colors ?? "")
          .split(",")
          .filter((c) => c.length > 0)
          .slice(0, 3),
        haEvents: 0,
      };
    }
    return tasksByDay;
  }

  /** HA-synced event counts per day for calendar view */
  async getCalendarHAEventCounts(
    monthStart: string,
    monthEnd: string,
  ): Promise<Record<string, number>> {
    const result = await this.client.execute({
      sql: `SELECT due_date, COUNT(*) as cnt
            FROM tasks
            WHERE due_date >= ? AND due_date <= ? AND calendar_sync_state = 'synced'
            GROUP BY due_date`,
      args: [monthStart, monthEnd],
    });
    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      const r = row as Record<string, unknown>;
      counts[String(r.due_date)] = Number(r.cnt);
    }
    return counts;
  }

  // ── Gantt (gantt.astro) ─────────────────────────────────────────────

  /** All tasks with date fields for Gantt chart rendering */
  async getGanttTasks(): Promise<TaskRow[]> {
    const result = await this.client.execute(
      `SELECT id, title, status, priority, due_date, start_date, color, task_type, task_kind, project_id, progress, ticket_number, parent_id
       FROM tasks ORDER BY start_date ASC NULLS LAST, created_at DESC`,
    );
    return result.rows as TaskRow[];
  }

  // ── Today (today.astro) ─────────────────────────────────────────────

  /** Overdue tasks (past due date, non-complete) */
  async getOverdueTasks(todayStr: string): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date IS NOT NULL AND due_date < ?
              AND status NOT IN (?)
            ORDER BY due_date ASC`,
      args: [todayStr, STATUS.COMPLETE],
    });
    return sanitizeRows(result.rows as TaskRow[]);
  }

  /** Tasks due on a specific date (non-complete) */
  async getTasksDueOn(dateStr: string): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date = ? AND status NOT IN (?)
            ORDER BY priority DESC, created_at ASC`,
      args: [dateStr, STATUS.COMPLETE],
    });
    return sanitizeRows(result.rows as TaskRow[]);
  }

  /** Unscheduled tasks (no due date, non-complete) */
  async getUnscheduledTasks(limit = 10): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date IS NULL AND status NOT IN (?)
            ORDER BY priority DESC, created_at DESC
            LIMIT ${limit}`,
      args: [STATUS.COMPLETE],
    });
    return sanitizeRows(result.rows as TaskRow[]);
  }

  /**
   * Suggested tasks — high-priority (p1-p2) tasks due within 3 days,
   * or unscheduled high-priority tasks. Excludes tasks already due today
   * and already shown in overdue section.
   * Used by Smart Today (SMT-01).
   */
  async getSuggestedTasks(todayStr: string, limit = 10): Promise<TaskRow[]> {
    // Calculate end date (3 days from today)
    const endDate = new Date(todayStr)
    endDate.setDate(endDate.getDate() + 3)
    const endStr = endDate.toISOString().split("T")[0]!

    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE status NOT IN (?)
              AND (
                (due_date > ? AND due_date <= ? AND priority <= 2)
                OR (due_date IS NULL AND priority <= 2)
              )
            ORDER BY priority ASC, due_date ASC NULLS LAST
            LIMIT ${limit}`,
      args: [STATUS.COMPLETE, todayStr, endStr],
    });
    return sanitizeRows(result.rows as TaskRow[]);
  }

  /** Count tasks completed today (status=complete AND updated_at today) — SMT-03 */
  async getCompletedTodayCount(todayStr: string): Promise<number> {
    // today timestamps: midnight to midnight (epoch ms)
    const startMs = new Date(todayStr).getTime()
    const endMs = startMs + 86400000
    const result = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM tasks
            WHERE status = ? AND updated_at >= ? AND updated_at < ?`,
      args: [STATUS.COMPLETE, startMs, endMs],
    });
    return Number((result.rows[0] as Record<string, unknown>)?.cnt ?? 0);
  }

  // ── Upcoming (upcoming.astro) ───────────────────────────────────────

  /** Tasks within a date range (non-complete) for upcoming view */
  async getTasksInRange(startDate: string, endDate: string): Promise<TaskRow[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM tasks
            WHERE due_date >= ? AND due_date <= ?
              AND status NOT IN (?)
            ORDER BY due_date ASC, priority DESC, created_at ASC`,
      args: [startDate, endDate, STATUS.COMPLETE],
    });
    return sanitizeRows(result.rows as TaskRow[]);
  }

  // ── Write Methods (API routes) ────────────────────────────────────────

  /**
   * Resolve a task identifier to its UUID.
   * Accepts UUID or MTH-N ticket key format.
   */
  async resolveTaskId(idOrKey: string): Promise<{ id: string; updated_at: unknown } | null> {
    let parsedTicketNum: number | null = null;
    if (idOrKey.toUpperCase().startsWith("MTH-")) {
      parsedTicketNum = parseInt(idOrKey.slice(4), 10);
    }
    const result = await this.client.execute({
      sql: "SELECT id, updated_at FROM tasks WHERE id = ? OR ticket_number = ? LIMIT 1",
      args: [idOrKey, parsedTicketNum],
    });
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as Record<string, unknown>;
    return { id: String(row.id), updated_at: row.updated_at };
  }

  /** Retrieve a single task by ID/ticket key, with parent info JOINed */
  async findById(idOrKey: string): Promise<TaskRow | null> {
    let parsedTicketNum: number | null = null;
    if (idOrKey.toUpperCase().startsWith("MTH-")) {
      parsedTicketNum = parseInt(idOrKey.slice(4), 10);
    }
    const result = await this.client.execute({
      sql: `SELECT t.id, t.title, t.description, t.status, t.priority, t.due_date, t.labels,
                   t.framework_payload, t.calendar_sync_state, t.board_id, t.custom_fields,
                   t.parent_id, t.time_tracked, t.start_date, t.end_date, t.progress, t.color,
                   t.is_favorite, t.task_type, t.task_kind, t.project_id, t.owner, t.handoff_state,
                   t.ticket_number, t.assigned_to, t.checklists,
                   t.recurrence_rule, t.created_at, t.updated_at,
                   p.title as parent_title, p.task_type as parent_task_type, p.ticket_number as parent_ticket_number
            FROM tasks t
            LEFT JOIN tasks p ON t.parent_id = p.id
            WHERE t.id = ? OR t.ticket_number = ? LIMIT 1`,
      args: [idOrKey, parsedTicketNum],
    });
    return (result.rows[0] as TaskRow) ?? null;
  }

  /**
   * Export all tasks with explicit column list.
   * Used by export/tasks.json.ts and export/tasks.csv.ts.
   * Column list is explicit to avoid leaking internal schema changes.
   */
  async exportAll(): Promise<TaskRow[]> {
    const result = await this.client.execute(
      `SELECT id, title, description, status, priority, due_date, labels,
              framework_payload, calendar_sync_state, board_id, custom_fields,
              parent_id, time_tracked, start_date, end_date, progress, color,
              is_favorite, task_type, task_kind, project_id, owner, handoff_state,
              ticket_number, recurrence_rule,
              checklists, reminder_at, created_at, updated_at
       FROM tasks ORDER BY updated_at DESC`
    );
    return result.rows as TaskRow[];
  }

  /** List tasks with optional filters, pagination, and sorting. */
  async findAll(opts: {
    status?: string;
    priority?: number;
    boardId?: string;
    taskType?: string;
    parentId?: string;
    search?: string;
    assignedTo?: string;
    label?: string;
    favorite?: boolean;
    sort?: string;
    order?: "ASC" | "DESC";
    limit?: number;
    offset?: number;
  }): Promise<{ tasks: TaskRow[]; total: number }> {
    const validSorts = ["created_at", "updated_at", "title", "status", "priority", "due_date"];
    const sortCol = validSorts.includes(opts.sort ?? "") ? opts.sort! : "created_at";
    const order = opts.order ?? "DESC";
    const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
    const offset = Math.max(0, opts.offset ?? 0);

    const conditions: string[] = [];
    const args: InValue[] = [];

    if (opts.status) { conditions.push("status = ?"); args.push(normalizeStatus(opts.status)); }
    if (opts.priority != null) { conditions.push("priority = ?"); args.push(opts.priority); }
    if (opts.boardId) { conditions.push("board_id = ?"); args.push(opts.boardId); }
    if (opts.taskType) { conditions.push("task_type = ?"); args.push(opts.taskType); }
    if (opts.parentId) { conditions.push("parent_id = ?"); args.push(opts.parentId); }
    if (opts.search) { conditions.push("(title LIKE ? OR description LIKE ?)"); args.push(`%${opts.search}%`, `%${opts.search}%`); }
    if (opts.assignedTo) { conditions.push("assigned_to = ?"); args.push(opts.assignedTo); }
    if (opts.label) { conditions.push("EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE json_each.value = ?)"); args.push(opts.label); }
    if (opts.favorite) { conditions.push("is_favorite = 1"); }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    const selectSql = `SELECT id, title, description, status, priority, due_date, labels,
                              framework_payload, calendar_sync_state, parent_id, time_tracked,
                              board_id, custom_fields, start_date, end_date, progress, color,
                              is_favorite, task_type, task_kind, project_id, owner, handoff_state,
                              ticket_number, assigned_to, created_at, updated_at
                       FROM tasks${where}
                       ORDER BY ${sortCol} ${order} LIMIT ${limit} OFFSET ${offset}`;
    const countSql = `SELECT COUNT(*) as cnt FROM tasks${where}`;

    const [result, countResult] = await Promise.all([
      this.client.execute({ sql: selectSql, args }),
      this.client.execute({ sql: countSql, args }),
    ]);

    const total = Number((countResult.rows[0] as Record<string, unknown>)?.cnt ?? 0);
    return { tasks: result.rows as TaskRow[], total };
  }

  /** Advanced catalog search used by the universal search hub and HA search bridges. */
  async searchCatalog(opts: {
    query?: string;
    status?: string;
    priority?: number;
    assignedTo?: string;
    includeCompleted?: boolean;
    includeArchived?: boolean;
    fields?: readonly string[];
    sort?: "relevance" | "updated";
    limit?: number;
  }): Promise<TaskRow[]> {
    const query = (opts.query ?? "").trim().toLowerCase();
    const fields = new Set((opts.fields ?? ["id", "title", "description", "labels", "custom_fields", "comments"]).map((field) => field.toLowerCase()));
    const limit = Math.min(50, Math.max(1, opts.limit ?? 12));
    const rawLimit = Math.min(150, limit * 3);

    const conditions: string[] = [];
    const args: InValue[] = [];

    const excludedStatuses: string[] = [];
    if (opts.includeCompleted !== true) excludedStatuses.push(STATUS.COMPLETE);
    if (opts.includeArchived !== true) excludedStatuses.push("archived");
    if (excludedStatuses.length === 1) {
      conditions.push("tasks.status != ?");
      args.push(excludedStatuses[0]!);
    } else if (excludedStatuses.length > 1) {
      conditions.push(`tasks.status NOT IN (${excludedStatuses.map(() => "?").join(", ")})`);
      args.push(...excludedStatuses);
    }

    if (opts.status) {
      conditions.push("tasks.status = ?");
      args.push(normalizeStatus(opts.status));
    }

    if (opts.priority != null) {
      conditions.push("tasks.priority = ?");
      args.push(opts.priority);
    }

    if (opts.assignedTo) {
      conditions.push("tasks.assigned_to = ?");
      args.push(opts.assignedTo);
    }

    if (query) {
      const fieldClauses: string[] = [];

      if (fields.has("id")) {
        fieldClauses.push("LOWER(tasks.id) LIKE ?");
        fieldClauses.push("LOWER(COALESCE('mth-' || CAST(tasks.ticket_number AS TEXT), '')) LIKE ?");
        fieldClauses.push("CAST(COALESCE(tasks.ticket_number, '') AS TEXT) LIKE ?");
        args.push(`%${query}%`, `%${query}%`, `%${query}%`);
      }
      if (fields.has("title")) {
        fieldClauses.push("LOWER(COALESCE(tasks.title, '')) LIKE ?");
        args.push(`%${query}%`);
      }
      if (fields.has("description")) {
        fieldClauses.push("LOWER(COALESCE(tasks.description, '')) LIKE ?");
        args.push(`%${query}%`);
      }
      if (fields.has("labels")) {
        fieldClauses.push("LOWER(COALESCE(tasks.labels, '')) LIKE ?");
        args.push(`%${query}%`);
      }
      if (fields.has("custom_fields")) {
        fieldClauses.push("LOWER(COALESCE(tasks.custom_fields, '')) LIKE ?");
        args.push(`%${query}%`);
      }
      if (fields.has("comments")) {
        fieldClauses.push("LOWER(COALESCE(comment_index.comment_blob, '')) LIKE ?");
        args.push(`%${query}%`);
      }

      if (fieldClauses.length > 0) {
        conditions.push(`(${fieldClauses.join(" OR ")})`);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderBy = opts.sort === "updated"
      ? "tasks.updated_at DESC, tasks.priority ASC"
      : "tasks.updated_at DESC";

    const result = await this.client.execute({
      sql: `SELECT tasks.id, tasks.ticket_number, tasks.title, tasks.description, tasks.status,
                   tasks.priority, tasks.labels, tasks.custom_fields, tasks.board_id, tasks.task_type,
                   tasks.assigned_to, tasks.updated_at, tasks.created_at, tasks.due_date,
                   comment_index.comment_blob
            FROM tasks
            LEFT JOIN (
              SELECT task_id, GROUP_CONCAT(content, ' || ') AS comment_blob
              FROM comments
              GROUP BY task_id
            ) AS comment_index
              ON comment_index.task_id = tasks.id
            ${where}
            ORDER BY ${orderBy}
            LIMIT ${rawLimit}`,
      args,
    });

    return result.rows as TaskRow[];
  }

  /** Get the next sequential ticket number for MTH-N key assignment */
  async getNextTicketNumber(): Promise<number> {
    const result = await this.client.execute("SELECT COALESCE(MAX(ticket_number), 0) + 1 AS next_num FROM tasks");
    return Number((result.rows[0] as Record<string, unknown>)?.next_num ?? 1);
  }

  /** Look up the default assignee from app_settings (nullable) */
  async getDefaultAssignee(): Promise<string | null> {
    try {
      const result = await this.client.execute(
        "SELECT value FROM app_settings WHERE key = 'default_assignee' LIMIT 1"
      );
      if (result.rows.length > 0) {
        return String((result.rows[0] as Record<string, unknown>).value);
      }
    } catch { /* ignore — default is optional */ }
    return null;
  }

  /** Look up a parent task's type for nesting validation */
  async getParentTaskType(parentId: string): Promise<string | null> {
    const result = await this.client.execute({
      sql: "SELECT task_type FROM tasks WHERE id = ? LIMIT 1",
      args: [parentId],
    });
    if (result.rows.length === 0) return null;
    return String((result.rows[0] as Record<string, unknown>).task_type ?? "task");
  }

  /**
   * Insert a new task. Caller is responsible for validation and ID generation.
   * @returns The inserted row ID.
   */
  async createTask(data: {
    id: string; title: string; description: string; status: string;
    priority: number; due_date: string | null; labels: string;
    framework_payload: string; parent_id: string | null;
    board_id: string; custom_fields: string; start_date: string | null;
    end_date: string | null; progress: number; color: string | null;
    is_favorite: number; task_type: string; ticket_number: number;
    assigned_to: string | null; checklists?: string | null;
    recurrence_rule?: string | null;
  }): Promise<string> {
    const now = Date.now();
    await this.client.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, due_date, labels,
                               framework_payload, calendar_sync_state, parent_id, time_tracked,
                               board_id, custom_fields, start_date, end_date, progress, color, is_favorite,
                               task_type, ticket_number, assigned_to, checklists, recurrence_rule,
                               idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        data.id, data.title, data.description, data.status, data.priority,
        data.due_date, data.labels, data.framework_payload,
        STATUS.PENDING, data.parent_id, data.board_id, data.custom_fields,
        data.start_date, data.end_date, data.progress, data.color, data.is_favorite,
        data.task_type, data.ticket_number, data.assigned_to,
        data.checklists ?? "[]", data.recurrence_rule ?? null,
        crypto.randomUUID(), crypto.randomUUID(), now, now,
      ] as InValue[],
    });
    return data.id;
  }

  /**
   * Dynamic update: only SET the columns present in `fields`.
   * @returns The full updated row (re-fetched after update).
   */
  async updateTask(id: string, fields: Record<string, InValue>): Promise<TaskRow | null> {
    const updates: string[] = [];
    const args: InValue[] = [];
    const now = Date.now();

    for (const [col, val] of Object.entries(fields)) {
      updates.push(`${col} = ?`);
      args.push(val);
    }
    if (updates.length === 0) return null;

    updates.push("updated_at = ?");
    args.push(now);
    args.push(id);

    await this.client.execute({
      sql: `UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`,
      args,
    });

    // Re-fetch the updated row
    const result = await this.client.execute({
      sql: `SELECT id, title, description, status, priority, due_date, labels,
                   framework_payload, calendar_sync_state, board_id, custom_fields,
                   parent_id, time_tracked, start_date, end_date, progress, color,
                   is_favorite, task_type, task_kind, project_id, owner, handoff_state,
                   ticket_number, assigned_to, checklists, created_at, updated_at
            FROM tasks WHERE id = ? LIMIT 1`,
      args: [id],
    });
    return (result.rows[0] as TaskRow) ?? null;
  }

  /** Fetch old field values for activity log diffing before an update */
  async getFieldsForDiff(id: string): Promise<TaskRow | null> {
    const result = await this.client.execute({
      sql: `SELECT title, description, status, priority, due_date, labels,
                   framework_payload, board_id, custom_fields, parent_id,
                   task_type, task_kind, project_id, owner, handoff_state,
                   start_date, end_date, progress, color, is_favorite, assigned_to
            FROM tasks WHERE id = ? LIMIT 1`,
      args: [id],
    });
    return (result.rows[0] as TaskRow) ?? null;
  }

  /** Log field-level activity changes (fire-and-forget) */
  async logActivity(
    taskId: string,
    changes: Array<{ field: string; oldValue: string | null; newValue: string }>,
  ): Promise<void> {
    const now = Date.now();
    const inserts = changes.map(({ field, oldValue, newValue }) =>
      this.client.execute({
        sql: `INSERT INTO task_activity_log (task_id, field, old_value, new_value, actor, created_at)
              VALUES (?, ?, ?, ?, 'user', ?)`,
        args: [taskId, field, oldValue, newValue, now] as InValue[],
      })
    );
    await Promise.all(inserts).catch(() => { });
  }

  /** Delete a single task and cascade-clean related data */
  async deleteTask(id: string): Promise<void> {
    await this.client.execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
    // Orphan link cleanup
    try {
      await this.client.execute({
        sql: "DELETE FROM task_links WHERE source_task_id = ? OR target_task_id = ?",
        args: [id, id],
      });
    } catch { /* task_links table may not exist yet */ }
  }

  /** Purge ALL tasks (cascade: activity log, comments, tasks) */
  async purgeAll(): Promise<void> {
    await this.client.execute("DELETE FROM task_activity_log");
    await this.client.execute("DELETE FROM comments");
    await this.client.execute("DELETE FROM tasks");
  }

  /** Fetch recurrence data for cloning (used by auto-create on completion) */
  async getRecurrenceData(id: string): Promise<TaskRow | null> {
    const result = await this.client.execute({
      sql: `SELECT recurrence_rule, recurrence_anchor, due_date, title, description, priority, labels,
                   board_id, parent_id, task_type, assigned_to, checklists, custom_fields
            FROM tasks WHERE id = ? LIMIT 1`,
      args: [id],
    });
    return (result.rows[0] as TaskRow) ?? null;
  }

  /**
   * Clone a task for recurrence — creates next occurrence with new due date.
   * Resets checklists (all items unchecked) and status to pending.
   */
  async cloneForRecurrence(
    sourceTask: TaskRow,
    nextDueDate: string,
    recurrenceRule: string,
  ): Promise<{ id: string; ticketNumber: number }> {
    const newId = crypto.randomUUID();
    const ticketNumber = await this.getNextTicketNumber();
    const now = Date.now();

    // Reset checklists — uncheck all items for new occurrence
    let freshChecklists: string | null = null;
    if (sourceTask.checklists && typeof sourceTask.checklists === "string") {
      try {
        const items = JSON.parse(String(sourceTask.checklists));
        if (Array.isArray(items)) {
          freshChecklists = JSON.stringify(items.map((i: { text: string }) => ({ text: i.text, done: false })));
        }
      } catch { /* keep null */ }
    }

     await this.client.execute({
      sql: `INSERT INTO tasks (id, title, description, status, priority, due_date, labels,
                               recurrence_rule, recurrence_anchor, board_id, parent_id, task_type, assigned_to,
                               checklists, custom_fields, ticket_number,
                               idempotency_key, request_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId,
        sourceTask.title ? String(sourceTask.title) : "Recurring task",
        sourceTask.description ? String(sourceTask.description) : null,
        STATUS.PENDING,
        sourceTask.priority != null ? Number(sourceTask.priority) : 3,
        nextDueDate,
        sourceTask.labels ? String(sourceTask.labels) : "[]",
        recurrenceRule,
        sourceTask.recurrence_anchor ? String(sourceTask.recurrence_anchor) : "due_date",
        sourceTask.board_id ? String(sourceTask.board_id) : "default",
        sourceTask.parent_id ? String(sourceTask.parent_id) : null,
        sourceTask.task_type ? String(sourceTask.task_type) : "task",
        sourceTask.assigned_to ? String(sourceTask.assigned_to) : null,
        freshChecklists,
        sourceTask.custom_fields ? String(sourceTask.custom_fields) : "{}",
        ticketNumber,
        crypto.randomUUID(), crypto.randomUUID(), now, now,
      ] as InValue[],
    });

    return { id: newId, ticketNumber };
  }

  /** Count open tasks (non-complete) — used for iOS badge count */
  async getOpenTaskCount(): Promise<number> {
    try {
      const result = await this.client.execute({
        sql: `SELECT COUNT(*) as cnt FROM tasks WHERE status NOT IN (?)`,
        args: [STATUS.COMPLETE],
      });
      return Number((result.rows[0] as Record<string, unknown>).cnt) || 0;
    } catch { return 0; }
  }

  /**
   * Get immediate child task IDs for cascade completion.
   * Only returns non-complete children.
   */
  async getChildrenIds(parentId: string): Promise<string[]> {
    const result = await this.client.execute({
      sql: `SELECT id FROM tasks WHERE parent_id = ? AND status != ?`,
      args: [parentId, STATUS.COMPLETE],
    });
    return result.rows.map((r) => String((r as Record<string, unknown>).id));
  }

  /**
   * Cascade complete — set all non-complete children to complete.
   * Returns the count of tasks updated.
   */
  async cascadeComplete(parentId: string): Promise<number> {
    const now = Date.now()
    const result = await this.client.execute({
      sql: `UPDATE tasks SET status = ?, updated_at = ? WHERE parent_id = ? AND status != ?`,
      args: [STATUS.COMPLETE, now, parentId, STATUS.COMPLETE],
    });
    return result.rowsAffected;
  }

  /** Batch update kanban positions */
  async reorderTasks(updates: Array<{ id: string; position: number }>): Promise<void> {
    const stmts = updates.map(u => ({
      sql: "UPDATE tasks SET kanban_position = ?, updated_at = ? WHERE id = ?",
      args: [u.position, Date.now(), u.id] as InValue[],
    }));
    await this.client.batch(stmts);
  }

  /** Look up custom user display name by ID */
  async getCustomUserName(userId: string): Promise<string | null> {
    try {
      const result = await this.client.execute({
        sql: "SELECT name FROM custom_users WHERE id = ? LIMIT 1",
        args: [userId],
      });
      if (result.rows.length > 0) return String((result.rows[0] as Record<string, unknown>).name);
    } catch { /* table may not exist */ }
    return null;
  }

  /** Fetch notification preferences from settings table */
  async getNotificationPreferences(): Promise<{
    enabled: boolean;
    disabledUsers: Set<string>;
    channels: { sidebar: boolean; mobile_push: boolean };
    mobileTargets: string[];
  }> {
    const defaults = {
      enabled: true,
      disabledUsers: new Set<string>(),
      channels: { sidebar: true, mobile_push: false },
      mobileTargets: [] as string[],
    };
    try {
      const result = await this.client.execute({
        sql: "SELECT value FROM settings WHERE key = 'notification_preferences' LIMIT 1",
        args: [],
      });
      if (result.rows.length > 0) {
        const raw = JSON.parse(String((result.rows[0] as Record<string, unknown>).value));
        if (typeof raw === "object" && raw !== null) {
          defaults.enabled = raw.enabled !== false;
          if (Array.isArray(raw.disabled_users)) defaults.disabledUsers = new Set(raw.disabled_users);
          if (raw.channels) defaults.channels = raw.channels;
          if (Array.isArray(raw.mobile_targets)) defaults.mobileTargets = raw.mobile_targets;
        }
      }
    } catch { /* settings not available */ }
    return defaults;
  }

  // ── Comment Methods ─────────────────────────────────────────────────

  /** List comments for a task, ordered by creation time ascending */
  async getComments(taskId: string) {
    const result = await this.client.execute({
      sql: "SELECT id, task_id, content, author, created_at FROM comments WHERE task_id = ? ORDER BY created_at ASC",
      args: [taskId] as InValue[],
    });
    return result.rows;
  }

  /** Check if a task exists (lightweight) */
  async taskExists(taskId: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM tasks WHERE id = ? LIMIT 1",
      args: [taskId] as InValue[],
    });
    return result.rows.length > 0;
  }

  /** Insert a new comment and return both the insert result and the latest comment */
  async addComment(taskId: string, content: string, author: string) {
    await this.client.execute({
      sql: "INSERT INTO comments (task_id, content, author) VALUES (?, ?, ?)",
      args: [taskId, content, author] as InValue[],
    });
    const latest = await this.client.execute({
      sql: "SELECT id, task_id, content, author, created_at FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1",
      args: [taskId] as InValue[],
    });
    return latest.rows[0];
  }

  // ── Activity Log Methods ────────────────────────────────────────────

  /** Fetch paginated activity log for a task */
  async getActivityLog(taskId: string, limit: number, offset: number) {
    const result = await this.client.execute({
      sql: `SELECT id, task_id, field, old_value, new_value, actor, created_at
            FROM task_activity_log
            WHERE task_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?`,
      args: [taskId, limit, offset],
    });
    return result.rows;
  }

  // ── Task Link Methods ──────────────────────────────────────────────

  /** Get outbound links (this task → other tasks) with target info */
  async getOutboundLinks(taskId: string) {
    const result = await this.client.execute({
      sql: `SELECT tl.id, tl.source_task_id, tl.target_task_id, tl.link_type, tl.created_at,
                   t.title AS target_title, t.task_type AS target_task_type, t.ticket_number AS target_ticket_number
            FROM task_links tl
            JOIN tasks t ON t.id = tl.target_task_id
            WHERE tl.source_task_id = ?
            ORDER BY tl.created_at DESC`,
      args: [taskId],
    });
    return result.rows;
  }

  /** Get inbound links (other tasks → this task) with source info */
  async getInboundLinks(taskId: string) {
    const result = await this.client.execute({
      sql: `SELECT tl.id, tl.source_task_id, tl.target_task_id, tl.link_type, tl.created_at,
                   t.title AS source_title, t.task_type AS source_task_type, t.ticket_number AS source_ticket_number
            FROM task_links tl
            JOIN tasks t ON t.id = tl.source_task_id
            WHERE tl.target_task_id = ?
            ORDER BY tl.created_at DESC`,
      args: [taskId],
    });
    return result.rows;
  }

  /** Check if a specific link already exists (idempotency) */
  async linkExists(sourceTaskId: string, targetTaskId: string, linkType: string): Promise<boolean> {
    const result = await this.client.execute({
      sql: "SELECT id FROM task_links WHERE source_task_id = ? AND target_task_id = ? AND link_type = ?",
      args: [sourceTaskId, targetTaskId, linkType],
    });
    return result.rows.length > 0;
  }

  /** Create a new task link */
  async createLink(id: string, sourceTaskId: string, targetTaskId: string, linkType: string): Promise<string> {
    const now = new Date().toISOString();
    await this.client.execute({
      sql: "INSERT INTO task_links (id, source_task_id, target_task_id, link_type, created_at) VALUES (?, ?, ?, ?, ?)",
      args: [id, sourceTaskId, targetTaskId, linkType, now],
    });
    return now;
  }

  /** Delete a task link (scoped to a specific task for authorization) */
  async deleteLink(linkId: string, taskId: string): Promise<number> {
    const result = await this.client.execute({
      sql: "DELETE FROM task_links WHERE id = ? AND (source_task_id = ? OR target_task_id = ?)",
      args: [linkId, taskId, taskId],
    });
    return result.rowsAffected;
  }
}
